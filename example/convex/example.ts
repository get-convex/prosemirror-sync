/* eslint-disable @typescript-eslint/no-unused-vars */
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import { getSchema } from "@tiptap/core";
import { Transform, Step } from "@tiptap/pm/transform";
import { EditorState } from "@tiptap/pm/state";
import { extensions } from "../src/extensions";
import { Schema } from "@tiptap/pm/model";
import { BlockNoteEditor } from "@blocknote/core";

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);
export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi({
  checkRead(ctx, id) {
    // const user = await userFromAuth(ctx);
    // ...validate that the user can read this document
  },
  checkWrite(ctx, id) {
    // const user = await userFromAuth(ctx);
    // ...validate that the user can write to this document
  },
  async onSnapshot(ctx, id, snapshot, version) {
    // ...do something with the snapshot, like store a copy in another table,
    // save a text version of the document for text search, or generate
    // embeddings for vector search.
    const snapshotJSON = JSON.parse(snapshot);
    let schema: Schema;
    // A hack for our demo which uses both BlockNote and Tiptap.
    if (id.endsWith("-blocknote")) {
      // Parse the snapshot from BlockNote in the Convex runtime.
      // ServerBlockNoteEditor only works in "use node" in the Convex runtime.
      const editor = BlockNoteEditor.create();
      schema = editor.pmSchema;
    } else {
      // Fetching the content from Tiptap, using your extensions.
      schema = getSchema(extensions);
    }
    const node = schema.nodeFromJSON(snapshotJSON);
    const content = node.textContent;
    await ctx.scheduler.runAfter(0, internal.example.updateDocSearchIndex, {
      id,
      content,
    });
  },
});

async function generateContent(doc: string) {
  return `Overall length: ${doc.length}`;
}

// We keep a text search index on the documents table for easy search.
// But we don't update that full version all the time, for efficiency.
export const updateDocSearchIndex = internalMutation({
  args: { id: v.string(), content: v.string() },
  handler: async (ctx, { id, content }) => {
    const existing = await ctx.db
      .query("documents")
      .withIndex("docId", (q) => q.eq("docId", id))
      .unique();
    if (!existing) {
      await ctx.db.insert("documents", { docId: id, content });
    } else {
      await ctx.db.patch(existing._id, { content });
    }
  },
});

// This is an example of how to modify a document using the transform fn.
export const transformExample = action({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const schema = getSchema(extensions);
    const { doc, version } = await prosemirrorSync.getDoc(ctx, id, schema);
    const newContent = await generateContent(doc.textContent);
    const node = await prosemirrorSync.transform(ctx, id, schema, (doc, v) => {
      if (v !== version) {
        // If we wanted to avoid making changes, we could return null here.
        // Or we could rebase our changes on top of the new document.
      }
      const tr = EditorState.create({ doc }).tr;
      return tr.insertText(newContent, 0);
    });
    await ctx.scheduler.runAfter(0, internal.example.updateDocSearchIndex, {
      id,
      content: node.textContent,
    });
  },
});

// This is an example of how to manually transform the document.
export const manualTransform = mutation({
  args: {
    id: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { id, text }) => {
    const snapshot = await ctx.runQuery(
      components.prosemirrorSync.lib.getSnapshot,
      {
        id,
      },
    );
    if (!snapshot.content) {
      throw new Error("Document not found");
    }
    const content = JSON.parse(snapshot.content);
    const schema = getSchema(extensions);
    const serverVersion = new Transform(schema.nodeFromJSON(content));
    const stepsResult = await ctx.runQuery(
      components.prosemirrorSync.lib.getSteps,
      { id, version: snapshot.version },
    );
    if (stepsResult.steps.length > 0) {
      for (const step of stepsResult.steps) {
        serverVersion.step(Step.fromJSON(schema, JSON.parse(step)));
      }
    }
    let version = stepsResult.version;
    while (true) {
      const tr = new Transform(serverVersion.doc);
      tr.insert(0, schema.text(text));

      const result = await ctx.runMutation(
        components.prosemirrorSync.lib.submitSteps,
        {
          id,
          clientId: "server function",
          version,
          steps: tr.steps.map((step) => JSON.stringify(step.toJSON())),
        },
      );
      if (result.status === "synced") {
        await ctx.runMutation(components.prosemirrorSync.lib.submitSnapshot, {
          id,
          version: version + tr.steps.length,
          content: JSON.stringify(tr.doc.toJSON()),
        });
        return tr.doc.toJSON();
      }
      for (const step of result.steps) {
        serverVersion.step(Step.fromJSON(schema, JSON.parse(step)));
      }
      version += result.steps.length;
    }
  },
});
