import { RubricChain, failureMessage, hashSubmission, parseNear, storageAllowance, type RubricSigner } from "@rubric-near/shared";
import type { Sandbox, SandboxAccount } from "../src/sandbox.js";

const TGAS = 1_000_000_000_000n;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const near = parseNear;
/** Any valid 64-hex hash will do where the test does not care what it commits to. */
export const hashOf = (text: string) => hashSubmission(text);

export interface Harness {
  sb: Sandbox;
  chain: RubricChain;
  signer(account: SandboxAccount): RubricSigner;
}

export function harness(sb: Sandbox): Harness {
  const chain = new RubricChain(sb.contractId, sb.rpcUrl);
  return { sb, chain, signer: (a) => chain.as(a.accountId, a.secretKey) };
}

/** An account's total balance, in yoctoNEAR. */
export async function total(a: SandboxAccount): Promise<bigint> {
  return (await a.account.getState()).balance.total;
}

/**
 * An account's balance once nothing more is arriving. A payout or a refund is a receipt that can
 * land a block after the call that caused it, so wait until the balance stops moving.
 */
export async function settledBalance(a: SandboxAccount): Promise<bigint> {
  let previous = await total(a);
  for (let i = 0; i < 20; i++) {
    await sleep(1_200);
    const current = await total(a);
    if (current === previous) return current;
    previous = current;
  }
  throw new Error(`the balance of ${a.accountId} never settled`);
}

/** The result of a call that may be refused: whether it failed, the contract's own message, and its logs. */
export interface RawResult {
  failed: boolean;
  message: string;
  logs: string[];
}

/** Call any method as any account, without assuming it succeeds. For methods the typed client does not wrap. */
export async function rawCall(from: SandboxAccount, contractId: string, methodName: string, args: object, deposit = 0n): Promise<RawResult> {
  try {
    const outcome = await from.account.callFunctionRaw({
      contractId,
      methodName,
      args,
      gas: 100n * TGAS,
      deposit,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    const statuses = [outcome.status, ...outcome.receipts_outcome.map((r) => r.outcome.status)];
    const failure = statuses.find((s) => typeof s === "object" && s !== null && "Failure" in s);
    return {
      failed: failure !== undefined,
      message: failure === undefined ? "" : failureMessage(failure),
      logs: outcome.receipts_outcome.flatMap((r) => r.outcome.logs),
    };
  } catch (error) {
    return { failed: true, message: failureMessage(error), logs: [] };
  }
}

export interface SealOptions {
  title?: string;
  clauses?: string[];
  /** In NEAR. */
  bounty?: string;
  windowSeconds?: number;
  /** Deposit attached on top of the bounty and the storage allowance, in yoctoNEAR. */
  extra?: bigint;
}

/** Seal a task as `who` and return its id. */
export async function seal(h: Harness, who: SandboxAccount, options: SealOptions = {}): Promise<string> {
  const title = options.title ?? "Write the install steps";
  const clauses = options.clauses ?? ['The submission contains "npm install".', 'The submission contains "troubleshooting".'];
  const bounty = near(options.bounty ?? "0.1");
  const deadlineNs = BigInt(Date.now()) * 1_000_000n + BigInt(options.windowSeconds ?? 3_600) * 1_000_000_000n;
  const sealed = await h.signer(who).seal({
    title,
    clauses,
    bounty,
    deadlineNs,
    deposit: bounty + storageAllowance(title, clauses) + (options.extra ?? 0n),
  });
  return sealed.taskId;
}

/**
 * The contract must always be able to pay what it owes: its balance covers the escrow, the fees it
 * has accrued, and the storage it has to keep staked (which includes its own code). A contract that
 * quietly spent its storage reserve on payouts would fail here.
 */
export async function owedAndHeld(h: Harness): Promise<{ owed: bigint; balance: bigint; staked: bigint }> {
  const accounting = await h.chain.getAccounting();
  const state = await h.sb.accounts.escrow.account.getState();
  return {
    owed: BigInt(accounting.escrow_held) + BigInt(accounting.fees_accrued),
    balance: state.balance.total,
    staked: state.balance.usedOnStorage,
  };
}
