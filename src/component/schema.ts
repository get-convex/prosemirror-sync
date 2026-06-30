import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vClientId = v.union(v.string(), v.number());

export default defineSchema({
  snapshots: defineTable({
    id: v.string(),
    version: v.number(),
    content: v.string(),
  }).index("id_version", ["id", "version"]),
  deltas: defineTable({
    id: v.string(),
    // The version of the last step.
    version: v.number(),
    clientId: vClientId,
    steps: v.array(v.string()),
    // Optional identifier for the user who authored these steps.
    authorId: v.optional(v.string()),
  }).index("id_version", ["id", "version"]),
});
