import {
  type ConvexReactClient,
  useConvex,
  useMutation,
  useQuery,
  type Watch,
} from "convex/react";
import {
  type AnyExtension,
  type Content,
  type Editor,
  Extension,
  type JSONContent,
} from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { Step } from "@tiptap/pm/transform";
import { useCallback, useMemo, useRef } from "react";
import type { SyncApi } from "../client/index.js";

// How many steps we will attempt to sync in one request.
const MAX_STEPS_SYNC = 1000;
const SNAPSHOT_DEBOUNCE_MS = 1000;
// How many consecutive rebase rounds flushPendingSteps tolerates before
// giving up (successful submissions don't count — they always make progress).
const MAX_FLUSH_REBASES = 20;

export type UseSyncOptions = {
  /**
   * Called when syncing fails. Strongly recommended: some sync work happens
   * with no caller to propagate to (the debounced snapshot submit, and the
   * flush of unconfirmed steps when the editor is destroyed), so without this
   * handler those failures surface as unhandled promise rejections.
   *
   * Errors are informational — the extension keeps syncing and will retry on
   * the next local change or server update. The one error that indicates data
   * loss is "Unsynced steps could not be flushed after destroy": local steps
   * that never reached the server before the editor went away.
   */
  onSyncError?: (error: Error) => void;
  snapshotDebounceMs?: number;
  debug?: boolean;
  /**
   * Whether to show a browser warning when closing the tab with unsynced
   * changes. This prevents accidental data loss when the user has local
   * edits that haven't been sent to the server yet.
   * @default true
   */
  warnOnUnsyncedClose?: boolean;
};

