/**
 * The contract's JSON, as it comes back from a view call. Amounts and timestamps are decimal
 * STRINGS (near-sdk's U128 and U64), never numbers: a yoctoNEAR amount does not fit a double.
 * Convert with BigInt at the point of use.
 */

export type TaskState = "Open" | "Submitted" | "Settled" | "Refunded";
export type PayoutStatus = "Pending" | "Paid" | "Failed";

export interface Verdict {
  approved: boolean;
  confidence: number;
  /** SHA-256 (hex) of the judge's full public reasoning. */
  reasoning_hash: string;
  decided_ns: string;
}

export interface Payout {
  to: string;
  /** yoctoNEAR. */
  amount: string;
  fee: string;
  status: PayoutStatus;
}

export interface Task {
  id: string;
  poster: string;
  title: string;
  clauses: string[];
  /** SHA-256 (hex) of the canonical rubric, computed by the contract. */
  clauses_hash: string;
  /** yoctoNEAR escrowed for this task. */
  bounty: string;
  created_ns: string;
  deadline_ns: string;
  state: TaskState;
  worker: string | null;
  submission_hash: string | null;
  submitted_ns: string | null;
  verdict: Verdict | null;
  payout: Payout | null;
}

export interface Config {
  owner_id: string;
  judge_id: string;
  fee_bps: number;
  min_confidence: number;
  max_bounty: string;
  verdict_grace_ns: string;
  tasks_total: string;
}

export interface Accounting {
  escrow_held: string;
  fees_accrued: string;
  contract_balance: string;
}

/** One NEAR in yoctoNEAR. */
export const NEAR = 1_000_000_000_000_000_000_000_000n;

/** Format yoctoNEAR as NEAR for display, trimming trailing zeros: "0.98", "1", "0.0021". */
export function formatNear(yocto: string | bigint): string {
  const v = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = v / NEAR;
  const frac = (v % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a decimal NEAR amount ("0.5") to yoctoNEAR exactly, with no floating point. */
export function parseNear(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!m) throw new Error(`not a NEAR amount: ${JSON.stringify(text)}`);
  return BigInt(m[1]!) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}
