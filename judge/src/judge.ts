/**
 * Ruling on one submission.
 *
 * `runVerdict` asks a model and applies the guards. Its contract is a short list of things that
 * must never happen, whatever the model does: it never approves because something failed, it never
 * settles below the confidence threshold, and "I could not ask the model" is never dressed up as a
 * ruling on the work.
 */

import { freshNonce, buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";
import { ModelUnavailableError, type JudgeModel } from "./models.js";
import {
  DEFAULT_THRESHOLD,
  applyVerdictGuards,
  parseJudgePayload,
  type VerdictResult,
} from "./verdict.js";

export interface VerdictInput {
  title: string;
  clauses: readonly string[];
  /** The worker's NEAR account. */
  worker: string;
  /** The submission text. Untrusted data. */
  content: string;
}

export interface RunVerdictOptions {
  threshold?: number;
}

const RETRY_NOTE =
  "\n\nYour previous reply was not a valid JSON object in the required shape. Reply with ONLY the JSON object described in OUTPUT, with one ruling per clause.";

/** A hold that carries no ruling: the judge formed no view of the work. */
function operationalHold(model: JudgeModel, error: ModelUnavailableError): VerdictResult {
  return {
    outcome: "needs_manual_review",
    approved: false,
    confidence: 0,
    clauses: [],
    summary: "The judge could not be asked, so nothing has been decided. This is not a ruling on the work.",
    model: model.name,
    heldReason: `The judge could not be asked: ${error.message}.`,
    holdKind: "operational",
  };
}

export async function runVerdict(
  input: VerdictInput,
  model: JudgeModel,
  options: RunVerdictOptions = {}
): Promise<VerdictResult> {
  const threshold = Math.max(DEFAULT_THRESHOLD, options.threshold ?? DEFAULT_THRESHOLD);
  const nonce = freshNonce(input.content);
  const user = buildUserMessage(input, nonce);
  const base = { system: SYSTEM_PROMPT, title: input.title, clauses: input.clauses, content: input.content };

  let payload = null;
  for (let attempt = 0; attempt < 2 && payload === null; attempt++) {
    let raw: string;
    try {
      raw = await model.ask({ ...base, user: attempt === 0 ? user : user + RETRY_NOTE });
    } catch (error) {
      if (error instanceof ModelUnavailableError) return operationalHold(model, error);
      // An unexpected failure from the model layer is still "could not be asked", never a ruling.
      return operationalHold(model, new ModelUnavailableError("the model failed unexpectedly", "other"));
    }
    payload = parseJudgePayload(raw);
  }

  if (payload === null) {
    return {
      outcome: "needs_manual_review",
      approved: false,
      confidence: 0,
      clauses: [],
      summary: "The judge's reply could not be understood, so nothing has been decided.",
      model: model.name,
      heldReason: "The judge's reply could not be parsed into one ruling per clause.",
      holdKind: "judgement",
    };
  }

  const { outcome, heldReason } = applyVerdictGuards(payload, input.clauses.length, threshold);
  const clauses = [...payload.clauses].sort((a, b) => a.index - b.index);
  return {
    outcome,
    approved: outcome === "approved",
    confidence: payload.confidence,
    clauses,
    summary: payload.summary,
    model: model.name,
    ...(heldReason ? { heldReason, holdKind: "judgement" as const } : {}),
  };
}
