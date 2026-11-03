/**
 * Reading the judge's configuration from the environment, and building it.
 *
 * Everything secret comes from the environment or a local credentials file, never from a flag
 * (a flag lands in shell history and process listings). Nothing here prints a key.
 */

import { RubricChain, loadSecretKey } from "@rubric-near/shared";
import { createJudge } from "./service.js";
import { MockModel } from "./mock.js";
import { NearAiModel, DEFAULT_NEAR_AI_MODEL } from "./near-ai.js";
import type { JudgeModel } from "./models.js";
import { FileStore, type VerdictStore } from "./store.js";
import { confidenceThreshold } from "./verdict.js";
import type { ServerInfo } from "./server.js";

export interface JudgeConfig {
  mode: "mock" | "near-ai";
  contractId: string;
  judgeAccount: string;
  rpcUrl: string | undefined;
  port: number;
  verdictDir: string;
  threshold: number;
  nearAiKey: string | undefined;
  nearAiModel: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): JudgeConfig {
  const missing = ["RUBRIC_CONTRACT", "JUDGE_ACCOUNT"].filter((k) => !env[k] || env[k]!.trim() === "");
  if (missing.length > 0) {
    throw new Error(`missing configuration: ${missing.join(", ")} (see .env.example)`);
  }
  const mode = (env.JUDGE_MODE ?? "mock").trim();
  if (mode !== "mock" && mode !== "near-ai") throw new Error(`JUDGE_MODE must be "mock" or "near-ai", got ${JSON.stringify(mode)}`);
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number");
  const nearAiKey = env.NEAR_AI_API_KEY?.trim() || undefined;
  if (mode === "near-ai" && !nearAiKey) {
    throw new Error('JUDGE_MODE=near-ai needs NEAR_AI_API_KEY. Without a key, use JUDGE_MODE=mock (the default).');
  }
  return {
    mode,
    contractId: env.RUBRIC_CONTRACT!.trim(),
    judgeAccount: env.JUDGE_ACCOUNT!.trim(),
    rpcUrl: env.NEAR_RPC_URL?.trim() || undefined,
    port,
    verdictDir: env.VERDICT_DIR?.trim() || ".data/verdicts",
    threshold: confidenceThreshold(env),
    nearAiKey,
    nearAiModel: env.NEAR_AI_MODEL?.trim() || DEFAULT_NEAR_AI_MODEL,
  };
}

export function buildModel(config: JudgeConfig): JudgeModel {
  return config.mode === "near-ai"
    ? new NearAiModel({ apiKey: config.nearAiKey!, model: config.nearAiModel })
    : new MockModel();
}

export interface Built {
  judge: ReturnType<typeof createJudge>;
  store: VerdictStore;
  info: ServerInfo;
}

export function buildJudge(config: JudgeConfig, store: VerdictStore = new FileStore(config.verdictDir)): Built {
  const chain = new RubricChain(config.contractId, config.rpcUrl);
  const signer = chain.as(config.judgeAccount, loadSecretKey(config.judgeAccount, { envVar: "JUDGE_PRIVATE_KEY" }));
  const model = buildModel(config);
  const judge = createJudge({
    chain,
    settler: { settle: (id, v) => signer.settle(id, v) },
    model,
    store,
    contractId: config.contractId,
    threshold: config.threshold,
  });
  return {
    judge,
    store,
    info: {
      mode: config.mode,
      model: model.name,
      contract: config.contractId,
      judge: config.judgeAccount,
      threshold: config.threshold,
    },
  };
}