export function useTiptapSync(
  syncApi: SyncApi,
  id: string,
  opts?: UseSyncOptions,
) {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  const convex = useConvex();
  const initial = useInitialState(syncApi, id);
  const extension: AnyExtension | null = useMemo(() => {
    const { loading, ...initialState } = initial;
    if (loading || !initialState.initialContent) return null;
    return syncExtension(convex, id, syncApi, initialState, opts);
    // // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, id, initial.loading, initial.initialContent]);
  const submitSnapshot = useMutation(
    syncApi.submitSnapshot,
  ).withOptimisticUpdate((localQueryStore, args) => {
    // This update will allow the useInitialState to respond immediately to
    // creating documents, as if it came from the server.
    const existing = localQueryStore.getQuery(syncApi.getSnapshot, { id });
    if (!existing?.content) {
      localQueryStore.setQuery(
        syncApi.getSnapshot,
        { id },
        {
          version: args.version,
          content: args.content,
        },
      );
    }
    const version = localQueryStore.getQuery(syncApi.latestVersion, { id });
    if (version === null) {
      localQueryStore.setQuery(syncApi.latestVersion, { id }, args.version);
    }
  });
  const create = useCallback(
    async (content: JSONContent) => {
      log("Creating new document", { id });
      await submitSnapshot({
        id,
        version: 1,
        content: JSON.stringify(content),
      });
    },
    [convex, id],
  );
  if (initial.loading) {
    return {
      extension: null,
      isLoading: true,
      initialContent: null,
      /**
       * Create the document without waiting to hear from the server.
       * Warning: Only call this if you just created the document id.
       * It's safer to wait until loading is false.
       * It's also best practice to pass in the same initial content everywhere,
       * so if two clients create the same document id, they'll both end up
       * with the same initial content. Otherwise the second client will
       * throw an exception on the snapshot creation.
       */
      create,
    } as const;
  }
  if (!initial.initialContent) {
    return {
      extension: null,
      isLoading: false,
      initialContent: null,
      create,
    } as const;
  }
  return {
    extension: extension!,
    isLoading: false,
    initialContent: initial.initialContent,
  } as const;
}

export function syncExtension(
  convex: ConvexReactClient,
  id: string,
  syncApi: SyncApi,
  initialState: InitialState,
  opts?: UseSyncOptions,
): AnyExtension {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  // Errors from fire-and-forget paths (the debounced snapshot submit, the
  // destroy-time flush) have no caller to propagate to. Route them to
  // `onSyncError` when it's provided; otherwise rethrow, matching `trySync`
  // so that a missing handler is loud rather than silently dropping the
  // failure. See the "Handling sync errors" section of the README.
  const reportError = (error: Error) => {
    if (opts?.onSyncError) {
      opts.onSyncError(error);
    } else {
      throw error;
    }
  };
  let snapshotTimer: NodeJS.Timeout | undefined;
  const trySubmitSnapshot = (version: number, content: string) => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void convex
        .mutation(syncApi.submitSnapshot, { id, version, content })
        .catch(reportError);
    }, opts?.snapshotDebounceMs ?? SNAPSHOT_DEBOUNCE_MS);
  };

  let active: boolean = false;
  let pending:
    | { resolve: () => void; reject: () => void; promise: Promise<void> }
    | undefined;
  // Which editors queued behind an active sync — the retry in `finally`
  // must serve every one of them, not whichever editor's closure happened
  // to finish (under React StrictMode two live editors briefly share this
  // extension instance).
  const pendingEditors = new Set<Editor>();

  // Per-editor subscription state. Storing `watch`/`unsubscribe` in shared
  // closure variables breaks under React 18 StrictMode: the double-mount
  // destroys the FIRST editor after the second one was created (TipTap
  // defers destruction by a tick), so the shared `unsubscribe` — already
  // reassigned by the second onCreate — tears down the LIVE editor's
  // subscription and passive step delivery stalls for the whole session.
  const subscriptions = new Map<
    Editor,
    { watch: Watch<number | null>; unsubscribe: () => void }
  >();
  const beforeUnloadHandlers = new Map<
    Editor,
    (e: BeforeUnloadEvent) => void
  >();

  async function trySync(editor: Editor) {
    const serverVersion = subscriptions.get(editor)?.watch.localQueryResult();
    if (serverVersion === undefined) {
      return;
    }
    if (serverVersion && serverVersion > collab.getVersion(editor.state)) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    if (active) {
      pendingEditors.add(editor);
      if (!pending) {
        let resolve = () => {};
        let reject = () => {};
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        pending = { resolve, reject, promise };
      }
      return pending.promise;
    }
    active = true;

    try {
      if (
        await doSync(
          editor,
          convex,
          syncApi,
          id,
          serverVersion,
          initialState,
          opts?.debug,
        )
      ) {
        const version = collab.getVersion(editor.state);
        const content = JSON.stringify(editor.state.doc.toJSON());
        if (collab.sendableSteps(editor.state)) {
          throw new Error("Synced but still have sendable steps");
        }
        trySubmitSnapshot(version, content);
      }
    } catch (error) {
      if (opts?.onSyncError) {
        opts.onSyncError(error as Error);
      } else {
        throw error;
      }
    } finally {
      active = false;
      if (pending) {
        const { resolve, reject } = pending;
        pending = undefined;
        // Retry every still-subscribed editor that queued — the closure's
        // `editor` may be the destroyed StrictMode twin.
        const targets = [...pendingEditors].filter((e) => subscriptions.has(e));
        pendingEditors.clear();
        if (targets.length > 0) {
          Promise.all(targets.map((e) => trySync(e))).then(
            () => resolve(),
            reject,
          );
        } else {
          resolve();
        }
      }
    }
  }

  return Extension.create({
    name: "convex-sync",
    onDestroy() {
      log("destroying");
      const editor = this.editor;
      subscriptions.get(editor)?.unsubscribe();
      subscriptions.delete(editor);
      pendingEditors.delete(editor);
      const beforeUnloadHandler = beforeUnloadHandlers.get(editor);
      if (beforeUnloadHandler) {
        window.removeEventListener?.("beforeunload", beforeUnloadHandler);
        beforeUnloadHandlers.delete(editor);
      }
      // Only clear the debounced snapshot once the LAST editor is gone —
      // under StrictMode the deferred first destroy runs while the second
      // editor is live and may own the pending snapshot.
      if (subscriptions.size === 0 && snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = undefined;
      }
      // Local steps still awaiting confirmation must not die with the view
      // (steps ARE the persistence model; `warnOnUnsyncedClose` only covers
      // tab close, not in-app unmounts). The state object is immutable and
      // outlives the view — 'destroy' fires before the view is torn down,
      // so this read is safe.
      const state = editor.state;
      if (collab.sendableSteps(state)) {
        void flushPendingSteps(convex, syncApi, id, state, opts?.debug).then(
          (outcome) => {
            if (outcome === "gave-up") {
              reportError(
                new Error("Unsynced steps could not be flushed after destroy"),
              );
            }
          },
          // Only the mutation is caught inside flushPendingSteps; a step that
          // fails to apply against the captured state (or a malformed step
          // from the server) rejects here. Without this handler that would be
          // an unhandled rejection at teardown instead of a reported error.
          reportError,
        );
      }
    },
    onCreate() {
      if (initialState.restoredSteps?.length) {
        // TODO: verify that restoring local steps works
        log("Restoring local steps", initialState.restoredSteps);
        const tr = this.editor.state.tr;
        for (const step of initialState.restoredSteps) {
          tr.step(Step.fromJSON(this.editor.schema, step));
        }
        this.editor.view.dispatch(tr);
      }
      const editor = this.editor;
      const watch = convex.watchQuery(syncApi.latestVersion, { id });
      const unsubscribe = watch.onUpdate(() => {
        void trySync(editor);
      });
      subscriptions.set(editor, { watch, unsubscribe });
      void trySync(editor);
      // Install beforeunload handler if not explicitly disabled.
      if (
        opts?.warnOnUnsyncedClose !== false &&
        typeof window !== "undefined" &&
        typeof window.addEventListener === "function"
      ) {
        const beforeUnloadHandler = (e: BeforeUnloadEvent) => {
          if (collab.sendableSteps(editor.state)) {
            e.preventDefault();
            // Required for older browsers.
            e.returnValue = "";
          }
        };
        beforeUnloadHandlers.set(editor, beforeUnloadHandler);
        window.addEventListener("beforeunload", beforeUnloadHandler);
      }
    },
    onUpdate() {
      void trySync(this.editor);
    },
    addProseMirrorPlugins() {
      log("Adding collab plugin", {
        version: initialState.initialVersion,
      });
      return [
        collab.collab({
          version: initialState.initialVersion,
        }),
      ];
    },
  });
}

