import { describe, expect, it } from "vitest";
import { buildModel, loadConfig } from "../src/config.js";
import { MockModel } from "../src/mock.js";
import { NearAiModel } from "../src/near-ai.js";

const base = { RUBRIC_CONTRACT: "escrow.testnet", JUDGE_ACCOUNT: "judge.testnet" };

describe("loadConfig", () => {
  it("defaults to the offline mock judge, port 8787 and the 70 threshold", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      mode: "mock",
      contractId: "escrow.testnet",
      judgeAccount: "judge.testnet",
      port: 8787,
      threshold: 70,
      verdictDir: ".data/verdicts",
    });
  });

  it.each([["RUBRIC_CONTRACT"], ["JUDGE_ACCOUNT"]])("requires %s", (name) => {
    const env: Record<string, string | undefined> = { ...base, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(new RegExp(`missing configuration: ${name}`));
    expect(() => loadConfig({ ...base, [name]: "   " })).toThrow(/missing configuration/);
  });

  it("names every missing variable at once", () => {
    expect(() => loadConfig({})).toThrow(/RUBRIC_CONTRACT, JUDGE_ACCOUNT/);
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig({ ...base, JUDGE_MODE: "gpt" })).toThrow(/JUDGE_MODE must be "mock" or "near-ai"/);
  });

  it("the real judge needs a key, and says what to do instead", () => {
    expect(() => loadConfig({ ...base, JUDGE_MODE: "near-ai" })).toThrow(/needs NEAR_AI_API_KEY.*JUDGE_MODE=mock/);
    expect(() => loadConfig({ ...base, JUDGE_MODE: "near-ai", NEAR_AI_API_KEY: "  " })).toThrow(/needs NEAR_AI_API_KEY/);
  });

  it("accepts the real judge with a key and an optional model", () => {
    const c = loadConfig({ ...base, JUDGE_MODE: "near-ai", NEAR_AI_API_KEY: "k", NEAR_AI_MODEL: "x/y" });
    expect(c.mode).toBe("near-ai");
    expect(c.nearAiModel).toBe("x/y");
  });

  it.each(["0", "70000", "abc", "1.5"])("rejects the port %j", (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow(/PORT must be a port number/);
  });

  it("applies the threshold floor", () => {
    expect(loadConfig({ ...base, CONFIDENCE_THRESHOLD: "40" }).threshold).toBe(70);
    expect(loadConfig({ ...base, CONFIDENCE_THRESHOLD: "90" }).threshold).toBe(90);
  });

  it("trims whitespace from the account ids", () => {
    const c = loadConfig({ RUBRIC_CONTRACT: " escrow.testnet ", JUDGE_ACCOUNT: " judge.testnet " });
    expect(c.contractId).toBe("escrow.testnet");
    expect(c.judgeAccount).toBe("judge.testnet");
  });

  it("an error message never contains a configured secret", () => {
    const env = { ...base, JUDGE_MODE: "near-ai", NEAR_AI_API_KEY: "", JUDGE_PRIVATE_KEY: "ed25519:SHOULDNOTAPPEAR" };
    try {
      loadConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain("SHOULDNOTAPPEAR");
    }
  });
});

describe("buildModel", () => {
  it("builds the mock or the real model from the mode", () => {
    expect(buildModel(loadConfig(base))).toBeInstanceOf(MockModel);
    const real = buildModel(loadConfig({ ...base, JUDGE_MODE: "near-ai", NEAR_AI_API_KEY: "k" }));
    expect(real).toBeInstanceOf(NearAiModel);
  });
});
