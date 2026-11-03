import { describe, expect, it } from "vitest";
import { hashRubric as sharedHash, canonicalRubric as sharedCanonical, sha256Hex as sharedSha, NEAR as SHARED_NEAR, formatNear as sharedFormatNear } from "@rubric-near/shared";
import {
  NEAR,
  accountUrl,
  canonicalRubric,
  describeOutcome,
  formatNear,
  hashRubric,
  judgeModels,
  loadChain,
  nsToDate,
  sha256Hex,
  short,
  tally,
  txUrl,
  verifyTask,
  viewCall,
} from "../public/lib.js";

// ------------------------------------------------------------------------------------ hashing

describe("the rubric hash the browser computes", () => {
  // The same vectors pinned in contract/src/tests.rs and shared/test/rubric.test.ts.
  const vectors: Array<[string, string[], string]> = [
    ["Fix the docs", ["The submission lists numbered steps.", "It quotes the exact error text."], "85274b4ea772c3a3e6a2da1e3acd995415bff05aa71a8dd0b323504aaba2c018"],
    ["T", ["One."], "fb51a0041d64a5a16f5eeb266df22782f7e8d75b7306d3940335b4d2861f6e84"],
    ["Unicode ok", ["Café — résumé stays as written."], "d4922f425accc8f14837adb7e9e6b0a1936292bdfa1a93f4163bfa309807c735"],
  ];

  it.each(vectors)("matches the contract's golden hash for %j", async (title, clauses, expected) => {
    expect(await hashRubric(title, clauses)).toBe(expected);
  });

  it("agrees with the shared implementation on text the golden vectors do not cover", async () => {
    const cases: Array<[string, string[]]> = [
      ["", []],
      ["emoji 😀 title", ["clause with 😀", "漢字 and ünïcödé"]],
      ["quotes", ['It contains "npm install".', "It's fine."]],
      ["long", ["x".repeat(280), "y".repeat(280)]],
    ];
    for (const [title, clauses] of cases) {
      expect(canonicalRubric(title, clauses)).toBe(sharedCanonical(title, clauses));
      expect(await hashRubric(title, clauses)).toBe(sharedHash(title, clauses));
    }
  });

  it("hashes text as UTF-8, like the shared implementation", async () => {
    for (const text of ["", "abc", "Café — 😀", "line\nbreak"]) expect(await sha256Hex(text)).toBe(sharedSha(text));
  });

  it("changes when a clause is reordered or the count changes", async () => {
    const a = await hashRubric("t", ["one", "two"]);
    expect(await hashRubric("t", ["two", "one"])).not.toBe(a);
    expect(await hashRubric("t", ["one", "two", ""])).not.toBe(a);
  });
});

