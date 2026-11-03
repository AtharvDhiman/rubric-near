/**
 * A hard spending cap, and the receipts for what was bought with it.
 *
 * The cap is enforced here, in code, before any transaction is built: an agent cannot "decide" to
 * go over it. Money is in yoctoNEAR as bigint throughout; there is no floating point anywhere.
 */

import { formatNear } from "@rubric-near/shared";

export class BudgetExceeded extends Error {
  constructor(readonly wanted: bigint, readonly remaining: bigint) {
    super(`that would spend ${formatNear(wanted)} NEAR, and only ${formatNear(remaining)} NEAR of the budget is left`);
    this.name = "BudgetExceeded";
  }
}

export class Budget {
  /** Reserved for tasks that are sealed and not yet decided. */
  private reserved = 0n;
  /** Paid out to workers (the bounty, including the protocol's fee). */
  private spent = 0n;

  constructor(readonly cap: bigint) {
    if (cap <= 0n) throw new Error("a budget must be positive");
  }

  get remaining(): bigint {
    return this.cap - this.reserved - this.spent;
  }

  canAfford(amount: bigint): boolean {
    return amount > 0n && amount <= this.remaining;
  }

  /** Set money aside for a task about to be sealed. Throws, and changes nothing, if it does not fit. */
  reserve(amount: bigint): void {
    if (amount <= 0n) throw new Error("an amount must be positive");
    if (amount > this.remaining) throw new BudgetExceeded(amount, this.remaining);
    this.reserved += amount;
  }

  /** The task ended. `paid` means the bounty went to a worker; otherwise it came back and is free again. */
  conclude(amount: bigint, paid: boolean): void {
    if (amount > this.reserved) throw new Error("concluding more than was reserved");
    this.reserved -= amount;
    if (paid) this.spent += amount;
  }

  snapshot(): { cap: string; reserved: string; spent: string; remaining: string } {
    return {
      cap: this.cap.toString(),
      reserved: this.reserved.toString(),
      spent: this.spent.toString(),
      remaining: this.remaining.toString(),
    };
  }
}

export type ReceiptOutcome = "pending" | "approved" | "rejected" | "reclaimed" | "walked_away";

/** What was bought, from whom, for how much, and whether it passed. */
export interface Receipt {
  /** The on-chain task id, or null if the agent walked away before sealing anything. */
  taskId: string | null;
  title: string;
  /** The seller who delivered, once there is one. */
  seller: string | null;
  /** yoctoNEAR the poster committed. */
  price: string;
  /** yoctoNEAR of the protocol's 2% that came out of the price (zero unless approved). */
  fee: string;
  outcome: ReceiptOutcome;
  confidence: number | null;
  clausesHash: string | null;
  sealTx: string | null;
  note: string;
  at: string;
}

export class ReceiptBook {
  readonly receipts: Receipt[] = [];

  add(receipt: Receipt): Receipt {
    this.receipts.push(receipt);
    return receipt;
  }

  /** A plain-text table, for a terminal. */
  table(): string {
    const rows = this.receipts.map((r) => [
      r.taskId ?? "-",
      r.title.length > 28 ? `${r.title.slice(0, 27)}…` : r.title,
      r.seller ?? "-",
      `${formatNear(r.price)} NEAR`,
      r.outcome.toUpperCase().replace("_", " "),
      r.confidence === null ? "-" : String(r.confidence),
    ]);
    const header = ["TASK", "WHAT WAS BOUGHT", "SELLER", "PRICE", "RESULT", "CONF"];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
    return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
  }

  toJSON(): Receipt[] {
    return this.receipts;
  }
}
