/**
 * Deploy the committed contract to NEAR TESTNET, and prove it landed intact.
 *
 *   ESCROW_ACCOUNT=escrow.testnet OWNER_ACCOUNT=owner.testnet JUDGE_ACCOUNT=judge.testnet npm run deploy:testnet
 *
 * It uploads the exact bytes of contract/res/rubric_near.wasm. It does not build anything: a build
 * step can quietly pick up a stale file, and then what is deployed is not what the repository says
 * (that happened once while this was written, which is why this script exists). After deploying it
 * reads the code hash back from the chain and fails unless it equals the hash of the file.
 *
 * The escrow account must be new (no contract on it) and hold a few NEAR; the owner and the judge
 * must be two different accounts. The escrow account's key is read from ESCROW_PRIVATE_KEY, or from
 * the NEAR CLI's credentials file (~/.near-credentials/testnet/<account>.json, or
 * NEAR_CREDENTIALS_DIR). Testnet only.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { KeyPairString } from "@near-js/crypto";
import { RubricChain, TESTNET_RPC, failureMessage, formatNear, loadSecretKey, parseNear } from "@rubric-near/shared";
import { NO_CODE, nearCodeHash } from "./codehash.js";

const TGAS = 1_000_000_000_000n;

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} (see .env.example)`);
  return v;
}

async function main() {
  const escrowId = required("ESCROW_ACCOUNT");
  const ownerId = required("OWNER_ACCOUNT");
  const judgeId = required("JUDGE_ACCOUNT");
  if (ownerId === judgeId) throw new Error("the owner and the judge must be different accounts");

  const wasmPath = process.env.RUBRIC_WASM?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "../../contract/res/rubric_near.wasm");
  const wasm = await readFile(wasmPath);
  const expected = nearCodeHash(wasm);
  console.log(`contract file: ${wasmPath}`);
  console.log(`  ${wasm.length} bytes, code hash ${expected}`);

  const rpcUrl = process.env.NEAR_RPC_URL?.trim() || TESTNET_RPC;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const escrow = new Account(escrowId, provider, KeyPairSigner.fromSecretKey(loadSecretKey(escrowId, { envVar: "ESCROW_PRIVATE_KEY" }) as KeyPairString));

  const before = await provider.viewAccount(escrowId);
  if (before.code_hash !== NO_CODE) {
    throw new Error(`${escrowId} already has a contract (code hash ${before.code_hash}); deploy to a new account`);
  }
  console.log(`${escrowId} is empty, with ${formatNear(before.amount)} NEAR`);

  const maxBounty = parseNear(process.env.MAX_BOUNTY ?? "5");
  const graceSeconds = Number(process.env.VERDICT_GRACE_SECONDS ?? 604_800);

  console.log("deploying...");
  const deployed = await escrow.deployContract(wasm);
  if (typeof deployed.status === "object" && "Failure" in deployed.status) throw new Error(`the deploy failed: ${failureMessage(deployed.status.Failure)}`);

  console.log("initialising...");
  const init = await escrow.callFunctionRaw({
    contractId: escrowId,
    methodName: "new",
    args: { owner_id: ownerId, judge_id: judgeId, max_bounty: maxBounty.toString(), verdict_grace_seconds: graceSeconds },
    gas: 30n * TGAS,
    deposit: 0n,
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  if (typeof init.status === "object" && "Failure" in init.status) throw new Error(`the init call failed: ${failureMessage(init.status.Failure)}`);

  // Read it all back from the chain; do not trust that the calls above did what they said.
  const after = await provider.viewAccount(escrowId);
  const config = await new RubricChain(escrowId, rpcUrl).getConfig();
  const problems: string[] = [];
  if (after.code_hash !== expected) problems.push(`the code on-chain is ${after.code_hash}, not ${expected}`);
  if (config.owner_id !== ownerId) problems.push(`owner is ${config.owner_id}`);
  if (config.judge_id !== judgeId) problems.push(`judge is ${config.judge_id}`);
  if (config.max_bounty !== maxBounty.toString()) problems.push(`bounty cap is ${config.max_bounty}`);
  if (config.verdict_grace_ns !== (BigInt(graceSeconds) * 1_000_000_000n).toString()) problems.push(`grace is ${config.verdict_grace_ns} ns`);
  if (problems.length > 0) throw new Error(`the deployment does not match what was asked for: ${problems.join("; ")}`);

  console.log(`\nDEPLOYED AND VERIFIED: ${escrowId}`);
  console.log(`  code hash on-chain = ${after.code_hash} (equal to the file's)`);
  console.log(`  owner ${config.owner_id}, judge ${config.judge_id}, fee ${config.fee_bps / 100}%, cap ${formatNear(config.max_bounty)} NEAR`);
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
