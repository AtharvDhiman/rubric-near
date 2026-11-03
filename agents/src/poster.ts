/**
 * The poster agent: buys work within a hard budget.
 *
 * It negotiates before it spends. It asks sellers what they would do a job for; if the best quote
 * is more than it may spend, it COUNTERS ONCE, at the most it may spend, and if nobody takes that
 * it WALKS AWAY, seals nothing, and records that it did. Only then does it commit money, by
 * sealing a task on the escrow contract with exactly the agreed price.
 */

import { hashRubric, type Task } from "@rubric-near/shared";
import { Budget, ReceiptBook, type Receipt } from "./budget.js";

export interface Need {
  title: string;
  clauses: string[];
  /** The most this job is worth to the poster, in yoctoNEAR. */
  maxPrice: bigint;
  /** How long a worker has, in seconds. */
  windowSeconds: number;
}

export interface Seller {
  /** The seller's NEAR account. */
  readonly account: string;
  /** What they would do this job for, or null if they will not. */
  quote(need: Need): Promise<bigint | null>;
  /** Whether they take the job at exactly this price. */
  accepts(need: Need, price: bigint): Promise<boolean>;
}

/** The two things the poster does on-chain. */
export interface PosterChain {
  seal(input: { title: string; clauses: string[]; bounty: bigint; deadlineNs: bigint; deposit: bigint }): Promise<{ taskId: string; txHash: string }>;
  reclaim(taskId: string): Promise<{ txHash: string }>;
  getTask(taskId: string): Promise<Task | null>;
  /** The deposit to attach for storage on top of the bounty; the contract refunds what it does not use. */
  storageAllowance(title: string, clauses: string[]): bigint;
}

export interface PosterDeps {
  chain: PosterChain;
  budget: Budget;
  receipts: ReceiptBook;
  sellers: Seller[];
  now?: () => Date;
}

const nsFromNow = (now: Date, seconds: number) => BigInt(now.getTime()) * 1_000_000n + BigInt(seconds) * 1_000_000_000n;

export class PosterAgent {
  private readonly now: () => Date;

  constructor(private readonly deps: PosterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Negotiate a price. Returns the agreed price, or null if the agent should walk away. */
  async negotiate(need: Need): Promise<{ price: bigint | null; note: string }> {
    const ceiling = need.maxPrice < this.deps.budget.remaining ? need.maxPrice : this.deps.budget.remaining;
    if (ceiling <= 0n) return { price: null, note: "no budget left" };

    const quotes: bigint[] = [];
    for (const seller of this.deps.sellers) {
      const q = await seller.quote(need);
      if (q !== null && q > 0n) quotes.push(q);
    }
    if (quotes.length === 0) return { price: null, note: "nobody quoted" };

    const best = quotes.reduce((a, b) => (a < b ? a : b));
    if (best <= ceiling) return { price: best, note: "accepted the best quote" };

    // The best quote is more than the poster may spend. Counter ONCE, at the ceiling.
    for (const seller of this.deps.sellers) {
      if (await seller.accepts(need, ceiling)) {
        return { price: ceiling, note: "countered once at the ceiling, and a seller accepted" };
      }
    }
    return { price: null, note: "the best quote was over budget, the counter-offer was refused, so it walked away" };
  }

  /** Buy one job. Never spends outside the budget; records a receipt either way. */
  async buy(need: Need): Promise<Receipt> {
    const at = this.now().toISOString();
    const { price, note } = await this.negotiate(need);

    if (price === null) {
      return this.deps.receipts.add({
        taskId: null,
        title: need.title,
        seller: null,
        price: "0",
        fee: "0",
        outcome: "walked_away",
        confidence: null,
        clausesHash: null,
        sealTx: null,
        note,
        at,
      });
    }

    // The budget is checked and the money set aside BEFORE the transaction, so a failure to seal
    // cannot leave the agent believing it spent money it did not.
    this.deps.budget.reserve(price);
    try {
      const sealed = await this.deps.chain.seal({
        title: need.title,
        clauses: need.clauses,
        bounty: price,
        deadlineNs: nsFromNow(this.now(), need.windowSeconds),
        deposit: price + this.deps.chain.storageAllowance(need.title, need.clauses),
      });
      return this.deps.receipts.add({
        taskId: sealed.taskId,
        title: need.title,
        seller: null,
        price: price.toString(),
        fee: "0",
        outcome: "pending",
        confidence: null,
        clausesHash: hashRubric(need.title, need.clauses),
        sealTx: sealed.txHash,
        note,
        at,
      });
    } catch (error) {
      this.deps.budget.conclude(price, false);
      throw error;
    }
  }

  /**
   * Read the task's outcome from the chain and settle the books. The chain is the only source: the
   * agent does not take anyone's word, including its own, for whether a task was paid.
   */
  async collect(receipt: Receipt): Promise<Receipt> {
    if (receipt.taskId === null || receipt.outcome !== "pending") return receipt;
    const task = await this.deps.chain.getTask(receipt.taskId);
    if (!task) throw new Error(`task ${receipt.taskId} is not on the chain`);
    if (task.state !== "Settled" && task.state !== "Refunded") return receipt;

    const price = BigInt(receipt.price);
    // Refunded with a verdict is a rejection; refunded with none is the poster reclaiming.
    receipt.outcome = task.state === "Settled" ? "approved" : task.verdict ? "rejected" : "reclaimed";
    receipt.seller = task.worker;
    receipt.confidence = task.verdict ? task.verdict.confidence : null;
    receipt.fee = task.payout ? task.payout.fee : "0";
    this.deps.budget.conclude(price, task.state === "Settled");
    return receipt;
  }

  /** Take the bounty back from a task nobody did, once its deadline has passed. */
  async reclaim(receipt: Receipt): Promise<Receipt> {
    if (receipt.taskId === null) return receipt;
    await this.deps.chain.reclaim(receipt.taskId);
    return this.collect(receipt);
  }
}
