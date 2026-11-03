/**
 * The contract on a real runtime. The Rust unit tests cover the logic with a mocked environment;
 * this covers what only a real chain can: storage staking, real balances to the yoctoNEAR,
 * cross-contract callbacks (including a transfer that fails), the `#[private]` guard on those
 * callbacks, and the contract agreeing with the TypeScript client on the rubric hash.
 *
 * Money is asserted EXACTLY wherever the account being measured pays no gas in between, so a
 * payout that is off by one yoctoNEAR fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainError, hashRubric } from "@rubric-near/shared";
import { startSandbox, type Sandbox } from "../src/sandbox.js";
import { harness, hashOf, near, owedAndHeld, rawCall, seal, settledBalance, sleep, type Harness } from "./helpers.js";

let sb: Sandbox;
let h: Harness;

// A short grace period so the "judge never rules" door can be exercised in seconds. The production
// value (seven days) is the default and is covered by the Rust unit tests.
const GRACE_SECONDS = 6;

beforeAll(async () => {
  // The contract's account holds its code (about 1.7 NEAR of storage) and nothing else to start
  // with, so every payout in these tests has to come out of money that was deposited for it.
  sb = await startSandbox({ graceSeconds: GRACE_SECONDS, escrowBalance: "2.5" });
  h = harness(sb);
});

afterAll(async () => {
  await sb?.stop();
});

const acc = () => sb.accounts;

async function expectSolvent() {
  const { owed, balance, staked } = await owedAndHeld(h);
  expect(balance).toBeGreaterThanOrEqual(owed + staked);
}

/**
 * The poster sends the reclaim transaction itself, so it pays that call's gas (about 0.0006 NEAR)
 * and its balance cannot rise by exactly the bounty. It must rise by the bounty less that gas: more
 * than the bounty would be a refund too large, and less than 0.002 short would be a refund with a
 * fee or any other amount taken out of it (a 2% fee on these bounties is 0.004 or more).
 */
async function expectRefundedWithinGas(balanceBefore: bigint, bounty: bigint) {
  const gained = (await settledBalance(acc().poster)) - balanceBefore;
  expect(gained).toBeLessThanOrEqual(bounty);
  expect(gained).toBeGreaterThan(bounty - near("0.002"));
}

describe("deployment", () => {
  it("starts with the configuration it was given", async () => {
    const config = await h.chain.getConfig();
    expect(config).toMatchObject({
      owner_id: acc().owner.accountId,
      judge_id: acc().judge.accountId,
      fee_bps: 200,
      min_confidence: 70,
      max_bounty: near("5").toString(),
      verdict_grace_ns: String(BigInt(GRACE_SECONDS) * 1_000_000_000n),
      tasks_total: "0",
    });
  });

  it("cannot be initialised a second time, by anyone", async () => {
    for (const who of [acc().escrow, acc().owner, acc().poster]) {
      const result = await rawCall(who, sb.contractId, "new", {
        owner_id: acc().poster.accountId,
        judge_id: acc().worker.accountId,
        max_bounty: near("5").toString(),
        verdict_grace_seconds: 0,
      });
      expect(result.failed).toBe(true);
      expect(result.message).toMatch(/already been initialized/i);
    }
    expect((await h.chain.getConfig()).owner_id).toBe(acc().owner.accountId);
  });
});

