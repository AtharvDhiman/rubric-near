import { describe, expect, it } from "vitest";
import { NEAR, hashRubric, type Task } from "@rubric-near/shared";
import { Budget, BudgetExceeded, ReceiptBook } from "../src/budget.js";
import { PosterAgent, type Need, type PosterChain, type Seller } from "../src/poster.js";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const need = (over: Partial<Need> = {}): Need => ({
  title: "Fix the docs",
  clauses: ["It has numbered steps.", "It quotes the error."],
  maxPrice: NEAR,
  windowSeconds: 3600,
  ...over,
});

class Stub implements Seller {
  quotes = 0;
  asked: bigint[] = [];
  constructor(
    readonly account: string,
    private readonly quoteFn: (n: Need) => bigint | null,
    private readonly acceptFn: (n: Need, p: bigint) => boolean = () => false
  ) {}
  async quote(n: Need) {
    this.quotes++;
    return this.quoteFn(n);
  }
  async accepts(n: Need, price: bigint) {
    this.asked.push(price);
    return this.acceptFn(n, price);
  }
}

function fakeChain(task: Partial<Task> | null = null) {
  const sealed: Array<Parameters<PosterChain["seal"]>[0]> = [];
  const reclaims: string[] = [];
  let failSeal: Error | null = null;
  let current: Task | null = task === null ? null : ({ id: "0", poster: "p.testnet", worker: null, state: "Open", verdict: null, payout: null, ...task } as Task);
  const chain: PosterChain = {
    async seal(input) {
      if (failSeal) throw failSeal;
      sealed.push(input);
      return { taskId: String(sealed.length - 1), txHash: `SEAL${sealed.length}` };
    },
    async reclaim(id) {
      reclaims.push(id);
      return { txHash: "RECLAIM" };
    },
    async getTask() {
      return current;
    },
    storageAllowance: () => NEAR / 10n,
  };
  return {
    chain,
    sealed,
    reclaims,
    set: (t: Partial<Task> | null) => (current = t === null ? null : ({ ...current, ...t } as Task)),
    failSealWith: (e: Error) => (failSeal = e),
  };
}

function agent(sellers: Seller[], opts: { cap?: bigint; chain?: ReturnType<typeof fakeChain> } = {}) {
  const chain = opts.chain ?? fakeChain();
  const budget = new Budget(opts.cap ?? 5n * NEAR);
  const receipts = new ReceiptBook();
  const poster = new PosterAgent({ chain: chain.chain, budget, receipts, sellers, now: () => NOW });
  return { poster, chain, budget, receipts };
}

describe("negotiation", () => {
  it("accepts the best quote when it is within what it may spend", async () => {
    const { poster } = agent([new Stub("a", () => NEAR / 2n)]);
    expect(await poster.negotiate(need())).toEqual({ price: NEAR / 2n, note: "accepted the best quote" });
  });

  it("takes the cheapest of several quotes", async () => {
    const { poster } = agent([new Stub("a", () => NEAR / 2n), new Stub("b", () => NEAR / 4n), new Stub("c", () => (NEAR * 3n) / 4n)]);
    expect((await poster.negotiate(need())).price).toBe(NEAR / 4n);
  });

  it("ignores sellers who will not quote, and zero or negative quotes", async () => {
    const { poster } = agent([new Stub("a", () => null), new Stub("b", () => 0n), new Stub("c", () => -5n), new Stub("d", () => NEAR / 2n)]);
    expect((await poster.negotiate(need())).price).toBe(NEAR / 2n);
  });

  it("when every quote is over budget it counters ONCE, at the most it may spend", async () => {
    const seller = new Stub("a", () => 2n * NEAR, (_n, p) => p >= NEAR);
    const { poster } = agent([seller]);
    const out = await poster.negotiate(need({ maxPrice: NEAR }));
    expect(out.price).toBe(NEAR);
    expect(out.note).toMatch(/countered once/);
    expect(seller.asked).toEqual([NEAR]);
  });

  it("asks each seller about the counter exactly once, then walks away", async () => {
    const a = new Stub("a", () => 2n * NEAR);
    const b = new Stub("b", () => 3n * NEAR);
    const { poster } = agent([a, b]);
    const out = await poster.negotiate(need({ maxPrice: NEAR }));
    expect(out.price).toBeNull();
    expect(out.note).toMatch(/walked away/);
    expect(a.asked).toEqual([NEAR]);
    expect(b.asked).toEqual([NEAR]);
    expect(a.quotes).toBe(1);
  });

  it("the ceiling is the budget that is left, when that is less than the job is worth", async () => {
    const seller = new Stub("a", () => 2n * NEAR, (_n, p) => p >= NEAR / 4n);
    const { poster, budget } = agent([seller], { cap: NEAR / 4n });
    expect(budget.remaining).toBe(NEAR / 4n);
    const out = await poster.negotiate(need({ maxPrice: 10n * NEAR }));
    expect(out.price).toBe(NEAR / 4n);
  });

  it("walks away when nobody quotes", async () => {
    const { poster } = agent([new Stub("a", () => null)]);
    expect(await poster.negotiate(need())).toEqual({ price: null, note: "nobody quoted" });
  });

  it("walks away when there is no budget left", async () => {
    const { poster, budget } = agent([new Stub("a", () => 1n)]);
    budget.reserve(budget.remaining);
    expect(await poster.negotiate(need())).toEqual({ price: null, note: "no budget left" });
  });
});