describe("amounts", () => {
  it("formats yoctoNEAR exactly like the shared formatter", () => {
    expect(NEAR).toBe(SHARED_NEAR);
    for (const v of ["0", "1", "1000000000000000000000000", "98000000000000000000000", "2100000000000000000000", "5000000000000000000000001"]) {
      expect(formatNear(v)).toBe(sharedFormatNear(v));
    }
    expect(formatNear(98n * 10n ** 22n)).toBe("0.98");
  });

  it("turns nanoseconds into a date without losing the second", () => {
    expect(nsToDate("1762250400000000000").toISOString()).toBe("2025-11-04T10:00:00.000Z");
  });

  it("shortens long text and leaves short text alone", () => {
    expect(short("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(short("abc")).toBe("abc");
  });
});

describe("judgeModels", () => {
  const task = (model?: unknown) => ({ submission: null, verdict: model === undefined ? null : { model }, txs: {} });

  it("lists each model once, from the verdicts themselves, sorted", () => {
    const snapshot = { judge: "mock", tasks: { 0: task("mock"), 1: task("anthropic/claude-sonnet-5-5"), 2: task("mock") } };
    expect(judgeModels(snapshot)).toEqual(["anthropic/claude-sonnet-5-5", "mock"]);
  });

  it("ignores the file's own summary field, which can be stale", () => {
    expect(judgeModels({ judge: "mock", tasks: { 0: task("some/model") } })).toEqual(["some/model"]);
  });

  it("is empty when there is nothing to read, and does not trust odd values", () => {
    for (const s of [null, undefined, {}, { tasks: null }, { tasks: "x" }, { tasks: { 0: task() } }, { tasks: { 0: task(5), 1: task(""), 2: task(null) } }]) {
      expect(judgeModels(s)).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------- explorer links

describe("explorer links", () => {
  const TX = "8dRGXnZqyUCgPkNdYDKvsDFkXEz4fzRKcpbbB7mbGKtr";
  it("builds a link for a real-looking transaction hash", () => {
    expect(txUrl("https://testnet.nearblocks.io/txns/{hash}", TX)).toBe(`https://testnet.nearblocks.io/txns/${TX}`);
  });

  it("builds nothing from a hash that could break out of the URL", () => {
    for (const bad of ["../../x", `${TX}?x=1`, `${TX}#a`, "javascript:alert(1)", "", " ", `${TX} `, null, undefined, 12]) {
      expect(txUrl("https://testnet.nearblocks.io/txns/{hash}", bad as never)).toBeNull();
    }
  });

  it("accepts a NEAR account id and refuses anything else", () => {
    expect(accountUrl("https://x/address/{account}", "rubric-escrow-1d2c.testnet")).toBe("https://x/address/rubric-escrow-1d2c.testnet");
    for (const bad of ["", "A.testnet", "a/b", "a b", "a?b", "..", "-a", undefined as never]) expect(accountUrl("https://x/address/{account}", bad)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------ reading

function rpcReturning(value: unknown, record?: { body?: any }): typeof fetch {
  return (async (_url: unknown, init: any) => {
    if (record) record.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });
  }) as typeof fetch;
}

describe("viewCall", () => {
  it("asks the RPC for a final-state view call, with the arguments base64-encoded", async () => {
    const seen: { body?: any } = {};
    const out = await viewCall("https://rpc.example", "escrow.testnet", "get_task", { task_id: "3" }, rpcReturning({ id: "3" }, seen));
    expect(out).toEqual({ id: "3" });
    expect(seen.body.method).toBe("query");
    expect(seen.body.params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "escrow.testnet", method_name: "get_task" });
    expect(JSON.parse(atob(seen.body.params.args_base64))).toEqual({ task_id: "3" });
  });

  it("decodes UTF-8 results", async () => {
    expect(await viewCall("u", "c", "m", {}, rpcReturning({ title: "Café — 😀" }))).toEqual({ title: "Café — 😀" });
  });

  it("returns null for an empty result, which is how a missing task comes back", async () => {
    const empty = (async () => new Response(JSON.stringify({ result: { result: [] } }), { status: 200 })) as unknown as typeof fetch;
    expect(await viewCall("u", "c", "get_task", {}, empty)).toBeNull();
  });

  it("says so when the RPC fails, the contract panics, or the answer is not JSON-RPC", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(viewCall("u", "c", "m", {}, reply(503, {}))).rejects.toThrow(/answered 503/);
    await expect(viewCall("u", "c", "m", {}, reply(200, { error: { data: "no such account", cause: { name: "UNKNOWN_ACCOUNT" } } }))).rejects.toThrow(/refused m: no such account \(UNKNOWN_ACCOUNT\)/);
    await expect(viewCall("u", "c", "m", {}, reply(200, { result: { error: "wasm execution failed: panicked" } }))).rejects.toThrow(/could not answer m: wasm execution failed/);
  });
});

describe("loadChain", () => {
  it("pages through the tasks 50 at a time until it has them all", async () => {
    const calls: Array<{ method: string; args: any }> = [];
    const fetchImpl = (async (_u: unknown, init: any) => {
      const p = JSON.parse(init.body).params;
      const args = JSON.parse(atob(p.args_base64));
      calls.push({ method: p.method_name, args });
      const value =
        p.method_name === "get_config" ? { tasks_total: "120" } :
        p.method_name === "get_accounting" ? { escrow_held: "0" } :
        Array.from({ length: Math.min(50, 120 - Number(args.from_index)) }, (_, i) => ({ id: String(Number(args.from_index) + i) }));
      return new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await loadChain("u", "c", fetchImpl);
    expect(out.tasks).toHaveLength(120);
    expect(out.tasks[119].id).toBe("119");
    expect(calls.filter((c) => c.method === "get_tasks").map((c) => c.args.from_index)).toEqual(["0", "50", "100"]);
  });

  it("returns no tasks, and asks for none, when there are none", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_u: unknown, init: any) => {
      const m = JSON.parse(init.body).params.method_name;
      calls.push(m);
      const v = m === "get_config" ? { tasks_total: "0" } : { escrow_held: "0" };
      return new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))) } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await loadChain("u", "c", fetchImpl)).tasks).toEqual([]);
    expect(calls).not.toContain("get_tasks");
  });
});

// ------------------------------------------------------------------------------------ outcomes

describe("describeOutcome", () => {
  const T0 = 1_000_000_000n;
  const task = (over: object) => ({ state: "Open", deadline_ns: (T0 + 1n).toString(), verdict: null, payout: null, ...over });

  it("says OPEN until the deadline, then EXPIRED", () => {
    expect(describeOutcome(task({}), T0)).toEqual({ label: "OPEN", tone: "open" });
    expect(describeOutcome(task({ deadline_ns: T0.toString() }), T0)).toEqual({ label: "EXPIRED", tone: "wait" });
  });

  it("says AWAITING JUDGE for a submitted task", () => {
    expect(describeOutcome(task({ state: "Submitted" }), T0).label).toBe("AWAITING JUDGE");
  });

  it("says PAID only once the payout has landed", () => {
    expect(describeOutcome(task({ state: "Settled", payout: { status: "Paid" } }), T0)).toEqual({ label: "PAID", tone: "paid" });
    expect(describeOutcome(task({ state: "Settled", payout: { status: "Pending" } }), T0)).toEqual({ label: "PAYING", tone: "wait" });
  });

  it("tells a rejection's refund from the poster reclaiming an untaken task", () => {
    const refunded = { state: "Refunded", payout: { status: "Paid" } };
    expect(describeOutcome(task({ ...refunded, verdict: { approved: false } }), T0).label).toBe("REFUNDED");
    expect(describeOutcome(task({ ...refunded, verdict: null }), T0).label).toBe("RECLAIMED");
    expect(describeOutcome(task({ state: "Refunded", payout: { status: "Pending" } }), T0).label).toBe("REFUNDING");
  });

  it("raises the alarm for a payout that failed, whatever the state", () => {
    for (const state of ["Settled", "Refunded"]) expect(describeOutcome(task({ state, payout: { status: "Failed" } }), T0)).toEqual({ label: "PAYOUT FAILED", tone: "alarm" });
  });
});

// ------------------------------------------------------------------------------------ the checks

const CTX = { contract: "escrow.testnet", feeBps: 200, minConfidence: 70 };
const TITLE = "Write the install steps";
const CLAUSES = ['The submission contains "npm install".', 'The submission contains "troubleshooting".'];
const WORK = 'Work for: Write the install steps\nClause 1: This covers "npm install".\nClause 2: This covers "troubleshooting".';
const BOUNTY = 5n * NEAR / 10n;

async function fixture(over: { approved?: boolean; record?: object; recordFirst?: boolean; confidence?: number } = {}) {
  const approved = over.approved ?? true;
  const clausesHash = await hashRubric(TITLE, CLAUSES);
  const submissionHash = await sha256Hex(WORK);
  const record = {
    version: 1,
    contract: "escrow.testnet",
    taskId: "0",
    clausesHash,
    submissionHash,
    model: "mock",
    outcome: approved ? "approved" : "rejected",
    confidence: over.confidence ?? 90,
    clauses: [
      { index: 0, passed: true, reason: "present" },
      { index: 1, passed: approved, reason: approved ? "present" : "missing" },
    ],
    summary: "s",
    decidedAt: "2026-11-04T10:00:00.000Z",
    ...over.record,
  };
  const reasoningJson = JSON.stringify(record);
  const fee = (BOUNTY * 200n) / 10_000n;
  const task = {
    id: "0",
    poster: "poster.testnet",
    title: TITLE,
    clauses: CLAUSES,
    clauses_hash: clausesHash,
    bounty: BOUNTY.toString(),
    state: approved ? "Settled" : "Refunded",
    worker: "worker.testnet",
    submission_hash: submissionHash,
    verdict: { approved, confidence: over.confidence ?? 90, reasoning_hash: await sha256Hex(reasoningJson), decided_ns: "1" },
    payout: approved
      ? { to: "worker.testnet", amount: (BOUNTY - fee).toString(), fee: fee.toString(), status: "Paid" }
      : { to: "poster.testnet", amount: BOUNTY.toString(), fee: "0", status: "Paid" },
  };
  const entry = { submission: WORK, verdict: { reasoningJson } };
  return { task, entry };
}

const statusOf = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("verifyTask", () => {
  it("passes an approved task whose every claim checks out", async () => {
    const { task, entry } = await fixture();
    const checks = await verifyTask(task, entry, CTX);
    expect(statusOf(checks)).toEqual({ rubric: "pass", submission: "pass", reasoning: "pass", binding: "pass", rulings: "pass", confidence: "pass", payout: "pass" });
    expect(tally(checks)).toEqual({ pass: 7, fail: 0, skip: 0, total: 7 });
  });

  it("passes a rejected task, which must cite a failed clause and refund in full", async () => {
    const { task, entry } = await fixture({ approved: false });
    const s = statusOf(await verifyTask(task, entry, CTX));
    expect(s).toMatchObject({ rulings: "pass", payout: "pass" });
    expect(Object.values(s).every((v) => v === "pass")).toBe(true);
  });

  it("fails the rubric check if the clauses on-chain no longer hash to the seal", async () => {
    const { task, entry } = await fixture();
    const checks = await verifyTask({ ...task, clauses: [CLAUSES[0], "The submission contains nothing."] }, entry, CTX);
    expect(statusOf(checks).rubric).toBe("fail");
  });

  it("fails the submission check if the work was swapped", async () => {
    const { task, entry } = await fixture();
    const checks = await verifyTask(task, { ...entry, submission: `${WORK} (edited)` }, CTX);
    expect(statusOf(checks).submission).toBe("fail");
  });

  it("fails the reasoning check, and runs nothing that depends on it, if the reasoning was edited", async () => {
    const { task, entry } = await fixture();
    const edited = { ...entry, verdict: { reasoningJson: entry.verdict.reasoningJson.replace('"passed":true', '"passed":false') } };
    const s = statusOf(await verifyTask(task, edited, CTX));
    expect(s.reasoning).toBe("fail");
    expect(s.binding).toBe("skip");
    expect(s.rulings).toBe("skip");
  });

  it("says a check could not be run, rather than passing it, when the snapshot lacks the evidence", async () => {
    const { task } = await fixture();
    const s = statusOf(await verifyTask(task, null, CTX));
    expect(s).toMatchObject({ rubric: "pass", submission: "skip", reasoning: "skip", binding: "skip", rulings: "skip", payout: "pass" });
  });

  it("fails the binding check if the reasoning belongs to another contract, task, clauses or work", async () => {
    for (const record of [{ contract: "other.testnet" }, { taskId: "9" }, { clausesHash: "a".repeat(64) }, { submissionHash: "b".repeat(64) }]) {
      const { task, entry } = await fixture({ record });
      const s = statusOf(await verifyTask(task, entry, CTX));
      expect(s.reasoning).toBe("pass");
      expect(s.binding).toBe("fail");
    }
  });

  it("fails the binding check if the reasoning's outcome or confidence differs from the chain's", async () => {
    // The reasoning is genuine (it hashes to what the chain holds) but the chain's verdict says
    // something else, so the reasoning cannot be the reasoning for this verdict.
    const { task, entry } = await fixture();
    const otherConfidence = { ...task, verdict: { ...task.verdict, confidence: 99 } };
    const s = statusOf(await verifyTask(otherConfidence, entry, CTX));
    expect(s.reasoning).toBe("pass");
    expect(s.binding).toBe("fail");

    const otherOutcome = { ...task, verdict: { ...task.verdict, approved: false } };
    expect(statusOf(await verifyTask(otherOutcome, entry, CTX)).binding).toBe("fail");

    const recordSaysRejected = await fixture({ record: { outcome: "rejected" } });
    expect(statusOf(await verifyTask(recordSaysRejected.task, recordSaysRejected.entry, CTX)).binding).toBe("fail");
  });

  it("fails the rulings check for an approval with a failed clause, a rejection with none, or a missing ruling", async () => {
    const approvedButFailed = await fixture({ record: { clauses: [{ index: 0, passed: true, reason: "r" }, { index: 1, passed: false, reason: "r" }] } });
    expect(statusOf(await verifyTask(approvedButFailed.task, approvedButFailed.entry, CTX)).rulings).toBe("fail");

    const rejectedButAllPassed = await fixture({ approved: false, record: { clauses: [{ index: 0, passed: true, reason: "r" }, { index: 1, passed: true, reason: "r" }] } });
    expect(statusOf(await verifyTask(rejectedButAllPassed.task, rejectedButAllPassed.entry, CTX)).rulings).toBe("fail");

    const missing = await fixture({ record: { clauses: [{ index: 0, passed: true, reason: "r" }] } });
    expect(statusOf(await verifyTask(missing.task, missing.entry, CTX)).rulings).toBe("fail");

    const wrongIndex = await fixture({ record: { clauses: [{ index: 1, passed: true, reason: "r" }, { index: 0, passed: true, reason: "r" }] } });
    expect(statusOf(await verifyTask(wrongIndex.task, wrongIndex.entry, CTX)).rulings).toBe("fail");
  });

  it("fails the confidence check below the contract's minimum, and passes exactly at it", async () => {
    const low = await fixture({ confidence: 69 });
    expect(statusOf(await verifyTask(low.task, low.entry, CTX)).confidence).toBe("fail");
    const edge = await fixture({ confidence: 70 });
    expect(statusOf(await verifyTask(edge.task, edge.entry, CTX)).confidence).toBe("pass");
  });

  it("fails the payout check if the fee is wrong, the money does not add up, or it went to the wrong account", async () => {
    const { task, entry } = await fixture();
    const wrongFee = { ...task, payout: { ...task.payout!, fee: "1" } };
    expect(statusOf(await verifyTask(wrongFee, entry, CTX)).payout).toBe("fail");

    const underpaid = { ...task, payout: { ...task.payout!, amount: (BigInt(task.payout!.amount) - 1n).toString() } };
    expect(statusOf(await verifyTask(underpaid, entry, CTX)).payout).toBe("fail");

    const toStranger = { ...task, payout: { ...task.payout!, to: "stranger.testnet" } };
    expect(statusOf(await verifyTask(toStranger, entry, CTX)).payout).toBe("fail");

    // Each refund rule is exercised alone, so dropping any one of them is noticed.
    const refund = await fixture({ approved: false });
    const feeOnRefund = { ...refund.task, payout: { ...refund.task.payout!, fee: "1" } };
    expect(statusOf(await verifyTask(feeOnRefund, refund.entry, CTX)).payout).toBe("fail");
    const shortRefund = { ...refund.task, payout: { ...refund.task.payout!, amount: (BOUNTY - 1n).toString() } };
    expect(statusOf(await verifyTask(shortRefund, refund.entry, CTX)).payout).toBe("fail");
    const refundToWorker = { ...refund.task, payout: { ...refund.task.payout!, to: "worker.testnet" } };
    expect(statusOf(await verifyTask(refundToWorker, refund.entry, CTX)).payout).toBe("fail");
  });

  it("computes the fee from the contract's own fee rate, rounding down like the contract", async () => {
    const { task, entry } = await fixture();
    const odd = BigInt(task.bounty) + 1n; // 0.5 NEAR + 1 yocto: 2% rounds down
    const fee = (odd * 200n) / 10_000n;
    const t = { ...task, bounty: odd.toString(), payout: { ...task.payout!, amount: (odd - fee).toString(), fee: fee.toString() } };
    expect(statusOf(await verifyTask(t, entry, CTX)).payout).toBe("pass");
    expect(statusOf(await verifyTask(t, entry, { ...CTX, feeBps: 100 })).payout).toBe("fail");
  });

  it("checks only the rubric for a task nobody has touched", async () => {
    const { task } = await fixture();
    const open = { ...task, state: "Open", worker: null, submission_hash: null, verdict: null, payout: null };
    const checks = await verifyTask(open, null, CTX);
    expect(checks.map((c) => c.id)).toEqual(["rubric"]);
  });

  it("checks a reclaimed task's refund without needing any verdict", async () => {
    const { task } = await fixture();
    const reclaimed = { ...task, worker: null, submission_hash: null, verdict: null, payout: { to: "poster.testnet", amount: task.bounty, fee: "0", status: "Paid" }, state: "Refunded" };
    const checks = await verifyTask(reclaimed, null, CTX);
    expect(statusOf(checks)).toEqual({ rubric: "pass", payout: "pass" });
  });
});