describe("sealing, and storage staking", () => {
  it("escrows exactly the bounty, charges the poster for storage, and refunds any surplus", async () => {
    const bounty = near("0.1");
    const before = await settledBalance(acc().poster);
    const held = BigInt((await h.chain.getAccounting()).escrow_held);

    await seal(h, acc().poster, { bounty: "0.1", extra: near("1") });

    const spent = before - (await settledBalance(acc().poster));
    // The bounty, plus the storage for the task, plus gas: well under 0.05 NEAR on top. If the
    // 1 NEAR surplus had not come back, this would be about 1.1.
    expect(spent).toBeGreaterThan(bounty);
    expect(spent).toBeLessThan(bounty + near("0.05"));
    expect(BigInt((await h.chain.getAccounting()).escrow_held) - held).toBe(bounty);
    await expectSolvent();
  });

  it("refuses a deposit that does not cover the bounty plus storage", async () => {
    const bounty = near("0.1");
    const title = "Write the install steps";
    const clauses = ['The submission contains "npm install".'];
    await expect(
      h.signer(acc().poster).seal({ title, clauses, bounty, deadlineNs: BigInt(Date.now() + 60_000) * 1_000_000n, deposit: bounty })
    ).rejects.toThrow(/attach at least/);
  });

  it("refuses a bounty above the cap or below the minimum, and a deadline that is not in the future or too far away", async () => {
    const poster = h.signer(acc().poster);
    const base = { title: "T", clauses: ["One."], deadlineNs: BigInt(Date.now() + 60_000) * 1_000_000n };
    await expect(poster.seal({ ...base, bounty: near("6"), deposit: near("7") })).rejects.toThrow(/above the current cap/);
    await expect(poster.seal({ ...base, bounty: near("0.0001"), deposit: near("1") })).rejects.toThrow(/below the minimum/);
    await expect(poster.seal({ ...base, bounty: near("0.1"), deadlineNs: BigInt(Date.now() - 60_000) * 1_000_000n, deposit: near("1") })).rejects.toThrow(/in the future/);
    await expect(poster.seal({ ...base, bounty: near("0.1"), deadlineNs: BigInt(Date.now() + 31 * 86_400_000) * 1_000_000n, deposit: near("1") })).rejects.toThrow(/30 days/);
  });

  it("hashes the rubric exactly as the TypeScript client does, for text that is hard to get right", async () => {
    const cases: Array<[string, string[]]> = [
      ["Fix the docs", ["The submission lists numbered steps.", "It quotes the exact error text."]],
      ["Unicode ok", ["Café — résumé stays as written."]],
      ["Emoji 😀 and CJK 漢字", ["A clause with 😀 in it.", "漢字のテキスト"]],
      ['Quotes "and" apostrophes', ["It's got \"both\"."]],
    ];
    for (const [title, clauses] of cases) {
      const expected = hashRubric(title, clauses);
      expect(await h.chain.computeClausesHash(title, clauses)).toBe(expected);
      const id = await seal(h, acc().poster, { title, clauses });
      const task = await h.chain.getTask(id);
      expect(task?.clauses_hash).toBe(expected);
      expect(task?.title).toBe(title);
      expect(task?.clauses).toEqual(clauses);
    }
  });

  it("refuses text the hash could not represent unambiguously", async () => {
    const bad = (title: string, clauses: string[]) => h.chain.computeClausesHash(title, clauses);
    await expect(bad("line\nbreak", ["ok"])).rejects.toThrow(/control characters/);
    await expect(bad("ok", ["tab\there"])).rejects.toThrow(/control characters/);
    await expect(bad(" leading", ["ok"])).rejects.toThrow(/whitespace/);
    await expect(bad("ok", ["trailing "])).rejects.toThrow(/whitespace/);
    await expect(bad("ok", [""])).rejects.toThrow(/must not be empty/);
    await expect(bad("ok", [])).rejects.toThrow(/at least one clause/);
    await expect(bad("ok", Array.from({ length: 9 }, (_, i) => `clause ${i}`))).rejects.toThrow(/no more than 8/);
    await expect(bad("ok", ["x".repeat(281)])).rejects.toThrow(/longer than 280/);
    // 280 characters is fine, and an emoji counts as one character, not two.
    await expect(bad("ok", ["x".repeat(280)])).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(bad("ok", ["😀".repeat(280)])).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits a NEP-297 event for the seal", async () => {
    const title = "Event check";
    const clauses = ["One."];
    const result = await rawCall(
      acc().poster,
      sb.contractId,
      "seal",
      { title, clauses, bounty: near("0.1").toString(), deadline_ns: String(BigInt(Date.now() + 60_000) * 1_000_000n) },
      near("1")
    );
    expect(result.failed).toBe(false);
    const line = result.logs.find((l) => l.startsWith("EVENT_JSON:"));
    expect(line).toBeDefined();
    const event = JSON.parse(line!.slice("EVENT_JSON:".length));
    expect(event).toMatchObject({ standard: "rubric", version: "1.0.0", event: "sealed" });
    expect(JSON.stringify(event.data)).toContain(hashRubric(title, clauses));
  });
});

