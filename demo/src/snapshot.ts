/**
 * What the dashboard needs that the chain does not keep: the judge's reasoning text, the work that
 * was submitted, and the transaction hashes of the steps.
 *
 * None of it is trusted. The chain holds a hash of each piece, so the dashboard re-hashes them in
 * the reader's browser and compares; a snapshot that was edited, or that belongs to another
 * contract, fails that comparison instead of being believed.
 */

import type { StoredVerdict } from "@rubric-near/judge";
import type { Receipt, WorkResult } from "@rubric-near/agents";

export interface SnapshotTask {
  /** The deliverable, byte for byte. Its SHA-256 should equal the task's on-chain submission_hash. */
  submission: string | null;
  /** The judge's stored record. For a settled verdict it carries the exact reasoning text that was hashed. */
  verdict: StoredVerdict | null;
  txs: { seal?: string; submit?: string; settle?: string };
}

export interface Snapshot {
  version: 1;
  contract: string;
  network: "testnet";
  exportedAt: string;
  /** The model behind the verdicts. "mock" means the offline judge: deterministic, not a language model. */
  judge: string;
  tasks: Record<string, SnapshotTask>;
}

/**
 * Combine an earlier snapshot with a new run's, so a second run against the same contract (say, with
 * a real model after one with the mock) adds to what the dashboard can verify instead of erasing it.
 * A snapshot for another contract, or one that is not a snapshot at all, is replaced.
 */
export function mergeSnapshots(existing: unknown, fresh: Snapshot): Snapshot {
  const old = existing as Partial<Snapshot> | null | undefined;
  if (!old || old.version !== 1 || old.contract !== fresh.contract || typeof old.tasks !== "object" || old.tasks === null) return fresh;
  return {
    ...fresh,
    // Each verdict names its own model; this is only the file's summary.
    judge: old.judge === fresh.judge ? fresh.judge : "mixed",
    tasks: { ...old.tasks, ...fresh.tasks },
  };
}

export function buildSnapshot(input: {
  contractId: string;
  exportedAt: string;
  judge: string;
  receipts: readonly Receipt[];
  works: readonly WorkResult[];
  verdicts: readonly StoredVerdict[];
}): Snapshot {
  const tasks: Record<string, SnapshotTask> = {};
  // Only tasks that were actually sealed have an id; a negotiation that was walked away from has none.
  for (const receipt of input.receipts) {
    if (receipt.taskId === null) continue;
    tasks[receipt.taskId] = { submission: null, verdict: null, txs: receipt.sealTx ? { seal: receipt.sealTx } : {} };
  }
  for (const work of input.works) {
    const task = tasks[work.taskId];
    if (!task || !work.submitted) continue;
    task.submission = work.content;
    if (work.submitTx) task.txs.submit = work.submitTx;
  }
  for (const verdict of input.verdicts) {
    const task = tasks[verdict.taskId];
    if (!task) continue;
    task.verdict = verdict;
    if (verdict.txHash) task.txs.settle = verdict.txHash;
  }
  return { version: 1, contract: input.contractId, network: "testnet", exportedAt: input.exportedAt, judge: input.judge, tasks };
}
