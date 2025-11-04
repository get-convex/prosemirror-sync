import {
  type ApiFromModules,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v, type VString } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { vClientId } from "../component/schema.js";
import { Schema, Node } from "@tiptap/pm/model";
import { Step, Transform } from "@tiptap/pm/transform";

export type SyncApi = ApiFromModules<{
  sync: ReturnType<ProsemirrorSync["syncApi"]>;
}>["sync"];

// e.g. `ctx` from a Convex mutation or action.
export type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

export class ProsemirrorSync<Id extends string = string> {
  /**
   * Backend API for the ProsemirrorSync component.
   * Responsible for exposing the `sync` API to the client, and having
   * convenience methods for interacting with the component from the backend.
   *
   * Typically used like:
   *
   * ```ts
   * const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);
   * export const {
   * ... // see {@link syncApi} docstring for details
   * } = prosemirrorSync.syncApi({...});
   * ```
   *
   * @param component - Generally `components.prosemirrorSync` from
   * `./_generated/api` once you've configured it in `convex.config.ts`.
   */
  constructor(public component: ComponentApi) {}
  /**
   * Create a new document with the given ID and content.
   *
   * @param ctx - A Convex mutation context.
   * @param id - The document ID.
   * @param content - The document content. Should be ProseMirror JSON.
   * @returns A promise that resolves when the document is created.
   */
  create(ctx: RunMutationCtx, id: Id, content: object) {
    return ctx.runMutation(this.component.lib.submitSnapshot, {
      id,
      version: 1,
      content: JSON.stringify(content),
    });
  }

  /**
   * Get the latest document version and content.
   *
   * @param ctx - A Convex mutation context.
   * @param id - The document ID.
   * @param schema - Your ProseMirror schema.
   *   For Tiptap, use `getSchema(extensions)`.
   *   For BlockNote, use `editor.pmSchema`.
   * @returns The latest ProseMirror doc (Node) and version.
   */
  async getDoc(ctx: RunMutationCtx, id: Id, schema: Schema) {
    const { transform, version } = await getLatestVersion(
      ctx,
      this.component,
      id,
      schema
    );
    return {
      version,
      doc: transform.doc,
    };
  }

