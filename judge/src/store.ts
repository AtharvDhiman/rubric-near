/**
 * Where verdicts are kept. The chain stores a hash of the judge's reasoning; this keeps the
 * reasoning itself, in the exact bytes that were hashed, so anyone can re-hash it and compare.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClauseRuling, HoldKind } from "./verdict.js";

export interface StoredVerdict {
  taskId: string;
  /** "settled": the verdict is on-chain. "held": nothing was sent to the chain. */
  status: "settled" | "held";
  outcome: "approved" | "rejected" | "needs_manual_review";
  confidence: number;
  clauses: ClauseRuling[];
  summary: string;
  model: string;
  at: string;
  holdKind?: HoldKind;
  heldReason?: string;
  /** The exact text whose SHA-256 is the on-chain reasoning_hash. Present when settled. */
  reasoningJson?: string;
  reasoningHash?: string;
  /** Absent only when settlement was recovered from the chain after the judge lost its own response. */
  txHash?: string;
}

export interface VerdictStore {
  get(taskId: string): Promise<StoredVerdict | null>;
  put(verdict: StoredVerdict): Promise<void>;
  list(): Promise<StoredVerdict[]>;
}

export class MemoryStore implements VerdictStore {
  private readonly items = new Map<string, StoredVerdict>();
  async get(taskId: string) {
    return this.items.get(taskId) ?? null;
  }
  async put(verdict: StoredVerdict) {
    this.items.set(verdict.taskId, verdict);
  }
  async list() {
    return [...this.items.values()].sort((a, b) => Number(a.taskId) - Number(b.taskId));
  }
}

const SAFE_ID = /^\d{1,20}$/;

export class FileStore implements VerdictStore {
  constructor(private readonly dir: string) {}

  private file(taskId: string): string {
    // A task id is digits only, so a crafted id can never name a path outside the directory.
    if (!SAFE_ID.test(taskId)) throw new Error("invalid task id");
    return join(this.dir, `${taskId}.json`);
  }

  async get(taskId: string): Promise<StoredVerdict | null> {
    try {
      return JSON.parse(await readFile(this.file(taskId), "utf8")) as StoredVerdict;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(verdict: StoredVerdict): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(verdict.taskId);
    // Write then rename, so a crash never leaves a half-written record that would later be
    // read as a verdict.
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(verdict, null, 2), "utf8");
    await rename(temp, target);
  }

  async list(): Promise<StoredVerdict[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items: StoredVerdict[] = [];
    for (const name of names) {
      const m = /^(\d{1,20})\.json$/.exec(name);
      if (!m) continue;
      const item = await this.get(m[1]!);
      if (item) items.push(item);
    }
    return items.sort((a, b) => Number(a.taskId) - Number(b.taskId));
  }
}
