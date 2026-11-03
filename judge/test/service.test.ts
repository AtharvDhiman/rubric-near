import { describe, expect, it } from "vitest";
import { ChainError, hashRubric, sha256Hex } from "@rubric-near/shared";
import { createJudge, reasoningJson, reasoningMatches, type ReasoningRecord } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { CLAUSES, CONTENT, ScriptedModel, TITLE, fakeChain, fakeSettler, goodReply, makeTask, unavailable } from "./helpers.js";

const FIXED = new Date("2026-11-04T10:00:00.000Z");

function setup(opts: { task?: ReturnType<typeof makeTask> | null; replies?: Array<string | Error>; settle?: "ok" | Error; threshold?: number } = {}) {
  const chain = fakeChain(opts.task === undefined ? makeTask() : opts.task);
  const { settler, calls } = fakeSettler(opts.settle ?? "ok");
  const model = new ScriptedModel(opts.replies ?? [goodReply()], "scripted-model");
  const store = new MemoryStore();
  const judge = createJudge({
    chain: chain.chain,
    settler,
    model,
    store,
    contractId: "escrow.testnet",
    threshold: opts.threshold ?? 70,
    now: () => FIXED,
  });
  return { ...chain, judge, calls, model, store };
}

describe("settling", () => {
  it("approves, sends the verdict to the contract, and stores the public record", async () => {
    const s = setup();
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out.status).toBe("settled");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ taskId: "0", approved: true, confidence: 92 });

    const stored = await s.store.get("0");
    expect(stored).toMatchObject({ taskId: "0", status: "settled", outcome: "approved", model: "scripted-model", txHash: "TX1" });
    expect(stored?.at).toBe(FIXED.toISOString());
  });

  it("the hash sent on-chain is the SHA-256 of the exact reasoning text that is stored", async () => {
    const s = setup();
    await s.judge.judgeTask("0", CONTENT);
    const stored = (await s.store.get("0"))!;
    expect(sha256Hex(stored.reasoningJson!)).toBe(s.calls[0]!.reasoningHash);
    expect(stored.reasoningHash).toBe(s.calls[0]!.reasoningHash);
    expect(reasoningMatches(stored, s.calls[0]!.reasoningHash)).toBe(true);
  });

  it("the record names the contract, the task, both hashes and the model, and the rulings", async () => {
    const s = setup();
    await s.judge.judgeTask("0", CONTENT);
    const record = JSON.parse((await s.store.get("0"))!.reasoningJson!) as ReasoningRecord;
    expect(record).toMatchObject({
      version: 1,
      contract: "escrow.testnet",
      taskId: "0",
      clausesHash: hashRubric(TITLE, CLAUSES),
      model: "scripted-model",
      outcome: "approved",
      confidence: 92,
    });
    expect(record.submissionHash).toBe(makeTask().submission_hash);
    expect(record.clauses).toHaveLength(2);
  });

  it("rejects and refunds: the contract is told approved=false", async () => {
    const s = setup({ replies: [goodReply({ passed: [true, false] })] });
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out.status).toBe("settled");
    expect(s.calls[0]).toMatchObject({ approved: false });
    expect((await s.store.get("0"))?.outcome).toBe("rejected");
  });

  it("changing one character of the reasoning changes the hash, so a tampered record is detected", async () => {
    const s = setup();
    await s.judge.judgeTask("0", CONTENT);
    const stored = (await s.store.get("0"))!;
    const tampered = { ...stored, reasoningJson: stored.reasoningJson!.replace("approved", "rejected") };
    expect(reasoningMatches(tampered, stored.reasoningHash)).toBe(false);
    expect(reasoningMatches(stored, undefined)).toBe(false);
    expect(reasoningMatches({ ...stored, reasoningJson: undefined }, stored.reasoningHash)).toBe(false);
  });
});