describe("a job done well", () => {
  it("pays the worker 98% to the yoctoNEAR, accrues 2% for the owner, and lets only the owner withdraw it", async () => {
    const id = await seal(h, acc().poster, { bounty: "1" });
    await h.signer(acc().worker).submit(id, hashOf("the deliverable"));
    const workerBefore = await settledBalance(acc().worker);

    await h.signer(acc().judge).settle(id, { approved: true, confidence: 90, reasoningHash: hashOf("the reasoning") });
    const done = await h.chain.waitForPayout(id);

    expect(done.state).toBe("Settled");
    expect(done.verdict).toMatchObject({ approved: true, confidence: 90, reasoning_hash: hashOf("the reasoning") });
    expect(done.payout).toEqual({ to: acc().worker.accountId, amount: near("0.98").toString(), fee: near("0.02").toString(), status: "Paid" });
    // The worker sent no transaction in between, so the change is exactly the payout.
    expect((await settledBalance(acc().worker)) - workerBefore).toBe(near("0.98"));
    await expectSolvent();

    // The fee is the owner's, and only the owner's.
    const fees = BigInt((await h.chain.getAccounting()).fees_accrued);
    expect(fees).toBeGreaterThanOrEqual(near("0.02"));
    const stranger = await rawCall(acc().poster, sb.contractId, "withdraw_fees", {});
    expect(stranger.failed).toBe(true);
    expect(stranger.message).toMatch(/only the owner/);

    const ownerBefore = await settledBalance(acc().owner);
    expect((await rawCall(acc().owner, sb.contractId, "withdraw_fees", {})).failed).toBe(false);
    const gained = (await settledBalance(acc().owner)) - ownerBefore;
    // The owner pays the gas for that call, so the fee arrives in full minus a few thousandths.
    expect(gained).toBeLessThanOrEqual(fees);
    expect(gained).toBeGreaterThan(fees - near("0.01"));
    expect((await h.chain.getAccounting()).fees_accrued).toBe("0");
    await expectSolvent();
  });

  it("closes the task for good: it cannot be settled, reclaimed or paid again", async () => {
    const id = await seal(h, acc().poster);
    await h.signer(acc().worker).submit(id, hashOf("work"));
    await h.signer(acc().judge).settle(id, { approved: true, confidence: 80, reasoningHash: hashOf("r") });
    await h.chain.waitForPayout(id);

    await expect(h.signer(acc().judge).settle(id, { approved: false, confidence: 99, reasoningHash: hashOf("r2") })).rejects.toThrow(/only a submitted task/);
    await expect(h.signer(acc().poster).reclaim(id)).rejects.toThrow(/already closed/);
    await expect(h.signer(acc().poster).retryPayout(id)).rejects.toThrow(/did not fail/);
    await expect(h.signer(acc().worker).submit(id, hashOf("again"))).rejects.toThrow(/not open for work/);
    expect((await h.chain.getTask(id))?.payout?.status).toBe("Paid");
  });
});

describe("a job done badly", () => {
  it("refunds the poster in full, with no fee, to the yoctoNEAR", async () => {
    const id = await seal(h, acc().poster, { bounty: "0.5" });
    const posterAfterSeal = await settledBalance(acc().poster);
    await h.signer(acc().worker).submit(id, hashOf("sloppy work"));
    const fees = (await h.chain.getAccounting()).fees_accrued;

    await h.signer(acc().judge).settle(id, { approved: false, confidence: 85, reasoningHash: hashOf("why") });
    const done = await h.chain.waitForPayout(id);

    expect(done.state).toBe("Refunded");
    expect(done.verdict).toMatchObject({ approved: false, confidence: 85 });
    expect(done.payout).toEqual({ to: acc().poster.accountId, amount: near("0.5").toString(), fee: "0", status: "Paid" });
    expect((await settledBalance(acc().poster)) - posterAfterSeal).toBe(near("0.5"));
    expect((await h.chain.getAccounting()).fees_accrued).toBe(fees);
    await expectSolvent();
  });
});