async function doSync(
  editor: Editor,
  convex: ConvexReactClient,
  syncApi: SyncApi,
  id: string,
  serverVersion: number | null,
  initialState: InitialState,
  debug?: boolean,
) {
  const log: typeof console.log = debug ? console.debug : () => {};
  if (serverVersion === null) {
    if (initialState.initialVersion <= 1) {
      // This is a new document, so we can create it on the server.
      // Note: this should only happen if the initial version is loaded from
      // a local cache. Creating a new document on the client will set the
      // initial version to 1 optimistically.
      log("Syncing new document", { id });
      await convex.mutation(syncApi.submitSnapshot, {
        id,
        version: initialState.initialVersion,
        content: JSON.stringify(initialState.initialContent),
      });
    } else {
      // TODO: Handle deletion gracefully
      throw new Error("Syncing a document that doesn't exist server-side");
    }
  }
  const version = collab.getVersion(editor.state);
  if (serverVersion !== null && serverVersion > version) {
    log("Updating to server version", {
      id,
      version,
      serverVersion,
    });
    const steps = await convex.query(syncApi.getSteps, {
      id,
      version,
    });
    if (editor.isDestroyed) return false;
    // The local version may have advanced while the fetch was in flight
    // (another trySync interleave, or any other applier) — applying the
    // full batch would then re-apply an already-applied prefix, duplicating
    // content and inflating the collab version past the server's. The next
    // submitSteps would insert a delta with a version GAP, permanently
    // wedging the document for every client. Apply only what is still
    // ahead of us.
    const skip = collab.getVersion(editor.state) - version;
    if (skip >= 0 && skip < steps.steps.length) {
      receiveSteps(
        editor,
        steps.steps
          .slice(skip)
          .map((step) => Step.fromJSON(editor.schema, JSON.parse(step))),
        steps.clientIds.slice(skip),
      );
    }
  }
  let anyChanges = false;
  while (true) {
    // A destroy mid-round-trip freezes editor.state (dispatching to a
    // destroyed view is a silent no-op), so the confirm/rebase applies
    // below stop landing and this loop would re-submit the same stale
    // batch forever. onDestroy's flushPendingSteps owns the remaining
    // steps from here. Return false: the frozen state still shows
    // sendable steps, and reporting a successful sync would trip the
    // "Synced but still have sendable steps" invariant in trySync.
    if (editor.isDestroyed) return false;
    const sendable = collab.sendableSteps(editor.state);
    if (!sendable) {
      break;
    }
    const steps = sendable.steps
      .slice(0, MAX_STEPS_SYNC)
      .map((step) => JSON.stringify(step.toJSON()));
    log("Sending steps", { steps, version: sendable.version });
    const result = await convex.mutation(syncApi.submitSteps, {
      id,
      steps,
      version: sendable.version,
      clientId: sendable.clientID,
    });
    if (result.status === "synced") {
      anyChanges = true;
      // We replay the steps locally to avoid refetching them.
      receiveSteps(
        editor,
        steps.map((step) => Step.fromJSON(editor.schema, JSON.parse(step))),
        steps.map(() => sendable.clientID),
      );
      log("Synced", {
        steps,
        version,
        newVersion: collab.getVersion(editor.state),
      });
      continue;
    }
    if (result.status === "needs-rebase") {
      receiveSteps(
        editor,
        result.steps.map((step) =>
          Step.fromJSON(editor.schema, JSON.parse(step)),
        ),
        result.clientIds,
      );
      log("Rebased", {
        steps,
        newVersion: collab.getVersion(editor.state),
      });
    }
  }
  return anyChanges;
}

