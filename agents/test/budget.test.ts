import { describe, expect, it } from "vitest";
import { Budget, BudgetExceeded, ReceiptBook, type Receipt } from "../src/budget.js";
import { NEAR } from "@rubric-near/shared";

describe("Budget", () => {
  it("starts with everything free", () => {
    const b = new Budget(5n * NEAR);
    expect(b.remaining).toBe(5n * NEAR);
    expect(b.snapshot()).toEqual({ cap: (5n * NEAR).toString(), reserved: "0", spent: "0", remaining: (5n * NEAR).toString() });
  });

  it("refuses a non-positive cap", () => {
    expect(() => new Budget(0n)).toThrow(/must be positive/);
    expect(() => new Budget(-1n)).toThrow(/must be positive/);
  });

  it("reserving takes money out of what is free", () => {
    const b = new Budget(5n * NEAR);
    b.reserve(2n * NEAR);
    expect(b.remaining).toBe(3n * NEAR);
  });

  it("refuses to go over the cap, and changes nothing when it refuses", () => {
    const b = new Budget(5n * NEAR);
    b.reserve(4n * NEAR);
    expect(() => b.reserve(NEAR + 1n)).toThrow(BudgetExceeded);
    expect(b.remaining).toBe(NEAR);
    b.reserve(NEAR); // exactly what is left is allowed
    expect(b.remaining).toBe(0n);
  });

  it("explains how far over it would have gone, in NEAR", () => {
    const b = new Budget(NEAR);
    expect(() => b.reserve(2n * NEAR)).toThrow(/would spend 2 NEAR, and only 1 NEAR of the budget is left/);
  });

  it("refuses zero and negative amounts", () => {
    const b = new Budget(NEAR);
    expect(() => b.reserve(0n)).toThrow(/must be positive/);
    expect(() => b.reserve(-1n)).toThrow(/must be positive/);
    expect(b.canAfford(0n)).toBe(false);
  });

  it("a task that paid out is spent for good", () => {
    const b = new Budget(5n * NEAR);
    b.reserve(2n * NEAR);
    b.conclude(2n * NEAR, true);
    expect(b.remaining).toBe(3n * NEAR);
    expect(b.snapshot().spent).toBe((2n * NEAR).toString());
    expect(b.snapshot().reserved).toBe("0");
  });

  it("a task that was refunded frees its money again", () => {
    const b = new Budget(5n * NEAR);
    b.reserve(2n * NEAR);
    b.conclude(2n * NEAR, false);
    expect(b.remaining).toBe(5n * NEAR);
  });

  it("cannot conclude more than was reserved", () => {
    const b = new Budget(5n * NEAR);
    b.reserve(NEAR);
    expect(() => b.conclude(2n * NEAR, true)).toThrow(/more than was reserved/);
  });

  it("never lets reserved plus spent exceed the cap, over many random operations", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let round = 0; round < 200; round++) {
      const b = new Budget(10n * NEAR);
      const open: bigint[] = [];
      for (let i = 0; i < 40; i++) {
        if (rnd() < 0.6) {
          const amount = BigInt(Math.floor(rnd() * 4_000_000)) * 1_000_000_000_000_000_000n + 1n;
          try {
            b.reserve(amount);
            open.push(amount);
          } catch (e) {
            expect(e).toBeInstanceOf(BudgetExceeded);
          }
        } else if (open.length > 0) {
          b.conclude(open.pop()!, rnd() < 0.5);
        }
        const s = b.snapshot();
        expect(BigInt(s.reserved) + BigInt(s.spent)).toBeLessThanOrEqual(b.cap);
        expect(b.remaining).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});

describe("ReceiptBook", () => {
  const receipt = (over: Partial<Receipt> = {}): Receipt => ({
    taskId: "0",
    title: "Fix the docs",
    seller: "worker.testnet",
    price: (NEAR / 2n).toString(),
    fee: "0",
    outcome: "approved",
    confidence: 92,
    clausesHash: "a".repeat(64),
    sealTx: "TX",
    note: "n",
    at: "2026-11-04T10:00:00.000Z",
    ...over,
  });

  it("keeps receipts in order and returns what it was given", () => {
    const book = new ReceiptBook();
    const r = book.add(receipt());
    expect(r.taskId).toBe("0");
    expect(book.toJSON()).toHaveLength(1);
  });

  it("prints a table with the task, what was bought, the seller, the price and the result", () => {
    const book = new ReceiptBook();
    book.add(receipt());
    book.add(receipt({ taskId: null, title: "An expensive job that nobody could afford here", seller: null, price: "0", outcome: "walked_away", confidence: null }));
    const table = book.table();
    expect(table).toContain("WHAT WAS BOUGHT");
    expect(table).toContain("worker.testnet");
    expect(table).toContain("0.5 NEAR");
    expect(table).toContain("APPROVED");
    expect(table).toContain("WALKED AWAY");
    expect(table).toContain("…"); // a long title is truncated
    expect(table.split("\n")).toHaveLength(4);
  });

  it("aligns the columns", () => {
    const book = new ReceiptBook();
    book.add(receipt());
    book.add(receipt({ taskId: "10", seller: "w.testnet" }));
    const lines = book.table().split("\n");
    const col = lines[0]!.indexOf("WHAT");
    expect(lines.slice(2).every((l) => l.length > col)).toBe(true);
  });

  it("prints an empty book as just a header", () => {
    expect(new ReceiptBook().table().split("\n")).toHaveLength(2);
  });
});
