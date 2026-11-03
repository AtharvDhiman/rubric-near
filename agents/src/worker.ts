/**
 * The worker agent: finds open work it can afford to do, does it, commits to it on-chain, and hands
 * the work to the judge.
 *
 * It is also a Seller: the poster agent asks it what a job would cost. It never fakes a quote,
 * and it refuses jobs below its own floor, so it can say no.
 */

import { hashSubmission, type Task } from "@rubric-near/shared";
import type { Need, Seller } from "./poster.js";

/** Whatever actually produces the deliverable: a script, or a language model. */
export interface Doer {
  readonly name: string;
  produce(job: { title: string; clauses: readonly string[] }): Promise<string>;
}

export interface WorkerChain {
  getTasks(from: number, limit: number): Promise<Task[]>;
  submit(taskId: string, submissionHash: string): Promise<{ txHash: string }>;
}

export interface WorkerDeps {
  account: string;
  chain: WorkerChain;
  doer: Doer;
  /** The judge's base URL, e.g. http://localhost:8787. */
  judgeUrl: string;
  /** The least this worker will do one clause of work for, in yoctoNEAR. */
  pricePerClause: bigint;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface WorkResult {
  taskId: string;
  submitted: boolean;
  submissionHash: string | null;
  /** The deliverable exactly as produced; its SHA-256 is `submissionHash`. */
  content: string;
  /** The transaction that committed the hash on-chain, or null if the contract refused it. */
  submitTx: string | null;
  /** The judge's JSON reply, or why there was none. */
  judge: unknown;
  note: string;
}

export class WorkerAgent implements Seller {
  readonly account: string;
  private readonly now: () => Date;
  private readonly http: typeof fetch;

  constructor(private readonly deps: WorkerDeps) {
    this.account = deps.account;
    this.now = deps.now ?? (() => new Date());
    this.http = deps.fetch ?? fetch;
  }

  /** The floor for a job: a fixed price per clause. */
  floor(clauseCount: number): bigint {
    return this.deps.pricePerClause * BigInt(clauseCount);
  }

  async quote(need: Need): Promise<bigint | null> {
    return this.floor(need.clauses.length);
  }

  async accepts(need: Need, price: bigint): Promise<boolean> {
    return price >= this.floor(need.clauses.length);
  }

  /** An open task this worker could take: not its own, not past its deadline, paying at least its floor. Best-paid first. */
  async findWork(): Promise<Task | null> {
    const nowNs = BigInt(this.now().getTime()) * 1_000_000n;
    const open: Task[] = [];
    for (let from = 0; ; from += 50) {
      const page = await this.deps.chain.getTasks(from, 50);
      open.push(...page);
      if (page.length < 50) break;
    }
    const candidates = open.filter(
      (t) =>
        t.state === "Open" &&
        t.poster !== this.account &&
        BigInt(t.deadline_ns) > nowNs &&
        BigInt(t.bounty) >= this.floor(t.clauses.length)
    );
    candidates.sort((a, b) => (BigInt(b.bounty) > BigInt(a.bounty) ? 1 : BigInt(b.bounty) < BigInt(a.bounty) ? -1 : 0));
    return candidates[0] ?? null;
  }

  /**
   * Do one task: produce the deliverable, commit to its hash on-chain FIRST, then give the judge the
   * text. The order matters: once the hash is on-chain the work cannot be changed, and the judge
   * refuses any text that does not match it.
   */
  async work(task: Task): Promise<WorkResult> {
    const content = await this.deps.doer.produce({ title: task.title, clauses: task.clauses });
    const submissionHash = hashSubmission(content);
    let submitTx: string;
    try {
      ({ txHash: submitTx } = await this.deps.chain.submit(task.id, submissionHash));
    } catch (error) {
      return { taskId: task.id, submitted: false, submissionHash, content, submitTx: null, judge: null, note: `the contract refused the submission: ${(error as Error).message}` };
    }

    let judge: unknown;
    try {
      const res = await this.http(`${this.deps.judgeUrl.replace(/\/+$/, "")}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, content }),
      });
      judge = await res.json();
    } catch {
      // The work is committed on-chain either way. The judge can be given the text again.
      return { taskId: task.id, submitted: true, submissionHash, content, submitTx, judge: null, note: "submitted on-chain, but the judge could not be reached" };
    }
    return { taskId: task.id, submitted: true, submissionHash, content, submitTx, judge, note: "submitted and handed to the judge" };
  }

  /** Find a job and do it. Returns null if there is nothing worth taking. */
  async step(): Promise<WorkResult | null> {
    const task = await this.findWork();
    return task ? this.work(task) : null;
  }
}

/**
 * A doer that writes a deliverable which contains every phrase the clauses put in double quotes.
 * It is a script, not a language model: it exists so the demo runs offline and the offline judge
 * has something to rule on. With `omit`, it leaves out the Nth clause's phrases, so the same agent
 * can produce work that fails, for showing a rejection.
 */
export class TemplateDoer implements Doer {
  readonly name = "template";

  constructor(private readonly options: { omit?: number } = {}) {}

  async produce(job: { title: string; clauses: readonly string[] }): Promise<string> {
    const lines = job.clauses.map((clause, i) => {
      if (i === this.options.omit) return `Clause ${i + 1}: I did not get to this one.`;
      const phrases = [...clause.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]!);
      const detail = phrases.length > 0 ? `This covers ${phrases.map((p) => `"${p}"`).join(" and ")}.` : "This is addressed in full above.";
      return `Clause ${i + 1}: ${detail}`;
    });
    return [`Work for: ${job.title}`, ...lines].join("\n");
  }
}