function receiveSteps(
  editor: Editor,
  steps: Step[],
  clientIds: (string | number)[],
) {
  editor.view.dispatch(
    collab.receiveTransaction(editor.state, steps, clientIds, {
      mapSelectionBackward: true,
    }),
  );
}

/**
 * Submit a destroyed editor's unconfirmed local steps — the doSync send
 * loop run headlessly against the captured EditorState (which is immutable
 * and outlives the view). prosemirror-collab's receiveTransaction does the
 * heavy lifting exactly as it would live: own-clientID steps confirm (the
 * pre-destroy in-flight submit may turn out to have landed them), foreign
 * steps rebase ours. Best-effort: a network/permission failure means the
 * steps are lost — the same outcome as before this existed — but the
 * common case (in-app navigation mid round-trip) now persists.
 *
 * Rejects if a step fails to apply against the captured state; the caller in
 * `onDestroy` routes that to `onSyncError`.
 *
 * @internal Exported for tests. Not part of the supported API.
 */
export async function flushPendingSteps(
  convex: ConvexReactClient,
  syncApi: SyncApi,
  id: string,
  state: EditorState,
  debug?: boolean,
): Promise<"flushed" | "gave-up"> {
  const log: typeof console.log = debug ? console.debug : () => {};
  let rebases = 0;
  while (rebases < MAX_FLUSH_REBASES) {
    const sendable = collab.sendableSteps(state);
    if (!sendable) return "flushed";
    // Confirm only what is actually sent this round — the remainder past
    // MAX_STEPS_SYNC drains on the next iteration.
    const toSend = sendable.steps.slice(0, MAX_STEPS_SYNC);
    let result;
    try {
      result = await convex.mutation(syncApi.submitSteps, {
        id,
        version: sendable.version,
        clientId: sendable.clientID,
        steps: toSend.map((step) => JSON.stringify(step.toJSON())),
      });
    } catch (error) {
      log("Flush after destroy failed", { id, error });
      return "gave-up";
    }
    if (result.status === "synced") {
      state = state.apply(
        collab.receiveTransaction(
          state,
          toSend,
          toSend.map(() => sendable.clientID),
          { mapSelectionBackward: true },
        ),
      );
    } else {
      rebases++;
      state = state.apply(
        collab.receiveTransaction(
          state,
          result.steps.map((step) =>
            Step.fromJSON(state.schema, JSON.parse(step)),
          ),
          result.clientIds,
          { mapSelectionBackward: true },
        ),
      );
    }
  }
  return "gave-up";
}

type InitialState = {
  initialContent: Content;
  initialVersion: number;
  restoredSteps?: object[];
};

export function useInitialState(
  syncApi: SyncApi,
  id: string,
  cacheKeyPrefix?: string,
) {
  const serverRef = useRef<{
    id: string;
    snapshot?: InitialState;
  }>({ id });
  const cachedState = useMemo(() => {
    return getCachedState(id, cacheKeyPrefix);
  }, [id, cacheKeyPrefix]);
  const serverInitial = useQuery(
    syncApi.getSnapshot,
    serverRef.current.snapshot && serverRef.current.id === id ? "skip" : { id },
  );
  const snapshot = useMemo(() => {
    return (
      serverInitial &&
      serverInitial.content !== null && {
        initialContent: JSON.parse(serverInitial.content) as Content,
        initialVersion: serverInitial.version,
      }
    );
  }, [serverInitial]);
  if (snapshot || serverRef.current.id !== id) {
    serverRef.current = { id, snapshot: snapshot || undefined };
  }
  const data = serverRef.current.snapshot || cachedState;

  if (data) {
    return {
      loading: false,
      ...data,
    };
  }
  if (!cachedState && serverInitial?.content === null) {
    // We couldn't find it locally or on the server.
    // We could dynamically create a new document here,
    // not sure if that's generally the right pattern (vs. explicit creation).
    return {
      loading: false,
      initialContent: null,
    };
  }
  return {
    loading: true,
  };
}

function getCachedState(
  id: string,
  cacheKeyPrefix?: string,
): InitialState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // TODO: Verify that this works
  const cacheKey = `${cacheKeyPrefix ?? "convex-sync"}-${id}`;
  const cache = sessionStorage.getItem(cacheKey);
  if (cache) {
    const { content, version, steps } = JSON.parse(cache);
    return {
      initialContent: content as Content,
      initialVersion: Number(version),
      restoredSteps: (steps ?? []) as object[],
    };
  }
}