describe("holding", () => {
  it("a low-confidence ruling is held: nothing is sent to the chain", async () => {
    const s = setup({ replies: [goodReply({ confidence: 60 })] });
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out.status).toBe("held");
    expect(s.calls).toHaveLength(0);
    const stored = await s.store.get("0");
    expect(stored).toMatchObject({ status: "held", outcome: "needs_manual_review", holdKind: "judgement" });
    expect(stored?.reasoningHash).toBeUndefined();
  });

  it("a judgement hold is not re-judged: asking again would only repeat it", async () => {
    const s = setup({ replies: [goodReply({ confidence: 60 }), goodReply({ confidence: 95 })] });
    await s.judge.judgeTask("0", CONTENT);
    const again = await s.judge.judgeTask("0", CONTENT);
    expect(again).toMatchObject({ status: "refused", code: "already_judged" });
    expect(s.model.requests).toHaveLength(1);
  });

  it("an operational hold IS retried, because the judge formed no view of the work", async () => {
    const s = setup({ replies: [unavailable("quota"), goodReply()] });
    const first = await s.judge.judgeTask("0", CONTENT);
    expect(first.status).toBe("held");
    expect(first.status === "held" && first.verdict.holdKind).toBe("operational");
    expect(s.calls).toHaveLength(0);

    const second = await s.judge.judgeTask("0", CONTENT);
    expect(second.status).toBe("settled");
    expect(s.calls).toHaveLength(1);
    expect((await s.store.get("0"))?.status).toBe("settled");
  });
});

