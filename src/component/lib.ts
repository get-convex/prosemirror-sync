import { v } from "convex/values";
import {
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { vClientId } from "./schema";
import { api } from "./_generated/api";

const MAX_DELTA_FETCH = 100;
const MAX_SNAPSHOT_FETCH = 10;

export const submitSnapshot = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    content: v.string(),
    pruneSnapshots: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).eq("version", args.version),
      )
      .first();
    if (existing) {
      if (existing.content === args.content) {
        return;
      }
      throw new Error(
        `Snapshot ${args.id} at version ${args.version} already exists ` +
          `with different content: ${existing.content} !== ${args.content}`,
      );
    }
    await ctx.db.insert("snapshots", {
      id: args.id,
      version: args.version,
      content: args.content,
    });
    if (args.version > 1 && args.pruneSnapshots) {
      // Delete all older snapshots, except the original one.
      await deleteSnapshotsHelper(ctx, {
        id: args.id,
        afterVersion: 1,
        beforeVersion: args.version,
      });
    }
  },
});

export const latestVersion = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    const latestDelta = await ctx.db
      .query("deltas")
      .withIndex("id_version", (q) => q.eq("id", args.id))
      .order("desc")
      .first();
    if (latestDelta) {
      return latestDelta.version;
    }
    const latestSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) => q.eq("id", args.id))
      .order("desc")
      .first();
    return latestSnapshot?.version ?? null;
  },
});

export const submitSteps = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    clientId: vClientId,
    steps: v.array(v.string()),
  },
  returns: v.union(
    v.object({
      status: v.literal("needs-rebase"),
      clientIds: v.array(vClientId),
      steps: v.array(v.string()),
    }),
    v.object({ status: v.literal("synced") }),
  ),
  handler: async (ctx, args) => {
    const changes = await ctx.db
      .query("deltas")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).gt("version", args.version),
      )
      .take(MAX_DELTA_FETCH);
    if (changes.length > 0) {
      const [steps, clientIds] = stepsAndClientIds(changes);
      return { status: "needs-rebase", clientIds, steps } as const;
    }
    await ctx.db.insert("deltas", {
      id: args.id,
      version: args.version + args.steps.length,
      clientId: args.clientId,
      steps: args.steps,
    });
    return { status: "synced" } as const;
  },
});

function stepsAndClientIds(deltas: Doc<"deltas">[]) {
  const clientIds = [];
  const steps = [];
  for (const delta of deltas) {
    for (const step of delta.steps) {
      clientIds.push(delta.clientId);
      steps.push(step);
    }
  }
  return [steps, clientIds] as const;
}

export const getSnapshot = query({
  args: { id: v.string(), version: v.optional(v.number()) },
  returns: v.union(
    v.object({
      content: v.null(),
    }),
    v.object({
      content: v.string(),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).lte("version", args.version ?? Infinity),
      )
      .order("desc")
      .first();
    if (!snapshot) {
      return {
        content: null,
      };
    }
    return {
      content: snapshot.content,
      version: snapshot.version,
    };
  },
});

async function fetchSteps(
  ctx: QueryCtx,
  id: string,
  afterVersion: number,
  targetVersion?: number,
) {
  const deltas = await ctx.db
    .query("deltas")
    .withIndex("id_version", (q) =>
      q
        .eq("id", id)
        .gt("version", afterVersion)
        .lte("version", targetVersion ?? Infinity),
    )
    .take(MAX_DELTA_FETCH);
  if (deltas.length > 0) {
    const firstDelta = deltas[0];
    if (firstDelta.version - firstDelta.steps.length > afterVersion) {
      throw new Error(
        `Missing steps ${afterVersion + 1}...${
          firstDelta.version - firstDelta.steps.length
        }`,
      );
    } else if (firstDelta.version - firstDelta.steps.length < afterVersion) {
      firstDelta.steps = firstDelta.steps.slice(
        afterVersion - (firstDelta.version - firstDelta.steps.length),
      );
    }
  }
  const [steps, clientIds] = stepsAndClientIds(deltas);
  if (deltas.length === MAX_DELTA_FETCH) {
    console.warn(
      `Max delta fetch reached: ${id} ${afterVersion}...${
        targetVersion ?? "end"
      } stopped at ${deltas[deltas.length - 1].version}`,
    );
    return [steps, clientIds] as const;
  }
  const lastDelta = deltas[deltas.length - 1];
  if (targetVersion && (!lastDelta || lastDelta.version < targetVersion)) {
    const nextDelta = await ctx.db
      .query("deltas")
      .withIndex("id_version", (q) =>
        q.eq("id", id).gt("version", lastDelta.version),
      )
      .first();
    if (!nextDelta) {
      throw new Error(
        `Missing steps ${lastDelta ? lastDelta.version + 1 : afterVersion}...${targetVersion}`,
      );
    }
    for (let i = 0; i < targetVersion - lastDelta.version; i++) {
      steps.push(nextDelta.steps[i]);
      clientIds.push(nextDelta.clientId);
    }
  }
  if (targetVersion && steps.length !== targetVersion - afterVersion) {
    throw new Error(
      `Steps mismatch ${afterVersion}...${targetVersion}: ${steps.length}`,
    );
  }
  return [steps, clientIds] as const;
}

