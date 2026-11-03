import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSnapshot } from "../src/report.js";
import { mergeSnapshots, type Snapshot } from "../src/snapshot.js";
import type { ScenarioResult } from "../src/scenario.js";

const snap = (contract: string, judge: string, ids: string[]): Snapshot => ({
  version: 1,
  contract,
  network: "testnet",
  exportedAt: "2026-11-04T10:00:00.000Z",
  judge,
  tasks: Object.fromEntries(ids.map((id) => [id, { submission: `work ${id} by ${judge}`, verdict: null, txs: {} }])),
});

const result = (snapshot: Snapshot, ok = true): ScenarioResult => ({ receipts: [], table: "", checks: [], ok, snapshot });

describe("mergeSnapshots", () => {
  it("adds a new run's tasks to an earlier run's for the same contract", () => {
    const merged = mergeSnapshots(snap("c.testnet", "mock", ["3", "4", "5"]), snap("c.testnet", "mock", ["6", "7"]));
    expect(Object.keys(merged.tasks).sort()).toEqual(["3", "4", "5", "6", "7"]);
    expect(merged.judge).toBe("mock");
  });

  it("says the judge is mixed when the runs used different ones, and keeps each task as it was", () => {
    const merged = mergeSnapshots(snap("c.testnet", "mock", ["3"]), snap("c.testnet", "anthropic/claude-sonnet-5-5", ["6"]));
    expect(merged.judge).toBe("mixed");
    expect(merged.tasks["3"]?.submission).toBe("work 3 by mock");
    expect(merged.tasks["6"]?.submission).toBe("work 6 by anthropic/claude-sonnet-5-5");
  });

  it("takes the newer record if a task id appears in both", () => {
    const merged = mergeSnapshots(snap("c.testnet", "mock", ["3"]), snap("c.testnet", "mock2", ["3"]));
    expect(merged.tasks["3"]?.submission).toBe("work 3 by mock2");
  });

  it("replaces a snapshot of another contract, rather than mixing two contracts' tasks", () => {
    const fresh = snap("new.testnet", "mock", ["0"]);
    expect(mergeSnapshots(snap("old.testnet", "mock", ["3"]), fresh)).toEqual(fresh);
  });

  it("replaces anything that is not a snapshot", () => {
    const fresh = snap("c.testnet", "mock", ["0"]);
    for (const junk of [null, undefined, 5, "text", {}, { version: 2, contract: "c.testnet", tasks: {} }, { version: 1, contract: "c.testnet" }, { version: 1, contract: "c.testnet", tasks: null }]) {
      expect(mergeSnapshots(junk, fresh)).toEqual(fresh);
    }
  });
});

describe("exportSnapshot", () => {
  let dir: string;
  let file: string;
  const lines: string[] = [];
  const print = (l: string) => void lines.push(l);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rubric-export-"));
    file = join(dir, "nested", "verdicts.json");
    lines.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const read = async () => JSON.parse(await readFile(file, "utf8")) as Snapshot;

  it("writes a new file, creating its directory, and says what it wrote", async () => {
    await exportSnapshot(result(snap("c.testnet", "mock", ["0", "1"])), file, print);
    expect(Object.keys((await read()).tasks)).toEqual(["0", "1"]);
    expect(lines.join("\n")).toContain("2 tasks from this run");
    expect(lines.join("\n")).not.toContain("kept");
  });

  it("adds a second run to the first instead of replacing it", async () => {
    await exportSnapshot(result(snap("c.testnet", "mock", ["0", "1"])), file, print);
    await exportSnapshot(result(snap("c.testnet", "model", ["2"])), file, print);
    const written = await read();
    expect(Object.keys(written.tasks)).toEqual(["0", "1", "2"]);
    expect(written.judge).toBe("mixed");
    expect(lines.at(-1)).toContain("1 task from this run, 2 kept from earlier runs");
  });

  it("writes nothing from a run that failed, and leaves an existing file untouched", async () => {
    await exportSnapshot(result(snap("c.testnet", "mock", ["0"])), file, print);
    const before = await readFile(file, "utf8");
    await exportSnapshot(result(snap("c.testnet", "mock", ["9"]), false), file, print);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(lines.at(-1)).toContain("NOT written");
  });

  it("does nothing when no path was asked for", async () => {
    await exportSnapshot(result(snap("c.testnet", "mock", ["0"])), undefined, print);
    await exportSnapshot(result(snap("c.testnet", "mock", ["0"])), "   ", print);
    expect(lines).toEqual([]);
  });

  it("replaces a file that is not a snapshot, and says so", async () => {
    await writeFile(join(dir, "bad.json"), "{ not json");
    await exportSnapshot(result(snap("c.testnet", "mock", ["0"])), join(dir, "bad.json"), print);
    expect(lines.join("\n")).toContain("could not be read as a snapshot");
    expect(JSON.parse(await readFile(join(dir, "bad.json"), "utf8")).tasks).toHaveProperty("0");
  });
});