describe("refusing before the model is asked", () => {
  it("no such task", async () => {
    const s = setup({ task: null });
    expect(await s.judge.judgeTask("9", CONTENT)).toMatchObject({ status: "refused", code: "not_found" });
    expect(s.model.requests).toHaveLength(0);
  });

  it.each(["Open", "Settled", "Refunded"] as const)("a task that is %s is not judged", async (state) => {
    const s = setup({ task: makeTask({ state }) });
    expect(await s.judge.judgeTask("0", CONTENT)).toMatchObject({ status: "refused", code: "not_submitted" });
    expect(s.model.requests).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it("the clauses on the chain do not hash to the seal: refuses, never rules on unsealed text", async () => {
    const tampered = makeTask({ clauses: ["The submission contains anything at all."] });
    const s = setup({ task: tampered });
    expect(await s.judge.judgeTask("0", CONTENT)).toMatchObject({ status: "refused", code: "rubric_hash_mismatch" });
    expect(s.model.requests).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it("a changed title breaks the seal too", async () => {
    const s = setup({ task: makeTask({ title: "A different title" }) });
    expect(await s.judge.judgeTask("0", CONTENT)).toMatchObject({ code: "rubric_hash_mismatch" });
  });

  it("the submission text is not the one the worker committed: refuses, never judges swapped work", async () => {
    const s = setup();
    const out = await s.judge.judgeTask("0", CONTENT + " (edited after submitting)");
    expect(out).toMatchObject({ status: "refused", code: "submission_hash_mismatch" });
    expect(s.model.requests).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
    expect(await s.store.get("0")).toBeNull();
  });

  it("compares against the hash the CHAIN holds, not anything the caller supplies", async () => {
    const s = setup({ task: makeTask({ submission_hash: "f".repeat(64) }) });
    expect(await s.judge.judgeTask("0", CONTENT)).toMatchObject({ code: "submission_hash_mismatch" });
  });

  it("a task with no committed hash cannot be judged", async () => {
    const s = setup({ task: makeTask({ submission_hash: null }) });
    expect(await s.judge.judgeTask("0", CONTENT)).toMatchObject({ code: "submission_hash_mismatch" });
  });

  it("an already settled verdict is returned as already judged, not redone", async () => {
    const s = setup();
    await s.judge.judgeTask("0", CONTENT);
    const again = await s.judge.judgeTask("0", CONTENT);
    expect(again).toMatchObject({ status: "refused", code: "already_judged" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("two requests for the same task result in exactly one settlement", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.judge.judgeTask("0", CONTENT), s.judge.judgeTask("0", CONTENT)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["refused", "settled"]);
    const refused = [a, b].find((o) => o.status === "refused");
    expect(refused).toMatchObject({ code: "in_progress" });
    expect(s.calls).toHaveLength(1);
  });

  it("different tasks are judged independently", async () => {
    const s = setup();
    s.set(makeTask({ id: "0" }));
    const [a, b] = await Promise.all([s.judge.judgeTask("0", CONTENT), s.judge.judgeTask("1", CONTENT)]);
    expect(a.status).toBe("settled");
    expect(b.status).toBe("settled");
    expect(s.calls.map((c) => c.taskId).sort()).toEqual(["0", "1"]);
  });
});

describe("when settlement fails", () => {
  it("reports the contract's refusal and stores nothing", async () => {
    const s = setup({ settle: new ChainError("settle was refused: only the judge can settle") });
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out).toEqual({ status: "failed", message: "settle was refused: only the judge can settle" });
    expect(await s.store.get("0")).toBeNull();
  });

  it("a failure that is not a ChainError is reported without its own text", async () => {
    const s = setup({ settle: new Error("https://rpc.example/?key=SECRET") });
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out).toEqual({ status: "failed", message: "settlement failed" });
  });

  it("after a failure the task can be judged again", async () => {
    const s = setup({ settle: new ChainError("rpc down") });
    await s.judge.judgeTask("0", CONTENT);
    expect(await s.store.get("0")).toBeNull();
    // Still Submitted on the chain, nothing stored: a retry is allowed and reaches the model again.
    const again = await s.judge.judgeTask("0", CONTENT);
    expect(again.status).toBe("failed");
    expect(s.model.requests).toHaveLength(2);
  });

  it("a LOST RESPONSE is recovered from the chain when the task shows our own verdict", async () => {
    const s = setup({ settle: new ChainError("timed out waiting for the response") });
    // The transaction landed anyway. Before the judge re-reads, the chain holds our reasoning hash.
    const original = s.chain.getTask.bind(s.chain);
    let reads = 0;
    s.chain.getTask = async (id) => {
      reads++;
      const t = await original(id);
      if (reads < 2) return t;
      const hash = s.model.requests.length > 0 ? s.calls[0]!.reasoningHash : "";
      return makeTask({ state: "Settled", verdict: { approved: true, confidence: 92, reasoning_hash: hash, decided_ns: "1" } });
    };
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out.status).toBe("settled");
    const stored = (await s.store.get("0"))!;
    expect(stored.status).toBe("settled");
    expect(stored.txHash).toBeUndefined();
    expect(stored.reasoningHash).toBe(s.calls[0]!.reasoningHash);
  });

  it("a task that someone ELSE settled with a different hash is not claimed", async () => {
    const s = setup({ settle: new ChainError("only a submitted task can be settled") });
    const original = s.chain.getTask.bind(s.chain);
    let reads = 0;
    s.chain.getTask = async (id) => {
      reads++;
      if (reads < 2) return original(id);
      return makeTask({ state: "Settled", verdict: { approved: false, confidence: 99, reasoning_hash: "e".repeat(64), decided_ns: "1" } });
    };
    const out = await s.judge.judgeTask("0", CONTENT);
    expect(out.status).toBe("failed");
    expect(await s.store.get("0")).toBeNull();
  });

  it("if re-reading the chain also fails, it is a plain failure", async () => {
    const s = setup({ settle: new ChainError("rpc down") });
    const original = s.chain.getTask.bind(s.chain);
    let reads = 0;
    s.chain.getTask = async (id) => {
      reads++;
      if (reads < 2) return original(id);
      throw new Error("rpc still down");
    };
    expect((await s.judge.judgeTask("0", CONTENT)).status).toBe("failed");
  });
});

describe("the reasoning record", () => {
  const base: ReasoningRecord = {
    version: 1,
    contract: "c",
    taskId: "1",
    clausesHash: "a".repeat(64),
    submissionHash: "b".repeat(64),
    model: "m",
    outcome: "approved",
    confidence: 90,
    clauses: [{ index: 0, passed: true, reason: "r" }],
    summary: "s",
    decidedAt: "2026-11-04T10:00:00.000Z",
  };

  it("has a fixed key order, however the input was built", () => {
    const shuffled = JSON.parse(JSON.stringify({ summary: "s", clauses: base.clauses, decidedAt: base.decidedAt, outcome: base.outcome, model: "m", version: 1, confidence: 90, submissionHash: base.submissionHash, clausesHash: base.clausesHash, taskId: "1", contract: "c" })) as ReasoningRecord;
    expect(reasoningJson(shuffled)).toBe(reasoningJson(base));
  });

  it("drops fields it does not know, so the hash covers exactly the documented record", () => {
    const withExtra = { ...base, secret: "x" } as unknown as ReasoningRecord;
    expect(reasoningJson(withExtra)).not.toContain("secret");
  });

  it("is stable: the same record always hashes the same", () => {
    expect(sha256Hex(reasoningJson(base))).toBe(sha256Hex(reasoningJson({ ...base })));
  });
});
