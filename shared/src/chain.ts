/**
 * A small client for the Rubric escrow contract.
 *
 * Views need no key. Anything that changes state goes through `RubricSigner`, which signs with
 * one account's key. The judge, the agents and the dashboard all use this, so the contract is
 * called one way, with one set of gas numbers and one way of reading a failure.
 *
 * Keys are only ever held in memory here. They come from the caller (an environment variable or a
 * local credentials file); nothing in this module writes one anywhere or prints one.
 */

import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { KeyPairString } from "@near-js/crypto";
import type { Accounting, Config, Task } from "./types.js";

export const TESTNET_RPC = "https://test.rpc.fastnear.com";

/** 1 teragas. */
const TGAS = 1_000_000_000_000n;
export const GAS = {
  seal: 60n * TGAS,
  submit: 30n * TGAS,
  /** settle sends a transfer and schedules a callback, so it needs room for both. */
  settle: 100n * TGAS,
  reclaim: 100n * TGAS,
  retryPayout: 100n * TGAS,
} as const;

/** What a state-changing call returns. */
export interface TxResult<T = unknown> {
  txHash: string;
  /** The call's return value, parsed from JSON, or undefined if it returns nothing. */
  value: T | undefined;
}

/** A call the contract (or the chain) refused. `message` is the contract's own panic text when there is one. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly txHash?: string
  ) {
    super(message);
    this.name = "ChainError";
  }
}

/** Pull the contract's panic message out of whatever shape a failed outcome or thrown error has. */
export function failureMessage(failure: unknown): string {
  // An Error's message is not an enumerable property, so JSON.stringify(error) is "{}" and would
  // throw the contract's panic text away. Read the message (and any nested cause) explicitly.
  let text: string;
  if (typeof failure === "string") text = failure;
  else if (failure instanceof Error) text = [failure.message, failure.cause ? safeStringify(failure.cause) : ""].join(" ");
  else text = safeStringify(failure);
  const panicked = /Smart contract panicked: ([^"\\]+)/.exec(text);
  if (panicked) return panicked[1]!.trim();
  const execution = /"ExecutionError":"([^"]+)"/.exec(text);
  if (execution) return execution[1]!;
  const lack = /LackBalanceForState|NotEnoughBalance|Exceeded the prepaid gas|doesn't have enough balance/.exec(text);
  if (lack) return lack[0]!;
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

/** The execution status of a transaction outcome, in the loose shape the RPC returns. */
type OutcomeStatus = string | { SuccessValue?: string; Failure?: unknown };

function decodeSuccess<T>(status: OutcomeStatus): T | undefined {
  if (typeof status === "object" && status.SuccessValue) {
    const text = Buffer.from(status.SuccessValue, "base64").toString("utf8");
    return text.length > 0 ? (JSON.parse(text) as T) : undefined;
  }
  return undefined;
}

export class RubricChain {
  readonly provider: JsonRpcProvider;

  constructor(
    readonly contractId: string,
    rpcUrl: string = process.env.NEAR_RPC_URL ?? TESTNET_RPC
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    let result: T | undefined;
    try {
      // The provider constrains its generic to JSON-serialisable shapes; the contract's return
      // types are known here, so cast at this one boundary.
      result = (await this.provider.callFunction<object>(this.contractId, method, args)) as T | undefined;
    } catch (error) {
      throw new ChainError(`view ${method} failed: ${failureMessage(error)}`);
    }
    if (result === undefined) throw new ChainError(`view ${method} returned nothing`);
    return result;
  }

  /** One task, or null if there is no task with that id. */
  async getTask(id: string | number | bigint): Promise<Task | null> {
    const task = await this.provider.callFunction<object>(this.contractId, "get_task", { task_id: String(id) });
    return (task as Task | null | undefined) ?? null;
  }

  /** Tasks from `from`, oldest first, at most 50 per call. */
  getTasks(from = 0, limit = 50): Promise<Task[]> {
    return this.view<Task[]>("get_tasks", { from_index: String(from), limit: String(limit) });
  }

  /** Every task, paging as needed. */
  async getAllTasks(): Promise<Task[]> {
    const total = Number((await this.getConfig()).tasks_total);
    const out: Task[] = [];
    for (let from = 0; from < total; from += 50) out.push(...(await this.getTasks(from, 50)));
    return out;
  }

  getConfig(): Promise<Config> {
    return this.view<Config>("get_config");
  }

  getAccounting(): Promise<Accounting> {
    return this.view<Accounting>("get_accounting");
  }

  /** The hash the contract would seal a rubric under. Pure; also checks the contract's rubric rules. */
  computeClausesHash(title: string, clauses: string[]): Promise<string> {
    return this.view<string>("compute_clauses_hash", { title, clauses });
  }

  /** Act as one account. `secretKey` is an "ed25519:..." string and is kept in memory only. */
  as(accountId: string, secretKey: string): RubricSigner {
    return new RubricSigner(this, accountId, secretKey as KeyPairString);
  }

  /** Poll until a task's payout has a final status (Paid or Failed), or the timeout passes. */
  async waitForPayout(taskId: string | number | bigint, timeoutMs = 60_000, intervalMs = 2_000): Promise<Task> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await this.getTask(taskId);
      if (!task) throw new ChainError(`no such task: ${taskId}`);
      if (task.payout && task.payout.status !== "Pending") return task;
      if (Date.now() > deadline) return task;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export class RubricSigner {
  readonly account: Account;

  constructor(
    private readonly chain: RubricChain,
    readonly accountId: string,
    secretKey: KeyPairString
  ) {
    this.account = new Account(accountId, chain.provider, KeyPairSigner.fromSecretKey(secretKey));
  }

  private async call<T>(
    methodName: string,
    args: Record<string, unknown>,
    gas: bigint,
    deposit: bigint = 0n
  ): Promise<TxResult<T>> {
    let outcome;
    try {
      outcome = await this.account.callFunctionRaw({
        contractId: this.chain.contractId,
        methodName,
        args,
        gas,
        deposit,
        // Wait for the transaction and its receipts to execute, so the return value is known.
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
    } catch (error) {
      throw new ChainError(`${methodName} was refused: ${failureMessage(error)}`);
    }
    const txHash = outcome.transaction.hash as string;
    const status = outcome.status as OutcomeStatus;
    if (typeof status === "object" && status.Failure !== undefined) {
      throw new ChainError(`${methodName} was refused: ${failureMessage(status.Failure)}`, txHash);
    }
    return { txHash, value: decodeSuccess<T>(status) };
  }

  /**
   * Seal a task. `deposit` must cover the bounty plus the task's storage; whatever is attached
   * beyond that is refunded to this account by the contract. Returns the new task id.
   */
  async seal(input: {
    title: string;
    clauses: string[];
    bounty: bigint;
    deadlineNs: bigint;
    deposit: bigint;
  }): Promise<TxResult<string> & { taskId: string }> {
    const result = await this.call<string>(
      "seal",
      {
        title: input.title,
        clauses: input.clauses,
        bounty: input.bounty.toString(),
        deadline_ns: input.deadlineNs.toString(),
      },
      GAS.seal,
      input.deposit
    );
    if (result.value === undefined) throw new ChainError("seal returned no task id", result.txHash);
    return { ...result, taskId: result.value };
  }

  submit(taskId: string | number | bigint, submissionHash: string): Promise<TxResult<void>> {
    return this.call<void>("submit", { task_id: String(taskId), submission_hash: submissionHash }, GAS.submit);
  }

  /** Judge only. */
  settle(
    taskId: string | number | bigint,
    verdict: { approved: boolean; confidence: number; reasoningHash: string }
  ): Promise<TxResult<void>> {
    return this.call<void>(
      "settle",
      {
        task_id: String(taskId),
        approved: verdict.approved,
        confidence: verdict.confidence,
        reasoning_hash: verdict.reasoningHash,
      },
      GAS.settle
    );
  }

  reclaim(taskId: string | number | bigint): Promise<TxResult<void>> {
    return this.call<void>("reclaim", { task_id: String(taskId) }, GAS.reclaim);
  }

  retryPayout(taskId: string | number | bigint): Promise<TxResult<void>> {
    return this.call<void>("retry_payout", { task_id: String(taskId) }, GAS.retryPayout);
  }
}

/**
 * A generous attachment for a task's storage. The contract measures the real cost and refunds the
 * excess, so over-estimating costs nothing but a moment's float; under-estimating makes the seal fail.
 */
export function storageAllowance(title: string, clauses: string[]): bigint {
  const bytes = Buffer.byteLength(title, "utf8") + clauses.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
  // Two bytes of storage per text byte plus a fixed margin for the task's other fields.
  return BigInt(bytes * 2 + 2_500) * 10_000_000_000_000_000_000n;
}