describe("who may do what", () => {
  it("accepts a verdict only from the judge, only at 70% confidence or more, only with a real reasoning hash", async () => {
    const id = await seal(h, acc().poster);
    await h.signer(acc().worker).submit(id, hashOf("work"));
    const verdict = { approved: true, confidence: 90, reasoningHash: hashOf("r") };

    for (const who of [acc().owner, acc().poster, acc().worker, acc().escrow]) {
      await expect(h.signer(who).settle(id, verdict)).rejects.toThrow(/only the judge/);
    }
    const judge = h.signer(acc().judge);
    await expect(judge.settle(id, { ...verdict, confidence: 69 })).rejects.toThrow(/below the minimum confidence/);
    await expect(judge.settle(id, { ...verdict, confidence: 101 })).rejects.toThrow(/percentage/);
    await expect(judge.settle(id, { ...verdict, reasoningHash: "0".repeat(64) })).rejects.toThrow(/reasoning hash/);
    await expect(judge.settle(id, { ...verdict, reasoningHash: "ABC" })).rejects.toThrow(/reasoning hash/);

    // None of that moved anything: the task is still waiting for a real verdict.
    expect((await h.chain.getTask(id))?.state).toBe("Submitted");
    await judge.settle(id, { ...verdict, confidence: 70 });
    expect((await h.chain.waitForPayout(id)).state).toBe("Settled");
  });

  it("will not settle a task nobody has submitted work for", async () => {
    const id = await seal(h, acc().poster);
    await expect(h.signer(acc().judge).settle(id, { approved: true, confidence: 90, reasoningHash: hashOf("r") })).rejects.toThrow(/only a submitted task/);
    await expect(h.signer(acc().judge).settle("9999", { approved: true, confidence: 90, reasoningHash: hashOf("r") })).rejects.toThrow(/no such task/);
  });

  it("lets one worker commit, never the poster, and only with a real hash", async () => {
    const id = await seal(h, acc().poster);
    await expect(h.signer(acc().poster).submit(id, hashOf("w"))).rejects.toThrow(/cannot work their own task/);
    await expect(h.signer(acc().worker).submit(id, "not a hash")).rejects.toThrow(/64 lowercase hex/);
    await expect(h.signer(acc().worker).submit(id, "0".repeat(64))).rejects.toThrow(/64 lowercase hex/);

    await h.signer(acc().worker).submit(id, hashOf("first"));
    const second = await sb.createAccount("worker2");
    await expect(h.signer(second).submit(id, hashOf("second"))).rejects.toThrow(/not open for work/);
    expect((await h.chain.getTask(id))?.worker).toBe(acc().worker.accountId);
    expect((await h.chain.getTask(id))?.submission_hash).toBe(hashOf("first"));
  });

  it("refuses the private callbacks to everyone, including the judge and the owner", async () => {
    const id = await seal(h, acc().poster);
    for (const who of [acc().poster, acc().judge, acc().owner, acc().worker]) {
      const payout = await rawCall(who, sb.contractId, "on_payout", { task_id: id });
      expect(payout.failed).toBe(true);
      expect(payout.message).toMatch(/private/i);
      const fees = await rawCall(who, sb.contractId, "on_fees_withdrawn", { amount: "1" });
      expect(fees.failed).toBe(true);
      expect(fees.message).toMatch(/private/i);
    }
    expect((await h.chain.getTask(id))?.state).toBe("Open");
  });

  it("gives the owner fees and the judge's key and nothing else: not the escrow, and not the poster's task", async () => {
    // Held in escrow at this moment, and the fees accrued: the owner can reach only the latter.
    const accounting = await h.chain.getAccounting();
    const tooMuch = BigInt(accounting.fees_accrued) + 1n;
    const overdraw = await rawCall(acc().owner, sb.contractId, "withdraw_fees", { amount: tooMuch.toString() });
    expect(overdraw.failed).toBe(true);
    expect(overdraw.message).toMatch(/more than the accrued fees|no fees to withdraw/);

    // Nobody but the owner can rotate the judge, and the judge cannot be the owner.
    expect((await rawCall(acc().poster, sb.contractId, "set_judge", { judge_id: acc().poster.accountId })).message).toMatch(/only the owner/);
    expect((await rawCall(acc().owner, sb.contractId, "set_judge", { judge_id: acc().owner.accountId })).message).toMatch(/must not be the owner/);
    expect((await rawCall(acc().poster, sb.contractId, "set_max_bounty", { max_bounty: near("90").toString() })).message).toMatch(/only the owner/);
  });

  it("lets the owner replace a compromised judge at once: the old key stops working, the new one works", async () => {
    const id = await seal(h, acc().poster);
    await h.signer(acc().worker).submit(id, hashOf("work"));
    const replacement = await sb.createAccount("judge2");
    const verdict = { approved: false, confidence: 90, reasoningHash: hashOf("r") };

    expect((await rawCall(acc().owner, sb.contractId, "set_judge", { judge_id: replacement.accountId })).failed).toBe(false);
    await expect(h.signer(acc().judge).settle(id, verdict)).rejects.toThrow(/only the judge/);
    await h.signer(replacement).settle(id, verdict);
    expect((await h.chain.waitForPayout(id)).state).toBe("Refunded");

    // Put the original judge back for the tests that follow.
    expect((await rawCall(acc().owner, sb.contractId, "set_judge", { judge_id: acc().judge.accountId })).failed).toBe(false);
    expect((await h.chain.getConfig()).judge_id).toBe(acc().judge.accountId);
  });
});