  /**
   * Transform the document by applying the given function to the document.
   *
   * This will keep applying the function until the document is synced,
   * so ensure that the function is idempotent (can be applied multiple times).
   *
   * e.g.
   * ```ts
   * import { getSchema } from "@tiptap/core";
   * import { Transform } from "@tiptap/pm/transform";
   *
   * const schema = getSchema(extensions);
   * await prosemirrorSync.transform(ctx, id, schema, (doc) => {
   *   const tr = new Transform(doc);
   *   tr.insert(0, schema.text("Hello world"));
   *   return tr;
   * });
   * ```
   *
   * @param ctx - A Convex mutation context.
   * @param id - The document ID.
   * @param schema - The document schema.
   * @param fn - A function that takes the document and returns a Transform
   *   or null if no changes are needed.
   * @returns A promise that resolves with the transformed document.
   */
  async transform(
    ctx: RunMutationCtx,
    id: Id,
    schema: Schema,
    fn: (
      node: Node,
      version: number
    ) => Transform | null | Promise<Transform | null>,
    opts?: { clientId?: string }
  ) {
    const { transform: serverVersion, version: initialVersion } =
      await getLatestVersion(ctx, this.component, id, schema);
    let version = initialVersion;
    while (true) {
      const tr = await fn(serverVersion.doc, version);
      if (tr === null) return serverVersion.doc;
      const result = await ctx.runMutation(this.component.lib.submitSteps, {
        id,
        version,
        clientId: opts?.clientId ?? "transform",
        steps: tr.steps.map((step) => JSON.stringify(step.toJSON())),
      });
      if (result.status === "synced") {
        await ctx.runMutation(this.component.lib.submitSnapshot, {
          id,
          version: version + tr.steps.length,
          content: JSON.stringify(tr.doc.toJSON()),
        });
        return tr.doc;
      }
      for (const step of result.steps) {
        serverVersion.step(Step.fromJSON(schema, JSON.parse(step)));
      }
      version += result.steps.length;
    }
  }
  /**
   * Expose the sync API to the client for use with the `useTiptapSync` hook.
   * If you export these in `convex/prosemirror.ts`, pass `api.prosemirror`
   * to the `useTiptapSync` hook.
   *
   * It allows you to define optional read and write permissions, along with
   * a callback when new snapshots are available.
   *
   * You can pass the optional type argument `<DataModel>` to have the `ctx`
   * parameter specific to your tables.
   *
   * ```ts
   * import { DataModel } from "./convex/_generated/dataModel";
   * // ...
   * export const { ... } = prosemirrorSync.syncApi<DataModel>({...});
   * ```
   *
   * To define just one function to use for both, you can define it like this:
   * ```ts
   * async function checkPermissions(ctx: QueryCtx, id: string) {
   *   const user = await getAuthUser(ctx);
   *   if (!user || !(await canUserAccessDocument(user, id))) {
   *     throw new Error("Unauthorized");
   *   }
   * }
   * ```
   * @param opts - Optional callbacks.
   * @returns functions to export, so the `useTiptapSync` hook can use them.
   */
  syncApi<DataModel extends GenericDataModel>(opts?: {
    /**
     * Optional callback to check read permissions.
     * Throw an error if the user is not authorized to read the document.
     * @param ctx - A Convex query context.
     * @param id - The document ID.
     */
    checkRead?: (
      ctx: GenericQueryCtx<DataModel>,
      id: Id
    ) => void | Promise<void>;
    /**
     * Optional callback to check write permissions.
     * Throw an error if the user is not authorized to write to the document.
     * @param ctx - A Convex mutation context.
     * @param id - The document ID.
     */
    checkWrite?: (
      ctx: GenericMutationCtx<DataModel>,
      id: Id
    ) => void | Promise<void>;
    /**
     * Optional callback to run when a new snapshot is available.
     * Version 1 is the initial content.
     * @param ctx - A Convex mutation context.
     * @param id - The document ID.
     * @param snapshot - The snapshot content, as stringified ProseMirror JSON.
     * @param version - The version this snapshot represents.
     */
    onSnapshot?: (
      ctx: GenericMutationCtx<DataModel>,
      id: Id,
      snapshot: string,
      version: number
    ) => void | Promise<void>;
    /**
     * Whether to prune old snapshots.
     * If set to true, only the original and newest snapshots are kept.
     * @default true
     */
    pruneSnapshots?: boolean;
  }) {
    const id = v.string() as VString<Id>;
    return {
      getSnapshot: queryGeneric({
        args: {
          id,
          version: v.optional(v.number()),
        },
        returns: v.union(
          v.object({
            content: v.null(),
          }),
          v.object({
            content: v.string(),
            version: v.number(),
          })
        ),
        handler: async (ctx, args) => {
          if (opts?.checkRead) {
            await opts.checkRead(ctx, args.id);
          }
          return ctx.runQuery(this.component.lib.getSnapshot, args);
        },
      }),
      submitSnapshot: mutationGeneric({
        args: {
          id,
          version: v.number(),
          content: v.string(),
        },
        returns: v.null(),
        handler: async (ctx, args) => {
          if (opts?.checkWrite) {
            await opts.checkWrite(ctx, args.id);
          }
          if (opts?.onSnapshot) {
            await opts.onSnapshot(ctx, args.id, args.content, args.version);
          }
          await ctx.runMutation(this.component.lib.submitSnapshot, {
            ...args,
            pruneSnapshots: opts?.pruneSnapshots,
          });
        },
      }),
      latestVersion: queryGeneric({
        args: { id },
        returns: v.union(v.null(), v.number()),
        handler: async (ctx, args) => {
          if (opts?.checkRead) {
            await opts.checkRead(ctx, args.id);
          }
          return ctx.runQuery(this.component.lib.latestVersion, args);
        },
      }),
      getSteps: queryGeneric({
        args: {
          id,
          version: v.number(),
        },
        handler: async (ctx, args) => {
          if (opts?.checkRead) {
            await opts.checkRead(ctx, args.id);
          }
          return ctx.runQuery(this.component.lib.getSteps, args);
        },
      }),
      submitSteps: mutationGeneric({
        args: {
          id,
          version: v.number(),
          clientId: vClientId,
          steps: v.array(v.string()),
        },
        handler: async (ctx, args) => {
          if (opts?.checkWrite) {
            await opts.checkWrite(ctx, args.id);
          }
          return ctx.runMutation(this.component.lib.submitSteps, args);
        },
      }),
    };
  }
}

async function getLatestVersion(
  ctx: RunMutationCtx,
  component: ComponentApi,
  id: string,
  schema: Schema
) {
  const snapshot = await ctx.runQuery(component.lib.getSnapshot, { id });
  if (!snapshot.content) {
    throw new Error("Document not found");
  }
  const content = JSON.parse(snapshot.content);
  const transform = new Transform(schema.nodeFromJSON(content));
  const { steps, version } = await ctx.runQuery(component.lib.getSteps, {
    id,
    version: snapshot.version,
  });
  for (const step of steps) {
    transform.step(Step.fromJSON(schema, JSON.parse(step)));
  }
  return { transform, version };
}
