/**
 * The whole demo on a local sandbox: no keys, no testnet funds, and no network after the first run
 * (which downloads the sandbox binary).
 *
 *   npm run demo:sandbox
 *
 * It starts a local NEAR node, deploys the committed contract, and runs the four jobs: one done
 * well and paid, one priced beyond the poster's budget (it walks away), one done carelessly and
 * refunded, and one nobody takes (the poster reclaims it). Then it checks the outcome against the
 * chain. The judge is the offline mock unless you set JUDGE_MODE=near-ai and NEAR_AI_API_KEY.
 */

import { NearAiModel } from "@rubric-near/judge";
import { exportSnapshot, report, runScenario } from "@rubric-near/demo";
import { WASM_PATH, startSandbox } from "./sandbox.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} (see .env.example)`);
  return v;
}

async function main() {
  const model =
    process.env.JUDGE_MODE === "near-ai"
      ? new NearAiModel({ apiKey: required("NEAR_AI_API_KEY"), ...(process.env.NEAR_AI_MODEL ? { model: process.env.NEAR_AI_MODEL } : {}) })
      : undefined;

  console.log("starting a local NEAR sandbox (the first run downloads its binary)...");
  const sandbox = await startSandbox();
  try {
    const { escrow, poster, worker, judge } = sandbox.accounts;
    console.log(`sandbox chain at ${sandbox.rpcUrl}; contract ${escrow.accountId} deployed from ${WASM_PATH}`);

    const result = await runScenario({
      contractId: sandbox.contractId,
      rpcUrl: sandbox.rpcUrl,
      poster: { account: poster.accountId, secretKey: poster.secretKey },
      worker: { account: worker.accountId, secretKey: worker.secretKey },
      judge: { account: judge.accountId, secretKey: judge.secretKey },
      ...(model ? { model } : {}),
      // Real time passes on the sandbox too, so the untaken job's window is kept short.
      reclaimWaitSeconds: Number(process.env.RECLAIM_WAIT ?? 8),
      log: (line) => console.log(line),
    });

    const ok = report(result);
    await exportSnapshot(result, process.env.EXPORT_SNAPSHOT);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await sandbox.stop();
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