describe("a job nobody takes, and a judge who never rules", () => {
  it("lets the poster reclaim an untaken task only after its deadline, and only the poster", async () => {
    const windowSeconds = 12;
    const startedAt = Date.now();
    const id = await seal(h, acc().poster, { bounty: "0.3", windowSeconds });
    const posterAfterSeal = await settledBalance(acc().poster);

    expect(Date.now() - startedAt).toBeLessThan(windowSeconds * 1_000 - 1_500); // still inside the window
    await expect(h.signer(acc().poster).reclaim(id)).rejects.toThrow(/deadline has not passed/);
    await sleep(Math.max(0, startedAt + (windowSeconds + 1.5) * 1_000 - Date.now()));
    await expect(h.signer(acc().worker).reclaim(id)).rejects.toThrow(/only the poster/);
    await expect(h.signer(acc().worker).submit(id, hashOf("late"))).rejects.toThrow(/window has closed/);

    await h.signer(acc().poster).reclaim(id);
    const done = await h.chain.waitForPayout(id);
    expect(done.state).toBe("Refunded");
    expect(done.verdict).toBeNull();
    expect(done.payout).toEqual({ to: acc().poster.accountId, amount: near("0.3").toString(), fee: "0", status: "Paid" });
    await expectRefundedWithinGas(posterAfterSeal, near("0.3"));
    await expectSolvent();
  });

  it("makes the poster wait out the grace period when work was submitted, then returns the bounty in full", async () => {
    const windowSeconds = 8;
    const sealedAt = Date.now();
    const id = await seal(h, acc().poster, { bounty: "0.2", windowSeconds });
    await h.signer(acc().worker).submit(id, hashOf("work the judge never sees"));
    expect(Date.now() - sealedAt).toBeLessThan(windowSeconds * 1_000 - 1_500); // submitted inside the window
    const posterAfterSeal = await settledBalance(acc().poster);

    // Past the deadline, but inside the grace period: the judge may still rule, so the poster waits.
    await sleep(Math.max(0, sealedAt + (windowSeconds + 1.5) * 1_000 - Date.now()));
    expect(Date.now() - sealedAt).toBeLessThan((windowSeconds + GRACE_SECONDS) * 1_000 - 1_500); // still inside the grace period
    await expect(h.signer(acc().poster).reclaim(id)).rejects.toThrow(/judge still has until the deadline plus the grace period/);

    await sleep(Math.max(0, sealedAt + (windowSeconds + GRACE_SECONDS + 2) * 1_000 - Date.now()));
    await h.signer(acc().poster).reclaim(id);
    const done = await h.chain.waitForPayout(id);
    expect(done).toMatchObject({ state: "Refunded", worker: acc().worker.accountId });
    expect(done.payout).toEqual({ to: acc().poster.accountId, amount: near("0.2").toString(), fee: "0", status: "Paid" });
    await expectRefundedWithinGas(posterAfterSeal, near("0.2"));

    // A verdict that turns up after the refund changes nothing.
    await expect(h.signer(acc().judge).settle(id, { approved: true, confidence: 99, reasoningHash: hashOf("too late") })).rejects.toThrow(/only a submitted task/);
    await expectSolvent();
  });
});