describe("buying", () => {
  it("walking away seals nothing, spends nothing, and records that it did", async () => {
    const { poster, chain, budget, receipts } = agent([new Stub("a", () => 9n * NEAR)]);
    const r = await poster.buy(need({ maxPrice: NEAR }));
    expect(r).toMatchObject({ taskId: null, outcome: "walked_away", price: "0", sealTx: null, clausesHash: null });
    expect(chain.sealed).toHaveLength(0);
    expect(budget.remaining).toBe(5n * NEAR);
    expect(receipts.receipts).toHaveLength(1);
  });

  it("seals the agreed price as the bounty, with a storage allowance on top and a deadline from now", async () => {
    const { poster, chain, budget } = agent([new Stub("a", () => NEAR / 2n)]);
    const r = await poster.buy(need({ windowSeconds: 600 }));
    expect(chain.sealed).toHaveLength(1);
    expect(chain.sealed[0]).toMatchObject({
      title: "Fix the docs",
      bounty: NEAR / 2n,
      deposit: NEAR / 2n + NEAR / 10n,
    });
    expect(chain.sealed[0]!.deadlineNs).toBe(BigInt(NOW.getTime()) * 1_000_000n + 600n * 1_000_000_000n);
    expect(r).toMatchObject({ taskId: "0", outcome: "pending", price: (NEAR / 2n).toString(), sealTx: "SEAL1" });
    expect(r.clausesHash).toBe(hashRubric("Fix the docs", need().clauses));
    expect(budget.remaining).toBe(5n * NEAR - NEAR / 2n);
  });

  it("a failed seal releases the budget, rethrows, and records nothing", async () => {
    const f = fakeChain();
    f.failSealWith(new Error("seal was refused: the bounty is above the current cap"));
    const { poster, budget, receipts } = agent([new Stub("a", () => NEAR / 2n)], { chain: f });
    await expect(poster.buy(need())).rejects.toThrow(/above the current cap/);
    expect(budget.remaining).toBe(5n * NEAR);
    expect(receipts.receipts).toHaveLength(0);
  });

  it("never commits more than the budget, however many jobs it buys", async () => {
    const { poster, budget, chain } = agent([new Stub("a", () => (NEAR * 3n) / 2n)], { cap: 4n * NEAR });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await poster.buy(need({ maxPrice: 2n * NEAR })));
    const spent = chain.sealed.reduce((n, s) => n + s.bounty, 0n);
    expect(spent).toBeLessThanOrEqual(4n * NEAR);
    expect(budget.remaining).toBeGreaterThanOrEqual(0n);
    // Once the budget is gone it walks away instead of sealing.
    expect(results.at(-1)!.outcome).toBe("walked_away");
  });

  it("the budget error type is exported for callers that reserve directly", () => {
    expect(new BudgetExceeded(2n, 1n)).toBeInstanceOf(Error);
  });
});

