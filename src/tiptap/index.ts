import { ConvexReactClient, useConvex, useQuery, Watch } from "convex/react";
import { Content, createDocument, Editor, Extension } from "@tiptap/core";
import * as collab from "@tiptap/pm/collab";
import { Schema } from "@tiptap/pm/model";
import { Step } from "@tiptap/pm/transform";
import { useMemo, useState } from "react";
import { SyncApi } from "../../src/client";

const log: typeof console.log = console.debug;

export function useSync(
  id: string,
  opts: {
    syncApi: SyncApi;
    schema: Schema;
  }
) {
  const convex = useConvex();
  const initial = useInitialState(opts.syncApi, opts.schema, id);
  const extension = useMemo(() => {
    if (initial.loading || !initial.content) return null;
    return sync(convex, id, {
      syncApi: opts.syncApi,
      initialVersion: initial.version,
      clientId: initial.clientId,
      restoredSteps: initial.steps,
    });
    // // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, id, initial.loading, initial.content]);
  if (initial.loading) {
    return {
      extension: null,
      isLoading: true,
      content: null,
    } as const;
  }
  if (!initial.content) {
    return {
      extension: null,
      isLoading: false,
      content: null,
      create: (content?: Content) =>
        convex.mutation(opts.syncApi.submitSnapshot, {
          id,
          version: 1,
          content: JSON.stringify(
            createDocument(content ?? "", opts.schema).toJSON()
          ),
        }),
    } as const;
  }
  return {
    extension: extension!,
    isLoading: false,
    content: initial.content,
  } as const;
}

export function sync(
  convex: ConvexReactClient,
  id: string,
  opts: {
    syncApi: SyncApi;
    initialVersion: number;
    clientId: string | number;
    restoredSteps?: Step[];
  }
) {
  let active: boolean = false;
  let pending:
    | { resolve: () => void; reject: () => void; promise: Promise<void> }
    | undefined;
  let watch: Watch<number | null> | undefined;

  async function trySync(editor: Editor) {
    const serverVersion = watch?.localQueryResult();
    if (serverVersion === undefined) {
      return;
    }
    if (serverVersion === null) {
      // TODO: Handle deletion gracefully
      throw new Error("Syncing a document that doesn't exist server-side");
    }
    if (active) {
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
      const version = collab.getVersion(editor.state);
      if (serverVersion > version) {
        log("Updating to server version", {
          id,
          version,
          serverVersion,
        });
        const steps = await convex.query(opts.syncApi.getSteps, {
          id,
          version,
        });
        receiveSteps(
          editor,
          steps.steps.map((step) =>
            Step.fromJSON(editor.schema, JSON.parse(step))
          ),
          steps.clientIds
        );
      }
      while (true) {
        const sendable = collab.sendableSteps(editor.state);
        if (!sendable) {
          break;
        }
        const steps = sendable.steps.map((step) =>
          JSON.stringify(step.toJSON())
        );
        log("Sending steps", { steps, version: sendable.version });
        const result = await convex.mutation(opts.syncApi.submitSteps, {
          id,
          steps,
          version: sendable.version,
          clientId: opts.clientId,
        });
        if (result.status === "synced") {
          // We replay the steps locally to avoid refetching them.
          receiveSteps(
            editor,
            steps.map((step) => Step.fromJSON(editor.schema, JSON.parse(step))),
            steps.map(() => opts.clientId)
          );
          log("Synced", {
            steps,
            version,
            newVersion: collab.getVersion(editor.state),
          });
          break;
        }
        if (result.status === "needs-rebase") {
          receiveSteps(
            editor,
            result.steps.map((step) =>
              Step.fromJSON(editor.schema, JSON.parse(step))
            ),
            result.clientIds
          );
          log("Rebased", {
            steps,
            newVersion: collab.getVersion(editor.state),
          });
        }
      }
    } finally {
      active = false;
      if (pending) {
        const { resolve, reject } = pending;
        pending = undefined;
        trySync(editor).then(resolve, reject);
      }
    }
  }
  function receiveSteps(
    editor: Editor,
    steps: Step[],
    clientIds: (string | number)[]
  ) {
    editor.view.dispatch(
      collab.receiveTransaction(editor.state, steps, clientIds, {
        mapSelectionBackward: true,
      })
    );
  }

  let unsubscribe: (() => void) | undefined;

  return Extension.create({
    name: "convex-sync",
    onDestroy() {
      log("destroying");
      unsubscribe?.();
    },
    onCreate() {
      if (opts.restoredSteps?.length) {
        log("Restored steps", opts.restoredSteps);
        // TODO: verify that restoring steps works
        for (const step of opts.restoredSteps) {
          this.editor.state.tr.step(step);
        }
      }
      watch = convex.watchQuery(opts.syncApi.getVersion, { id });
      unsubscribe = watch.onUpdate(() => {
        void trySync(this.editor);
      });
      void trySync(this.editor);
    },
    onUpdate() {
      void trySync(this.editor);
    },
    addProseMirrorPlugins() {
      log("Adding collab plugin", {
        clientID: opts.clientId,
        version: opts.initialVersion,
      });
      return [
        collab.collab({
          clientID: opts.clientId,
          version: opts.initialVersion,
        }),
      ];
    },
  });
}

export function useInitialState(
  syncApi: SyncApi,
  schema: Schema,
  id: string,
  cacheKeyPrefix?: string
) {
  const [initial, setInitial] = useState(() =>
    getCachedState(schema, id, cacheKeyPrefix)
  );
  const serverInitial = useQuery(
    syncApi.get,
    initial ? "skip" : { id, ignoreSteps: true }
  );
  if (initial) {
    return {
      loading: false,
      ...initial,
    };
  }
  if (serverInitial && serverInitial.content === null) {
    // We couldn't find it locally or on the server.
    // We could dynamically create a new document here,
    // not sure if that's generally the right pattern (vs. explicit creation).
    return {
      loading: false,
      content: null,
    };
  }
  if (serverInitial && serverInitial.content !== null) {
    // TODO: Handle steps gracefully
    // const snapshot = schema.nodeFromJSON(JSON.parse(serverInitial.content));
    // const steps = serverInitial.steps.map((step) =>
    //   Step.fromJSON(schema, JSON.parse(step))
    // );
    // const node = steps.reduce<Node>((node, step) => {
    //   const result = step.apply(node);
    //   if (!result.doc) {
    //     throw new Error(
    //       result.failed ?? `Failed to apply step: ${JSON.stringify(step)}`
    //     );
    //   }
    //   return result.doc;
    // }, snapshot);
    setInitial({
      // content: node.toJSON(),
      content: JSON.parse(serverInitial.content) as Content,
      version: serverInitial.version,
      steps: [],
      clientId: crypto.randomUUID(),
    });
  }
  return {
    loading: true,
  };
}

function getCachedState(schema: Schema, id: string, cacheKeyPrefix?: string) {
  // TODO: Verify that this works
  const cacheKey = `${cacheKeyPrefix ?? "convex-sync"}-${id}`;
  const cache = sessionStorage.getItem(cacheKey);
  if (cache) {
    const { content, version, steps, clientId } = JSON.parse(cache);
    return {
      content: JSON.parse(content) as Content,
      // The server-persisted version of the content
      version: Number(version),
      // The user's local unconfirmedsteps
      steps:
        steps?.map((step: string) => Step.fromJSON(schema, JSON.parse(step))) ??
        [],
      clientId: clientId as string | number,
    };
  }
}