export const getSteps = query({
  args: { id: v.string(), version: v.number() },
  returns: v.object({
    steps: v.array(v.string()),
    clientIds: v.array(vClientId),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const [steps, clientIds] = await fetchSteps(ctx, args.id, args.version);
    return { steps, clientIds, version: args.version + steps.length };
  },
});

/**
 * Delete snapshots in the given range, not including the bounds.
 * To clean up old snapshots, call this with the current version as the
 * beforeVersion and the first version (1) as the afterVersion.
 */
export const deleteSnapshots = mutation({
  args: {
    id: v.string(),
    afterVersion: v.optional(v.number()),
    beforeVersion: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteSnapshotsHelper(ctx, args);
  },
});

async function deleteSnapshotsHelper(
  ctx: MutationCtx,
  args: { id: string; afterVersion?: number; beforeVersion?: number },
) {
  const versions = await ctx.db
    .query("snapshots")
    .withIndex("id_version", (q) => {
      const eq = q.eq("id", args.id);
      const after =
        args.afterVersion !== undefined
          ? eq.gt("version", args.afterVersion)
          : eq;
      const before =
        args.beforeVersion !== undefined
          ? after.lt("version", args.beforeVersion)
          : after;
      return before;
    })
    .take(MAX_SNAPSHOT_FETCH);
  await Promise.all(versions.map((doc) => ctx.db.delete(doc._id)));
  if (versions.length === MAX_SNAPSHOT_FETCH) {
    await ctx.scheduler.runAfter(0, api.lib.deleteSnapshots, {
      id: args.id,
      beforeVersion: args.beforeVersion,
      afterVersion: versions[versions.length - 1].version,
    });
  }
}

/**
 * Delete steps before some timestamp.
 * To clean up old steps, call this with a date in the past for beforeTs.
 * By default it will ensure that all steps are older than the latest snapshot.
 */
export const deleteSteps = mutation({
  args: {
    id: v.string(),
    afterVersion: v.optional(v.number()),
    beforeTs: v.number(),
    deleteNewerThanLatestSnapshot: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let beforeTs = args.beforeTs;
    if (!args.deleteNewerThanLatestSnapshot) {
      const latestSnapshot = await ctx.db
        .query("snapshots")
        .withIndex("id_version", (q) => q.eq("id", args.id))
        .order("desc")
        .first();
      if (latestSnapshot) {
        beforeTs = Math.min(beforeTs, latestSnapshot._creationTime);
      }
    }
    const deltas = (
      await ctx.db
        .query("deltas")
        .withIndex("id_version", (q) =>
          q.eq("id", args.id).gt("version", args.afterVersion ?? -Infinity),
        )
        .take(MAX_DELTA_FETCH)
    ).filter((doc) => doc._creationTime < beforeTs);
    await Promise.all(deltas.map((doc) => ctx.db.delete(doc._id)));
    if (deltas.length === MAX_DELTA_FETCH) {
      await ctx.scheduler.runAfter(0, api.lib.deleteSteps, {
        id: args.id,
        beforeTs,
        // We already checked that the timestamp is before
        deleteNewerThanLatestSnapshot: true,
      });
    }
  },
});

/**
 * Delete a document and all its snapshots & steps.
 */
export const deleteDocument = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(api.lib.deleteSnapshots, { id: args.id });
    await ctx.scheduler.runAfter(0, api.lib.deleteSteps, {
      id: args.id,
      beforeTs: Infinity,
      deleteNewerThanLatestSnapshot: true,
    });
  },
});
