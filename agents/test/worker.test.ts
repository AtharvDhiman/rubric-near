import { describe, expect, it } from "vitest";
import { NEAR, hashSubmission, type Task } from "@rubric-near/shared";
import { TemplateDoer, WorkerAgent, type Doer, type WorkerChain } from "../src/worker.js";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const nowNs = BigInt(NOW.getTime()) * 1_000_000n;

const task = (over: Partial<Task> = {}): Task => ({
  id: "0",
  poster: "poster.testnet",
  title: "Fix the docs",
  clauses: ['It contains "numbered steps".', 'It quotes the "error text".'],
  clauses_hash: "a".repeat(64),
  bounty: NEAR.toString(),
  created_ns: nowNs.toString(),
  deadline_ns: (nowNs + 3_600_000_000_000n).toString(),
  state: "Open",
  worker: null,
  submission_hash: null,
  submitted_ns: null,
  verdict: null,
  payout: null,
  ...over,
});

function setup(tasks: Task[], opts: { submitFails?: Error; fetchImpl?: typeof fetch; floor?: bigint } = {}) {
  const log: string[] = [];
  const submits: Array<{ taskId: string; hash: string }> = [];
  const chain: WorkerChain = {
    async getTasks(from, limit) {
      return tasks.slice(from, from + limit);
    },
    async submit(taskId, hash) {
      log.push("submit");
      if (opts.submitFails) throw opts.submitFails;
      submits.push({ taskId, hash });
      return { txHash: "TX" };
    },
  };
  const posts: Array<{ url: string; body: { taskId: string; content: string } }> = [];
  const fetchImpl: typeof fetch =
    opts.fetchImpl ??
    (async (url, init) => {
      log.push("post");
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "settled" }), { status: 200 });
    });
  const doer: Doer = {
    name: "fixed",
    async produce() {
      log.push("produce");
      return "the deliverable text";
    },
  };
  const worker = new WorkerAgent({
    account: "worker.testnet",
    chain,
    doer,
    judgeUrl: "http://judge.local:8787/",
    pricePerClause: opts.floor ?? NEAR / 10n,
    fetch: fetchImpl,
    now: () => NOW,
  });
  return { worker, log, submits, posts };
}

describe("quotes", () => {
  it("quotes a fixed price per clause, and accepts anything at or above its floor", async () => {
    const { worker } = setup([]);
    const n = { title: "t", clauses: ["a", "b", "c"], maxPrice: NEAR, windowSeconds: 60 };
    expect(await worker.quote(n)).toBe((NEAR * 3n) / 10n);
    expect(await worker.accepts(n, (NEAR * 3n) / 10n)).toBe(true);
    expect(await worker.accepts(n, (NEAR * 3n) / 10n - 1n)).toBe(false);
  });
});

describe("finding work", () => {
  it("returns nothing when there is nothing", async () => {
    expect(await setup([]).worker.findWork()).toBeNull();
  });

  it("skips its own tasks, tasks that are not open, expired ones and ones below its floor", async () => {
    const { worker } = setup([
      task({ id: "1", poster: "worker.testnet" }),
      task({ id: "2", state: "Submitted" }),
      task({ id: "3", state: "Settled" }),
      task({ id: "4", deadline_ns: (nowNs - 1n).toString() }),
      task({ id: "5", bounty: (NEAR / 10n).toString() }), // floor is 0.2 NEAR for two clauses
    ]);
    expect(await worker.findWork()).toBeNull();
  });

  it("takes a task paying exactly its floor", async () => {
    const { worker } = setup([task({ id: "6", bounty: ((NEAR / 10n) * 2n).toString() })]);
    expect((await worker.findWork())?.id).toBe("6");
  });

  it("prefers the best-paid task", async () => {
    const { worker } = setup([
      task({ id: "1", bounty: NEAR.toString() }),
      task({ id: "2", bounty: (3n * NEAR).toString() }),
      task({ id: "3", bounty: (2n * NEAR).toString() }),
    ]);
    expect((await worker.findWork())?.id).toBe("2");
  });

  it("looks through every page of tasks, not just the first", async () => {
    const many = Array.from({ length: 120 }, (_, i) => task({ id: String(i), state: "Settled" }));
    many.push(task({ id: "120", bounty: NEAR.toString() }));
    expect((await setup(many).worker.findWork())?.id).toBe("120");
  });
});

describe("doing the work", () => {
  it("commits the hash on-chain BEFORE handing the text to the judge", async () => {
    const { worker, log, submits, posts } = setup([task()]);
    const result = await worker.work(task());
    expect(log).toEqual(["produce", "submit", "post"]);
    expect(submits).toEqual([{ taskId: "0", hash: hashSubmission("the deliverable text") }]);
    expect(posts[0]).toEqual({
      url: "http://judge.local:8787/submissions",
      body: { taskId: "0", content: "the deliverable text" },
    });
    expect(result).toMatchObject({ taskId: "0", submitted: true, submissionHash: hashSubmission("the deliverable text") });
    expect(result.judge).toEqual({ status: "settled" });
  });

  it("the hash on-chain and the text the judge gets are of the same string", async () => {
    const { worker, submits, posts } = setup([task()]);
    await worker.work(task());
    expect(hashSubmission(posts[0]!.body.content)).toBe(submits[0]!.hash);
  });

  it("if the contract refuses the submission, the judge is never contacted", async () => {
    const { worker, posts, log } = setup([task()], { submitFails: new Error("this task is not open for work") });
    const result = await worker.work(task());
    expect(result.submitted).toBe(false);
    expect(result.note).toMatch(/contract refused the submission: this task is not open for work/);
    expect(posts).toHaveLength(0);
    expect(log).not.toContain("post");
  });

  it("if the judge cannot be reached, the work is still committed and it says so", async () => {
    const { worker } = setup([task()], {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await worker.work(task());
    expect(result).toMatchObject({ submitted: true, judge: null });
    expect(result.note).toMatch(/judge could not be reached/);
  });

  it("step() does one job, or reports there is none", async () => {
    const some = setup([task({ id: "7" })]);
    expect((await some.worker.step())?.taskId).toBe("7");
    expect(await setup([]).worker.step()).toBeNull();
  });
});

describe("TemplateDoer", () => {
  const job = { title: "Fix the docs", clauses: ['It contains "numbered steps".', 'It quotes the "error text" and "stack".', "A plain clause."] };

  it("writes a deliverable that contains every quoted phrase", async () => {
    const text = await new TemplateDoer().produce(job);
    for (const phrase of ["numbered steps", "error text", "stack"]) expect(text).toContain(`"${phrase}"`);
    expect(text).toContain("Work for: Fix the docs");
  });

  it("can leave one clause out, so the same agent can produce work that fails", async () => {
    const text = await new TemplateDoer({ omit: 1 }).produce(job);
    expect(text).toContain('"numbered steps"');
    expect(text).not.toContain('"error text"');
    expect(text).toContain("did not get to this one");
  });

  it("is deterministic", async () => {
    expect(await new TemplateDoer().produce(job)).toBe(await new TemplateDoer().produce(job));
  });
});
