/**
 * What a verdict is, and the rules that must hold whatever the model says.
 *
 * PORTED from the Solana version of Rubric (web/lib/verifier.ts in the baseline repository): the
 * schema and `applyVerdictGuards` are the same rules. The model is asked for a ruling per clause,
 * but nothing it says is trusted on its own: `approved` is recomputed from the per-clause table,
 * a contradiction is a hold, a rejection must cite a failed clause, and a low confidence holds
 * the task instead of settling it, in either direction.
 */

import { z } from "zod";

export const ClauseRulingSchema = z.object({
  index: z.number().int().min(0),
  passed: z.boolean(),
  reason: z.string().min(1),
});

export const JudgePayloadSchema = z.object({
  clauses: z.array(ClauseRulingSchema),
  approved: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  summary: z.string().min(1),
});

export type ClauseRuling = z.infer<typeof ClauseRulingSchema>;
export type JudgePayload = z.infer<typeof JudgePayloadSchema>;

export type Outcome = "approved" | "rejected" | "needs_manual_review";

/**
 * WHY a task was held. The two need opposite handling.
 *  - "judgement":   the judge looked at the work and could not settle it. A person is needed.
 *  - "operational": the judge could not be ASKED (down, out of quota, too slow). It formed no view
 *                   of the work, so this is not a ruling and must not look like one.
 */
export type HoldKind = "judgement" | "operational";

export interface VerdictResult {
  outcome: Outcome;
  /** True only when outcome === "approved". Never taken from the model's field alone. */
  approved: boolean;
  confidence: number;
  clauses: ClauseRuling[];
  summary: string;
  /** Which model produced this ("mock" for the offline rule-based judge). */
  model: string;
  heldReason?: string;
  holdKind?: HoldKind;
}

/**
 * Turn a well-formed payload into a protocol outcome. Every rule here is deterministic and
 * independent of the model behaving well, so each one can be tested without calling a model.
 */
export function applyVerdictGuards(
  payload: JudgePayload,
  clauseCount: number,
  threshold: number
): { outcome: Outcome; heldReason?: string } {
  // One ruling per clause, every index present exactly once, no strays.
  const indices = payload.clauses.map((c) => c.index).sort((a, b) => a - b);
  const shapeOk = indices.length === clauseCount && indices.every((v, i) => v === i);
  if (!shapeOk) {
    return {
      outcome: "needs_manual_review",
      heldReason: `The judge returned ${payload.clauses.length} rulings for ${clauseCount} clauses, or repeated an index.`,
    };
  }

  // `approved` is recomputed, never taken on trust.
  const everyClausePassed = payload.clauses.every((c) => c.passed);

  // A model that says "approved" while its own table shows a failure is confused or has been
  // manipulated. Do not settle either way on that.
  if (payload.approved !== everyClausePassed) {
    return {
      outcome: "needs_manual_review",
      heldReason: "The judge's overall verdict contradicted its own per-clause rulings.",
    };
  }

  // A rejection must be able to point at a failed clause, with a reason.
  if (!everyClausePassed) {
    const cited = payload.clauses.find((c) => !c.passed && c.reason.trim().length > 0);
    if (!cited) {
      return { outcome: "needs_manual_review", heldReason: "The rejection did not cite a specific failed clause." };
    }
  }

  // The confidence gate applies to approvals and rejections alike: a low-confidence refund is as
  // wrong as a low-confidence payout. (The contract enforces the same floor on-chain.)
  if (payload.confidence < threshold) {
    return {
      outcome: "needs_manual_review",
      heldReason: `Confidence ${payload.confidence} is below the ${threshold} threshold required to settle automatically.`,
    };
  }

  return { outcome: everyClausePassed ? "approved" : "rejected" };
}

/**
 * Parse a model's raw text into a payload. Models wrap JSON in prose or code fences, so take the
 * outermost {...}; anything that does not then validate against the schema is `null`.
 */
export function parseJudgePayload(raw: string): JudgePayload | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = JudgePayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The default confidence floor. The contract's own floor (70) is the lower bound that matters. */
export const DEFAULT_THRESHOLD = 70;

/** The configured threshold, never below the contract's floor: a lower one could only produce verdicts the chain refuses. */
export function confidenceThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CONFIDENCE_THRESHOLD);
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return DEFAULT_THRESHOLD;
  return Math.min(100, Math.max(DEFAULT_THRESHOLD, raw));
}
