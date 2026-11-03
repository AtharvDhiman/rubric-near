import { describe, expect, it } from "vitest";
import type { StoredVerdict } from "@rubric-near/judge";
import type { Receipt, WorkResult } from "@rubric-near/agents";
import { buildSnapshot } from "../src/snapshot.js";

const receipt = (over: Partial<Receipt>): Receipt => ({
  taskId: "0",
  title: "t",
  seller: null,
  price: "1",
  fee: "0",
  outcome: "pending",
  confidence: null,
  clausesHash: null,
  sealTx: "SEAL0",
  note: "",
  at: "2026-11-04T10:00:00.000Z",
  ...over,
});

const work = (over: Partial<WorkResult>): WorkResult => ({
  taskId: "0",
  submitted: true,
  submissionHash: "h",
  content: "the work",
  submitTx: "SUBMIT0",
  judge: null,
  note: "",
  ...over,
});

const verdict = (over: Partial<StoredVerdict>): StoredVerdict => ({
  taskId: "0",
  status: "settled",
  outcome: "approved",
  confidence: 90,
  clauses: [],
  summary: "s",
  model: "mock",
  at: "2026-11-04T10:01:00.000Z",
  reasoningJson: "{}",
  reasoningHash: "r",
  txHash: "SETTLE0",
  ...over,
});

const build = (over: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
  buildSnapshot({
    contractId: "escrow.testnet",
    exportedAt: "2026-11-04T10:05:00.000Z",
    judge: "mock",
    receipts: [receipt({})],
    works: [work({})],
    verdicts: [verdict({})],
    ...over,
  });

describe("buildSnapshot", () => {
  it("joins a task's seal, work and verdict by its id", () => {
    const s = build();
    expect(s).toMatchObject({ version: 1, contract: "escrow.testnet", network: "testnet", judge: "mock" });
    expect(s.tasks["0"]).toMatchObject({
      submission: "the work",
      verdict: { outcome: "approved" },
      txs: { seal: "SEAL0", submit: "SUBMIT0", settle: "SETTLE0" },
    });
  });

  it("leaves out a negotiation that was walked away from, which sealed nothing", () => {
    const s = build({ receipts: [receipt({ taskId: null, sealTx: null, outcome: "walked_away" }), receipt({})] });
    expect(Object.keys(s.tasks)).toEqual(["0"]);
  });

  it("keeps a task nobody worked on, with no submission and no verdict", () => {
    const s = build({ receipts: [receipt({ taskId: "3" })], works: [], verdicts: [] });
    expect(s.tasks["3"]).toEqual({ submission: null, verdict: null, txs: { seal: "SEAL0" } });
  });

  it("does not record work the contract refused", () => {
    const s = build({ works: [work({ submitted: false, submitTx: null })], verdicts: [] });
    expect(s.tasks["0"]).toMatchObject({ submission: null });
    expect(s.tasks["0"]!.txs.submit).toBeUndefined();
  });

  it("ignores work and verdicts for a task that is not in the receipts", () => {
    const s = build({ works: [work({ taskId: "9" })], verdicts: [verdict({ taskId: "9" })] });
    expect(Object.keys(s.tasks)).toEqual(["0"]);
    expect(s.tasks["0"]).toMatchObject({ submission: null, verdict: null });
  });

  it("keeps a held verdict, which has no settlement transaction", () => {
    const s = build({ verdicts: [verdict({ status: "held", outcome: "needs_manual_review", txHash: undefined })] });
    expect(s.tasks["0"]!.verdict?.status).toBe("held");
    expect(s.tasks["0"]!.txs.settle).toBeUndefined();
  });
});
