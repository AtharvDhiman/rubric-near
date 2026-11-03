/**
 * Run the scenario against a contract on NEAR TESTNET, with accounts you already have.
 *
 *   RUBRIC_CONTRACT=escrow.testnet POSTER_ACCOUNT=... WORKER_ACCOUNT=... JUDGE_ACCOUNT=... npm run demo:testnet -w demo
 *
 * Each account's key is read from <NAME>_PRIVATE_KEY, or from the NEAR CLI's credentials file
 * (~/.near-credentials/testnet/<account>.json, or NEAR_CREDENTIALS_DIR). Set JUDGE_MODE=near-ai and
 * NEAR_AI_API_KEY to use a real model; the default is the offline mock.
 */

import { loadSecretKey } from "@rubric-near/shared";
import { NearAiModel } from "@rubric-near/judge";
import { runScenario, type Party } from "./scenario.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} (see .env.example)`);
  return v;
}

function party(accountVar: string, keyVar: string): Party {
  const account = required(accountVar);
  return { account, secretKey: loadSecretKey(account, { envVar: keyVar }) };
}

async function main() {
  const model =
    process.env.JUDGE_MODE === "near-ai"
      ? new NearAiModel({ apiKey: required("NEAR_AI_API_KEY"), ...(process.env.NEAR_AI_MODEL ? { model: process.env.NEAR_AI_MODEL } : {}) })
      : undefined;

  const result = await runScenario({
    contractId: required("RUBRIC_CONTRACT"),
    ...(process.env.NEAR_RPC_URL ? { rpcUrl: process.env.NEAR_RPC_URL } : {}),
    poster: party("POSTER_ACCOUNT", "POSTER_PRIVATE_KEY"),
    worker: party("WORKER_ACCOUNT", "WORKER_PRIVATE_KEY"),
    judge: party("JUDGE_ACCOUNT", "JUDGE_PRIVATE_KEY"),
    ...(model ? { model } : {}),
    reclaimWaitSeconds: Number(process.env.RECLAIM_WAIT ?? 25),
    log: (line) => console.log(line),
  });

  console.log("\nRECEIPTS\n" + result.table);
  console.log("\nCHECKS (against the chain, not against what the agents said)");
  for (const c of result.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
  console.log(`\n${result.ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
