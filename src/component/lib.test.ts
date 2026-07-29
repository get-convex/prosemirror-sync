/// <reference types="vite/client" />

import { webcrypto as crypto } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { api } from "./_generated/api.js";

const modules = import.meta.glob("./**/*.*s");

describe("prosemirror lib", () => {
  test("submitSteps needs rebase", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const clientId = "client1";
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 0,
        content: "",
      });
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId,
        steps: ["1", "2"],
      });
    });
    expect(
      await t.mutation(api.lib.submitSteps, {
        id,
        clientId,
        version: 0,
        steps: ["a"],
      }),
    ).toEqual({
      status: "needs-rebase",
      clientIds: [clientId, clientId],
      steps: ["1", "2"],
    });
  });
  test("submitSteps synced", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const clientId = "client1";
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 0,
        content: "",
      });
    });
    expect(
      await t.mutation(api.lib.submitSteps, {
        id,
        clientId,
        version: 0,
        steps: ["a", "b"],
      }),
    ).toEqual({ status: "synced" });
    const { steps, clientIds, version } = await t.query(api.lib.getSteps, {
      id,
      version: 0,
    });
    expect(steps).toEqual(["a", "b"]);
    expect(clientIds).toEqual([clientId, clientId]);
    expect(version).toEqual(2);
  });
  test("getSteps skips steps before version", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const clientId = "client1";
    const clientId2 = "client2";
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId,
        steps: ["1", "2"],
      });
      await ctx.db.insert("deltas", {
        id,
        version: 3,
        clientId: clientId2,
        steps: ["3"],
      });
    });
    const { steps, clientIds, version } = await t.query(api.lib.getSteps, {
      id,
      version: 1,
    });
    expect(steps).toEqual(["2", "3"]);
    expect(clientIds).toEqual([clientId, clientId2]);
    expect(version).toEqual(3);
  });
  test("get handles missing snapshot", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(content).toEqual(null);
    expect(version).toEqual(undefined);
    const ignoringSteps = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(ignoringSteps.content).toEqual(null);
    expect(ignoringSteps.version).toEqual(undefined);
  });
  test("get works with only snapshot", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 0,
        content: "content",
      });
    });
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 0,
    });
    expect(content).toEqual("content");
    expect(version).toEqual(0);
  });
  test("get ignores steps version", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const clientId = "client1";
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 0,
        content: "content",
      });
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId,
        steps: ["1", "2"],
      });
    });
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(content).toEqual("content");
    expect(version).toEqual(0);
  });
  test("getSnapshot gets latest snapshot", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    const clientId = "client1";
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 1,
        content: "content",
      });
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId,
        steps: ["1", "2"],
      });
      await ctx.db.insert("snapshots", {
        id,
        version: 2,
        content: "content2",
      });
    });
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(content).toEqual("content2");
    expect(version).toEqual(2);
  });
  test("create, submit, then get works", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 0,
      content: "content",
    });
    await t.mutation(api.lib.submitSteps, {
      id,
      clientId: "client1",
      version: 0,
      steps: ["a", "b"],
    });
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(content).toEqual("content");
    expect(version).toEqual(0);
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 2,
      content: "content2",
    });
    const snapshot2 = await t.query(api.lib.getSnapshot, {
      id,
      version: 2,
    });
    expect(snapshot2.content).toEqual("content2");
    expect(snapshot2.version).toEqual(2);
  });
  test("submitSnapshot same content is idempotent", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 0,
      content: "content",
    });
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 0,
      content: "content",
    });
  });
  test("submitSnapshot different content is error", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 0,
      content: "content",
    });
    await expect(
      t.mutation(api.lib.submitSnapshot, {
        id,
        version: 0,
        content: "other content",
      }),
    ).rejects.toThrow();
  });
  test("a gap in the delta log makes getSteps fail permanently", async () => {
    // The invariant clients must not break: submitSteps doesn't check that the
    // submitted version is the server's head, so a client whose local version
    // has drifted ahead writes a delta with a gap — after which no client can
    // catch up. This is why the tiptap extension re-checks its collab version
    // after awaiting getSteps before applying them.
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", { id, version: 1, content: "content" });
      await ctx.db.insert("deltas", {
        id,
        version: 2,
        clientId: "client1",
        steps: ["a"],
      });
      // Versions 3 and 4 were never recorded: this client believed it was at 4.
      await ctx.db.insert("deltas", {
        id,
        version: 5,
        clientId: "client2",
        steps: ["d"],
      });
    });
    await expect(t.query(api.lib.getSteps, { id, version: 2 })).rejects.toThrow(
      "Missing steps 3...4",
    );
  });
  test("submitSnapshot deletes older snapshot", async () => {
    const t = convexTest(schema, modules);
    const id = crypto.randomUUID();
    // first one should stick around
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 1,
      content: "content",
      pruneSnapshots: true,
    });
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 2,
      content: "content2",
      pruneSnapshots: true,
    });
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 3,
      content: "content3",
      pruneSnapshots: true,
    });
    const { content, version } = await t.query(api.lib.getSnapshot, {
      id,
      version: 3,
    });
    expect(content).toEqual("content3");
    expect(version).toEqual(3);
    const { content: content2, version: version2 } = await t.query(
      api.lib.getSnapshot,
      {
        id,
        version: 2,
      },
    );
    expect(content2).toEqual("content");
    expect(version2).toEqual(1);
  });
});