describe("a payout that cannot land", () => {
  it("is recorded as failed, loses no money, and can be retried until the recipient exists again", async () => {
    // A worker whose account will cease to exist between its submission and its payout.
    const parent = await sb.createAccount("parent");
    const gone = await sb.createSubAccount(parent, "temp", "1");

    const heldBefore = BigInt((await h.chain.getAccounting()).escrow_held);
    const id = await seal(h, acc().poster, { bounty: "0.2" });
    await h.signer(gone).submit(id, hashOf("work"));
    // Deleting an account also spawns a gas refund to that same, now deleted, account. That receipt
    // fails, harmlessly, so judge the deletion by the transaction's own result and by the account
    // being gone, not by every receipt.
    const deletion = await gone.account.deleteAccount(parent.accountId);
    expect(deletion.status).toHaveProperty("SuccessValue");
    await expect(gone.account.getState()).rejects.toThrow();

    await h.signer(acc().judge).settle(id, { approved: true, confidence: 90, reasoningHash: hashOf("r") });
    const failed = await h.chain.waitForPayout(id);
    const share = near("0.196");

    // Approved and settled, but the transfer failed: the verdict stands, the payout is marked failed,
    // and the worker's share is STILL HELD and still counted, not lost and not double-counted.
    expect(failed.state).toBe("Settled");
    expect(failed.payout).toEqual({ to: gone.accountId, amount: share.toString(), fee: near("0.004").toString(), status: "Failed" });
    expect(BigInt((await h.chain.getAccounting()).escrow_held) - heldBefore).toBe(share);
    await expectSolvent();

    // Anyone can retry; the recipient and amount were fixed when the task closed. While the account
    // is still gone it fails again, and still nothing is lost.
    await h.signer(acc().poster).retryPayout(id);
    expect((await h.chain.waitForPayout(id)).payout?.status).toBe("Failed");
    expect(BigInt((await h.chain.getAccounting()).escrow_held) - heldBefore).toBe(share);

    // Bring the account back and retry: now it lands, exactly once.
    const revived = await sb.createSubAccount(parent, "temp", "0.1");
    expect(revived.accountId).toBe(gone.accountId);
    await h.signer(acc().poster).retryPayout(id);
    const paid = await h.chain.waitForPayout(id);
    expect(paid.payout).toEqual({ to: gone.accountId, amount: share.toString(), fee: near("0.004").toString(), status: "Paid" });
    expect(await settledBalance(revived)).toBe(near("0.1") + share);
    expect(BigInt((await h.chain.getAccounting()).escrow_held)).toBe(heldBefore);
    await expectSolvent();

    // And it cannot be paid a second time.
    await expect(h.signer(acc().poster).retryPayout(id)).rejects.toThrow(/did not fail/);
    expect(await settledBalance(revived)).toBe(near("0.1") + share);
  });
});

describe("the ledger", () => {
  it("lists every task in order, and the contract can still pay what it owes after all of the above", async () => {
    const total = Number((await h.chain.getConfig()).tasks_total);
    expect(total).toBeGreaterThan(10);
    const tasks = await h.chain.getAllTasks();
    expect(tasks).toHaveLength(total);
    expect(tasks.map((t) => t.id)).toEqual(Array.from({ length: total }, (_, i) => String(i)));
    // Every task that was sealed still carries the hash of exactly the text it stores.
    for (const t of tasks) expect(hashRubric(t.title, t.clauses)).toBe(t.clauses_hash);
    await expectSolvent();
  });

  it("reports a missing task as missing, not as an error", async () => {
    expect(await h.chain.getTask("123456")).toBeNull();
    await expect(h.chain.computeClausesHash("", ["x"])).rejects.toBeInstanceOf(ChainError);
  });
});
