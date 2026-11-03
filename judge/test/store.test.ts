import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, MemoryStore, type StoredVerdict } from "../src/store.js";

const v = (taskId: string, over: Partial<StoredVerdict> = {}): StoredVerdict => ({
  taskId,
  status: "settled",
  outcome: "approved",
  confidence: 90,
  clauses: [{ index: 0, passed: true, reason: "r" }],
  summary: "s",
  model: "mock",
  at: "2026-11-04T10:00:00.000Z",
  reasoningJson: '{"a":1}',
  reasoningHash: "a".repeat(64),
  txHash: "TX",
  ...over,
});

describe("MemoryStore", () => {
  it("returns null for a task it has not seen", async () => {
    expect(await new MemoryStore().get("1")).toBeNull();
  });

  it("round-trips and lists in numeric task order, not string order", async () => {
    const s = new MemoryStore();
    await s.put(v("10"));
    await s.put(v("2"));
    await s.put(v("1"));
    expect((await s.list()).map((x) => x.taskId)).toEqual(["1", "2", "10"]);
  });

  it("a later put replaces an earlier one for the same task", async () => {
    const s = new MemoryStore();
    await s.put(v("1", { status: "held", outcome: "needs_manual_review" }));
    await s.put(v("1"));
    expect((await s.get("1"))?.status).toBe("settled");
  });
});

describe("FileStore", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const make = () => {
    dir = mkdtempSync(join(tmpdir(), "rubric-store-"));
    return { dir, store: new FileStore(join(dir, "verdicts")) };
  };

  it("creates its directory on first write and round-trips a record exactly", async () => {
    const { store } = make();
    const rec = v("3");
    await store.put(rec);
    expect(await store.get("3")).toEqual(rec);
  });

  it("keeps the reasoning text byte for byte, because its hash is on-chain", async () => {
    const { store } = make();
    const tricky = JSON.stringify({ k: "line\nbreak — café \u{1F600} \"quoted\" \\ back" });
    await store.put(v("4", { reasoningJson: tricky }));
    expect((await store.get("4"))?.reasoningJson).toBe(tricky);
  });

  it("returns null for a missing task, and an empty list before anything is written", async () => {
    const { store } = make();
    expect(await store.get("9")).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("lists in numeric order and ignores files that are not verdicts", async () => {
    const { dir: d, store } = make();
    await store.put(v("10"));
    await store.put(v("2"));
    writeFileSync(join(d, "verdicts", "notes.txt"), "hello");
    writeFileSync(join(d, "verdicts", "abc.json"), "{}");
    expect((await store.list()).map((x) => x.taskId)).toEqual(["2", "10"]);
  });

  it("refuses a task id that could name a path outside the directory", async () => {
    const { store } = make();
    for (const bad of ["../x", "..\\x", "a/b", "1.json", "", "-1", "1 ", "1e5"]) {
      await expect(store.get(bad), bad).rejects.toThrow(/invalid task id/);
      await expect(store.put(v(bad)), bad).rejects.toThrow(/invalid task id/);
    }
  });

  it("leaves no temporary file behind", async () => {
    const { dir: d, store } = make();
    await store.put(v("5"));
    expect(readdirSync(join(d, "verdicts"))).toEqual(["5.json"]);
  });

  it("surfaces a corrupt record as an error rather than inventing a verdict", async () => {
    const { dir: d, store } = make();
    await store.put(v("6"));
    writeFileSync(join(d, "verdicts", "6.json"), "{not json");
    await expect(store.get("6")).rejects.toThrow();
  });
});