describe("collecting", () => {
  async function pending() {
    const f = fakeChain({ id: "0" });
    const a = agent([new Stub("a", () => NEAR / 2n)], { chain: f });
    const receipt = await a.poster.buy(need());
    return { ...a, f, receipt };
  }

  it("an approved task is recorded as paid, with its seller, confidence and fee, and the budget is spent", async () => {
    const { poster, f, receipt, budget } = await pending();
    f.set({
      state: "Settled",
      worker: "worker.testnet",
      verdict: { approved: true, confidence: 92, reasoning_hash: "a".repeat(64), decided_ns: "1" },
      payout: { to: "worker.testnet", amount: ((NEAR / 2n) * 98n / 100n).toString(), fee: (NEAR / 100n).toString(), status: "Paid" },
    });
    const done = await poster.collect(receipt);
    expect(done).toMatchObject({ outcome: "approved", seller: "worker.testnet", confidence: 92, fee: (NEAR / 100n).toString() });
    expect(budget.snapshot()).toMatchObject({ spent: (NEAR / 2n).toString(), reserved: "0" });
  });

  it("a rejected task is a refund: the budget is free again", async () => {
    const { poster, f, receipt, budget } = await pending();
    f.set({
      state: "Refunded",
      worker: "worker.testnet",
      verdict: { approved: false, confidence: 90, reasoning_hash: "a".repeat(64), decided_ns: "1" },
      payout: { to: "p.testnet", amount: (NEAR / 2n).toString(), fee: "0", status: "Paid" },
    });
    const done = await poster.collect(receipt);
    expect(done).toMatchObject({ outcome: "rejected", confidence: 90, fee: "0" });
    expect(budget.remaining).toBe(5n * NEAR);
  });

  it("a refund with no verdict is a reclaim", async () => {
    const { poster, f, receipt } = await pending();
    f.set({ state: "Refunded", worker: null, verdict: null, payout: { to: "p.testnet", amount: (NEAR / 2n).toString(), fee: "0", status: "Paid" } });
    expect((await poster.collect(receipt)).outcome).toBe("reclaimed");
  });

  it.each(["Open", "Submitted"] as const)("a task still %s leaves the receipt pending and the money reserved", async (state) => {
    const { poster, f, receipt, budget } = await pending();
    f.set({ state });
    const done = await poster.collect(receipt);
    expect(done.outcome).toBe("pending");
    expect(budget.remaining).toBe(5n * NEAR - NEAR / 2n);
  });

  it("collecting twice does not conclude the budget twice", async () => {
    const { poster, f, receipt, budget } = await pending();
    f.set({ state: "Settled", worker: "w.testnet", verdict: { approved: true, confidence: 90, reasoning_hash: "a".repeat(64), decided_ns: "1" }, payout: null });
    await poster.collect(receipt);
    await poster.collect(receipt);
    expect(budget.snapshot().spent).toBe((NEAR / 2n).toString());
  });

  it("the chain is the only source: a task the chain does not have is an error", async () => {
    const { poster, f, receipt } = await pending();
    f.set(null);
    await expect(poster.collect(receipt)).rejects.toThrow(/not on the chain/);
  });

  it("a walked-away receipt is returned untouched", async () => {
    const { poster, receipts } = agent([new Stub("a", () => 9n * NEAR)]);
    const r = await poster.buy(need({ maxPrice: NEAR }));
    expect(await poster.collect(r)).toBe(r);
    expect(receipts.receipts).toHaveLength(1);
  });

  it("reclaim calls the contract and then reads the result back", async () => {
    const { poster, f, receipt } = await pending();
    f.set({ state: "Refunded", worker: null, verdict: null, payout: { to: "p.testnet", amount: (NEAR / 2n).toString(), fee: "0", status: "Paid" } });
    const done = await poster.reclaim(receipt);
    expect(f.reclaims).toEqual(["0"]);
    expect(done.outcome).toBe("reclaimed");
  });
});
