import { hashRubric, hashSubmission, type Task } from "@rubric-near/shared";
import { ModelUnavailableError, type JudgeModel, type ModelRequest } from "../src/models.js";
import type { ChainReader, Settler } from "../src/service.js";

export const TITLE = "Fix the docs";
export const CLAUSES = ['The submission contains "numbered steps".', 'The submission quotes the exact "error text".'];
export const CONTENT = "I wrote numbered steps 1 to 4. The exact error text is: connection refused.";

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "0",
    poster: "poster.testnet",
    title: TITLE,
    clauses: CLAUSES,
    clauses_hash: hashRubric(TITLE, CLAUSES),
    bounty: "1000000000000000000000000",
    created_ns: "1800000000000000000",
    deadline_ns: "1800086400000000000",
    state: "Submitted",
    worker: "worker.testnet",
    submission_hash: hashSubmission(CONTENT),
    submitted_ns: "1800000100000000000",
    verdict: null,
    payout: null,
    ...over,
  };
}

/** The JSON a well-behaved judge returns for two clauses. */
export function goodReply(over: { passed?: boolean[]; confidence?: number; approved?: boolean } = {}): string {
  const passed = over.passed ?? [true, true];
  return JSON.stringify({
    clauses: passed.map((p, index) => ({ index, passed: p, reason: p ? `Clause ${index} is met.` : `Clause ${index} is not met.` })),
    approved: over.approved ?? passed.every(Boolean),
    confidence: over.confidence ?? 92,
    summary: "A short summary.",
  });
}

/** A model that returns scripted replies in order, and records what it was asked. */
export class ScriptedModel implements JudgeModel {
  readonly name: string;
  readonly requests: ModelRequest[] = [];
  private i = 0;

  constructor(
    private readonly replies: Array<string | Error>,
    name = "scripted"
  ) {
    this.name = name;
  }

  async ask(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    const next = this.replies[Math.min(this.i++, this.replies.length - 1)];
    if (next instanceof Error) throw next;
    return next ?? "";
  }
}

export const unavailable = (kind: "quota" | "timeout" | "unreachable" | "other" = "quota") =>
  new ModelUnavailableError("the model is out of credits", kind);

/** A chain with one editable task, and a settler that records what it was told to do. */
export function fakeChain(initial: Task | null) {
  let task = initial;
  const reads: string[] = [];
  const chain: ChainReader = {
    async getTask(id) {
      reads.push(id);
      return task;
    },
  };
  return {
    chain,
    reads,
    set(next: Task | null) {
      task = next;
    },
  };
}

export function fakeSettler(behaviour: "ok" | Error = "ok") {
  const calls: Array<{ taskId: string; approved: boolean; confidence: number; reasoningHash: string }> = [];
  const settler: Settler = {
    async settle(taskId, verdict) {
      calls.push({ taskId, ...verdict });
      if (behaviour instanceof Error) throw behaviour;
      return { txHash: `TX${calls.length}` };
    },
  };
  return { settler, calls };
}
