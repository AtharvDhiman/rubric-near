/**
 * A throwaway NEAR chain on this machine, with the committed contract deployed to it.
 *
 * `near-sandbox` runs a real nearcore node in sandbox mode: the same runtime as testnet, with
 * instant funding and no faucet. So what runs here is the real contract on a real runtime, with
 * real storage staking, real gas and real cross-contract callbacks. Nothing leaves the machine
 * except, on the very first run, the download of the sandbox binary.
 *
 * Linux, macOS and WSL only: the sandbox binary is not built for native Windows.
 *
 * This package is deliberately not part of the root npm workspaces, so that nothing about the
 * sandbox can break `npm install && npm test` for someone who only wants the unit tests. It imports
 * the other packages (`@rubric-near/*`) from the root's node_modules, so run the root
 * `npm install` first.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox as NearSandbox } from "near-sandbox";
import { failureMessage, parseNear } from "@rubric-near/shared";

/**
 * The contract as committed: contract/res/rubric_near.wasm (see the README beside it for its hash).
 * Set RUBRIC_WASM to run the same demo or tests against a different build.
 */
export const WASM_PATH = process.env.RUBRIC_WASM?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "../../contract/res/rubric_near.wasm");

const TGAS = 1_000_000_000_000n;

/**
 * The nearcore version the sandbox runs. near-sandbox's own default (2.13.4) is too old for this
 * contract: near-sdk 5.30 imports host functions (gas keys, universal state init) that appear in
 * 2.14.0 and later, and an older runtime refuses the wasm with "Link Error: unknown or invalid
 * import". Override with NEAR_SANDBOX_VERSION.
 */
export const SANDBOX_VERSION = "2.14.0";

/** An account on the sandbox, with its key held in memory for this run only. */
export interface SandboxAccount {
  accountId: string;
  /** "ed25519:..." */
  secretKey: string;
  account: Account;
}

export interface Sandbox {
  rpcUrl: string;
  provider: JsonRpcProvider;
  contractId: string;
  accounts: {
    escrow: SandboxAccount;
    owner: SandboxAccount;
    judge: SandboxAccount;
    poster: SandboxAccount;
    worker: SandboxAccount;
  };
  /** Create another account on the sandbox, funded with `balance` NEAR. */
  createAccount(name: string, balance?: string): Promise<SandboxAccount>;
  /** Create `<name>.<parent>`, a sub-account only its parent can create or delete. */
  createSubAccount(parent: SandboxAccount, name: string, balance?: string): Promise<SandboxAccount>;
  stop(): Promise<void>;
}

export interface SandboxOptions {
  /** The contract's bounty cap in NEAR. Default 5, as on the testnet deployment. */
  maxBounty?: string;
  /** How long after a deadline a submitted-but-unjudged task waits before the poster may reclaim it. */
  graceSeconds?: number;
  /** What each account starts with, in NEAR. Default 50. */
  balance?: string;
  /**
   * What the contract's own account starts with, in NEAR. Defaults to `balance`. The tests give it
   * only enough to hold its code, so that a contract that spent money it owed could not hide behind
   * a large starting balance.
   */
  escrowBalance?: string;
}

/** Throw the contract's own message if a transaction (or any receipt it spawned) failed. */
export function expectOk(what: string, outcome: { status: unknown; receipts_outcome?: Array<{ outcome: { status: unknown } }> }): void {
  const failures = [outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome.status)].filter(
    (s) => typeof s === "object" && s !== null && "Failure" in s
  );
  if (failures.length > 0) throw new Error(`${what} failed: ${failureMessage(failures[0])}`);
}

/**
 * near-sandbox downloads its binary into a temp directory and then `rename`s it into
 * node_modules. When the system temp directory is a different filesystem (a tmpfs /tmp, which is
 * the default on many Linux machines) that rename fails with EXDEV and the sandbox never starts.
 * Keeping the temp directory inside this package puts both on one filesystem.
 */
async function useLocalTempDir(): Promise<void> {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp");
  await mkdir(dir, { recursive: true });
  process.env.TMPDIR = dir;
}

export async function startSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  await useLocalTempDir();
  const node = await NearSandbox.start({ version: process.env.NEAR_SANDBOX_VERSION?.trim() || SANDBOX_VERSION });
  try {
    const provider = new JsonRpcProvider({ url: node.rpcUrl });
    // The sandbox's built-in funded account. Its key is published in the near-sandbox package, which
    // is fine: this chain exists only on this machine, for this run.
    const funder = new Account(DEFAULT_ACCOUNT_ID, provider, KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY as KeyPairString));
    const initialBalance = options.balance ?? "50";

    const make = async (creator: Account, accountId: string, balance: string): Promise<SandboxAccount> => {
      const key = KeyPair.fromRandom("ed25519");
      expectOk(`creating ${accountId}`, await creator.createAccount(accountId, key.getPublicKey(), parseNear(balance)));
      const secretKey = key.toString();
      return { accountId, secretKey, account: new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as KeyPairString)) };
    };
    const createAccount = (name: string, balance = initialBalance) => make(funder, `${name}.${DEFAULT_ACCOUNT_ID}`, balance);
    const createSubAccount = (parent: SandboxAccount, name: string, balance = initialBalance) =>
      make(parent.account, `${name}.${parent.accountId}`, balance);

    // One at a time: each is a transaction from the same key, and its nonce must advance in order.
    const escrow = await createAccount("escrow", options.escrowBalance ?? initialBalance);
    const owner = await createAccount("owner");
    const judge = await createAccount("judge");
    const poster = await createAccount("poster");
    const worker = await createAccount("worker");

    expectOk("deploying the contract", await escrow.account.deployContract(await readFile(WASM_PATH)));
    expectOk(
      "initialising the contract",
      await escrow.account.callFunctionRaw({
        contractId: escrow.accountId,
        methodName: "new",
        args: {
          owner_id: owner.accountId,
          judge_id: judge.accountId,
          max_bounty: parseNear(options.maxBounty ?? "5").toString(),
          verdict_grace_seconds: options.graceSeconds ?? 604_800,
        },
        gas: 30n * TGAS,
        deposit: 0n,
        waitUntil: "EXECUTED_OPTIMISTIC",
      })
    );

    return {
      rpcUrl: node.rpcUrl,
      provider,
      contractId: escrow.accountId,
      accounts: { escrow, owner, judge, poster, worker },
      createAccount,
      createSubAccount,
      stop: () => node.tearDown(),
    };
  } catch (error) {
    await node.tearDown().catch(() => {});
    throw error;
  }
}
