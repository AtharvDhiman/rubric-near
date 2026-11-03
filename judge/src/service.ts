/**
 * Judging one task end to end.
 *
 * The order is the point. Before the model is asked anything, the judge checks, against the
 * CHAIN, that it is about to rule on the right thing:
 *
 *   1. the task is `Submitted` (there is something to rule on, and nobody has ruled yet);
 *   2. the clauses the chain stored hash to the hash the chain sealed (the rubric is intact);
 *   3. the submission text it was handed hashes to the hash the worker COMMITTED on-chain
 *      (it is judging exactly the work that was submitted, not something swapped in later).
 *
 * Only then does it ask the model. A verdict that passes the guards is hashed, sent to the
 * contract, and only after the contract accepts it is it written to the store.
 */

import { createHash } from "node:crypto";
import { ChainError, hashRubric, hashSubmission, sha256Hex, type Task } from "@rubric-near/shared";
import { runVerdict } from "./judge.js";
import type { JudgeModel } from "./models.js";
import type { StoredVerdict, VerdictStore } from "./store.js";
import type { ClauseRuling, HoldKind, VerdictResult } from "./verdict.js";

export interface ChainReader {
  getTask(id: string): Promise<Task | null>;
}

export interface Settler {
  settle(
    taskId: string,
    verdict: { approved: boolean; confidence: number; reasoningHash: string }
  ): Promise<{ txHash: string }>;
}

export interface JudgeDeps {
  chain: ChainReader;
  settler: Settler;
  model: JudgeModel;
  store: VerdictStore;
  contractId: string;
  threshold: number;
  now?: () => Date;
}

export type RefusalCode =
  | "not_found"
  | "not_submitted"
  | "rubric_hash_mismatch"
  | "submission_hash_mismatch"
  | "already_judged"
  | "in_progress";

export type JudgeOutcome =
  | { status: "settled"; verdict: StoredVerdict }
  | { status: "held"; verdict: StoredVerdict }
  | { status: "refused"; code: RefusalCode; message: string }
  | { status: "failed"; message: string };

/** The public record of a verdict. Key order is fixed, because the hash is taken over these exact bytes. */
export interface ReasoningRecord {
  version: 1;
  contract: string;
  taskId: string;
  clausesHash: string;
  submissionHash: string;
  model: string;
  outcome: "approved" | "rejected";
  confidence: number;
  clauses: ClauseRuling[];
  summary: string;
  decidedAt: string;
}

export function reasoningJson(record: ReasoningRecord): string {
  const ordered: ReasoningRecord = {
    version: record.version,
    contract: record.contract,
    taskId: record.taskId,
    clausesHash: record.clausesHash,
    submissionHash: record.submissionHash,
    model: record.model,
    outcome: record.outcome,
    confidence: record.confidence,
    clauses: record.clauses.map((c) => ({ index: c.index, passed: c.passed, reason: c.reason })),
    summary: record.summary,
    decidedAt: record.decidedAt,
  };
  return JSON.stringify(ordered);
}

export function createJudge(deps: JudgeDeps) {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Set<string>();

  function held(taskId: string, result: VerdictResult): StoredVerdict {
    return {
      taskId,
      status: "held",
      outcome: "needs_manual_review",
      confidence: result.confidence,
      clauses: result.clauses,
      summary: result.summary,
      model: result.model,
      at: now().toISOString(),
      ...(result.holdKind ? { holdKind: result.holdKind as HoldKind } : {}),
      ...(result.heldReason ? { heldReason: result.heldReason } : {}),
    };
  }

  async function judgeTask(taskId: string, content: string): Promise<JudgeOutcome> {
    if (inFlight.has(taskId)) {
      return { status: "refused", code: "in_progress", message: "this task is already being judged" };
    }
    inFlight.add(taskId);
    try {
      return await judgeOnce(taskId, content);
    } finally {
      inFlight.delete(taskId);
    }
  }

  async function judgeOnce(taskId: string, content: string): Promise<JudgeOutcome> {
    // A verdict that already stands is returned, not redone. An operational hold formed no view of
    // the work, so asking again is exactly right; a judgement hold would only repeat itself.
    const existing = await deps.store.get(taskId);
    if (existing && (existing.status === "settled" || existing.holdKind === "judgement")) {
      return { status: "refused", code: "already_judged", message: "this task already has a verdict" };
    }

    const task = await deps.chain.getTask(taskId);
    if (!task) return { status: "refused", code: "not_found", message: "no such task" };
    if (task.state !== "Submitted") {
      return { status: "refused", code: "not_submitted", message: `the task is ${task.state}, not Submitted` };
    }

    // The chain's own clauses must hash to the chain's own seal. If they do not, either the chain
    // data or this client is wrong, and ruling would be ruling on something unsealed.
    if (hashRubric(task.title, task.clauses) !== task.clauses_hash) {
      return {
        status: "refused",
        code: "rubric_hash_mismatch",
        message: "the clauses stored on-chain do not hash to the sealed clause hash",
      };
    }
    const submissionHash = hashSubmission(content);
    if (task.submission_hash !== submissionHash) {
      return {
        status: "refused",
        code: "submission_hash_mismatch",
        message: "the submission text does not match the hash the worker committed on-chain",
      };
    }

    const result = await runVerdict(
      { title: task.title, clauses: task.clauses, worker: task.worker ?? "unknown", content },
      deps.model,
      { threshold: deps.threshold }
    );

    if (result.outcome === "needs_manual_review") {
      const verdict = held(taskId, result);
      await deps.store.put(verdict);
      return { status: "held", verdict };
    }

    const record: ReasoningRecord = {
      version: 1,
      contract: deps.contractId,
      taskId,
      clausesHash: task.clauses_hash,
      submissionHash,
      model: result.model,
      outcome: result.outcome,
      confidence: result.confidence,
      clauses: result.clauses,
      summary: result.summary,
      decidedAt: now().toISOString(),
    };
    const json = reasoningJson(record);
    const reasoningHash = sha256Hex(json);

    let txHash: string | undefined;
    try {
      ({ txHash } = await deps.settler.settle(taskId, {
        approved: result.approved,
        confidence: result.confidence,
        reasoningHash,
      }));
    } catch (error) {
      // The transaction may have landed even though this call failed (a lost response). Look at
      // the chain: if the task is settled with OUR reasoning hash, the verdict stands.
      const after = await deps.chain.getTask(taskId).catch(() => null);
      const landed =
        after !== null && (after.state === "Settled" || after.state === "Refunded") && after.verdict?.reasoning_hash === reasoningHash;
      if (!landed) {
        const message = error instanceof ChainError ? error.message : "settlement failed";
        return { status: "failed", message };
      }
    }

    const verdict: StoredVerdict = {
      taskId,
      status: "settled",
      outcome: result.outcome,
      confidence: result.confidence,
      clauses: result.clauses,
      summary: result.summary,
      model: result.model,
      at: record.decidedAt,
      reasoningJson: json,
      reasoningHash,
      ...(txHash ? { txHash } : {}),
    };
    await deps.store.put(verdict);
    return { status: "settled", verdict };
  }

  return { judgeTask };
}

/** Re-hash a stored verdict's reasoning and say whether it matches what the chain holds. */
export function reasoningMatches(verdict: StoredVerdict, onChainHash: string | undefined): boolean {
  if (!verdict.reasoningJson || !onChainHash) return false;
  return createHash("sha256").update(verdict.reasoningJson, "utf8").digest("hex") === onChainHash;
}
