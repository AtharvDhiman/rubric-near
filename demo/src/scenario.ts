/**
 * The whole loop, end to end, against a real contract (testnet or a local sandbox).
 *
 * Four jobs, so that every path through the system is exercised on a real chain:
 *
 *   1. a job done well                     -> approved, the worker is paid 98%, the fee accrues
 *   2. a job priced beyond the budget      -> the poster counters once, then walks away, sealing nothing
 *   3. a job done carelessly               -> rejected, the poster is refunded in full
 *   4. a job nobody takes                  -> the deadline passes, the poster reclaims in full
 *
 * Then it CHECKS the result against the chain instead of trusting what the agents said: statuses,
 * amounts, the 2% fee, that nothing is left in escrow, and that each stored verdict re-hashes to
 * the hash the contract recorded.
 */

import type { AddressInfo } from "node:net";
import { NEAR, RubricChain, formatNear, parseNear, storageAllowance, type Task } from "@rubric-near/shared";
import {
  Budget,
  PosterAgent,
  ReceiptBook,
  TemplateDoer,
  WorkerAgent,
  type Need,
  type PosterChain,
  type Receipt,
  type WorkerChain,
  type WorkResult,
} from "@rubric-near/agents";
import {
  MemoryStore,
  MockModel,
  createJudge,
  createJudgeServer,
  reasoningMatches,
  type JudgeModel,
} from "@rubric-near/judge";
import { buildSnapshot, type Snapshot } from "./snapshot.js";

export interface Party {
  account: string;
  secretKey: string;
}

export interface ScenarioInput {
  contractId: string;
  rpcUrl?: string;
  poster: Party;
  worker: Party;
  judge: Party;
  /** Defaults to the offline mock. Pass a NearAiModel for the real judge. */
  model?: JudgeModel;
  /** The poster agent's hard cap. Defaults to 3 NEAR. */
  budget?: bigint;
  /** How long the unclaimed job's window is, and so how long to wait before reclaiming it. 0 skips that job. */
  reclaimWaitSeconds?: number;
  log?: (line: string) => void;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ScenarioResult {
  receipts: Receipt[];
  table: string;
  checks: Check[];
  ok: boolean;
  /** The judge's reasoning, the submitted work and the transaction hashes, for the dashboard to check against the chain. */
  snapshot: Snapshot;
}

const NEEDS = {
  install: (): Need => ({
    title: "Write the install steps",
    clauses: ['The submission contains "npm install" and "node --version".', 'The submission contains "troubleshooting".'],
    maxPrice: parseNear("0.5"),
    windowSeconds: 900,
  }),
  translate: (): Need => ({
    title: "Translate the whole README",
    clauses: ['It is in "Spanish".', 'It keeps every "code block".', 'It keeps every "link".'],
    // Worth only 0.05 NEAR to the poster. The worker's floor for three clauses is 0.15.
    maxPrice: parseNear("0.05"),
    windowSeconds: 900,
  }),
  changelog: (): Need => ({
    title: "Summarise the changelog",
    clauses: ['It lists the "breaking changes".', 'It lists the "new features".'],
    maxPrice: parseNear("0.6"),
    windowSeconds: 900,
  }),
  release: (seconds: number): Need => ({
    title: "Draft the release notes",
    clauses: ['It mentions "v1.0".'],
    maxPrice: parseNear("0.2"),
    windowSeconds: seconds,
  }),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScenario(input: ScenarioInput): Promise<ScenarioResult> {
  const log = input.log ?? (() => {});
  const chain = new RubricChain(input.contractId, input.rpcUrl);
  const config = await chain.getConfig();
  log(`contract ${input.contractId}: judge ${config.judge_id}, fee ${config.fee_bps / 100}%, minimum confidence ${config.min_confidence}`);
  if (config.judge_id !== input.judge.account) {
    throw new Error(`this contract's judge is ${config.judge_id}, not ${input.judge.account}`);
  }

  // ------------------------------------------------------------------ the judge, as a real HTTP service
  const store = new MemoryStore();
  const judgeSigner = chain.as(input.judge.account, input.judge.secretKey);
  const model = input.model ?? new MockModel();
  const judge = createJudge({
    chain,
    settler: { settle: async (id, v) => ({ txHash: (await judgeSigner.settle(id, v)).txHash }) },
    model,
    store,
    contractId: input.contractId,
    threshold: 70,
  });
  const server = createJudgeServer({
    judge,
    store,
    info: { mode: model.name === "mock" ? "mock" : "near-ai", model: model.name, contract: input.contractId, judge: input.judge.account, threshold: 70 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const judgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  log(`judge (${model.name}) listening at ${judgeUrl}`);

  try {
    // ---------------------------------------------------------------- the agents
    const posterSigner = chain.as(input.poster.account, input.poster.secretKey);
    const workerSigner = chain.as(input.worker.account, input.worker.secretKey);

    const posterChain: PosterChain = {
      async seal(i) {
        const r = await posterSigner.seal(i);
        return { taskId: r.taskId, txHash: r.txHash };
      },
      async reclaim(id) {
        return { txHash: (await posterSigner.reclaim(id)).txHash };
      },
      getTask: (id) => chain.getTask(id),
      storageAllowance,
    };
    const workerChain: WorkerChain = {
      getTasks: (from, limit) => chain.getTasks(from, limit),
      async submit(id, hash) {
        return { txHash: (await workerSigner.submit(id, hash)).txHash };
      },
    };
    const mkWorker = (omit?: number) =>
      new WorkerAgent({
        account: input.worker.account,
        chain: workerChain,
        doer: new TemplateDoer(omit === undefined ? {} : { omit }),
        judgeUrl,
        pricePerClause: parseNear("0.05"),
      });
    const honest = mkWorker();
    const careless = mkWorker(1);

    const budget = new Budget(input.budget ?? 3n * NEAR);
    const receipts = new ReceiptBook();
    const poster = new PosterAgent({ chain: posterChain, budget, receipts, sellers: [honest] });
    const works: WorkResult[] = [];
    log(`poster ${input.poster.account} has a budget of ${formatNear(budget.cap)} NEAR`);

    const settle = async (r: Receipt): Promise<Receipt> => {
      if (r.taskId !== null) await chain.waitForPayout(r.taskId);
      return poster.collect(r);
    };

    // 1. a job done well
    log("\n1. Buying: " + NEEDS.install().title);
    const r1 = await poster.buy(NEEDS.install());
    log(`   sealed as task ${r1.taskId} for ${formatNear(r1.price)} NEAR (${r1.note})`);
    const w1 = await honest.step();
    if (w1) works.push(w1);
    log(`   worker: ${w1?.note}`);
    await settle(r1);

    // 2. a job priced beyond the budget
    log("\n2. Buying: " + NEEDS.translate().title);
    const r2 = await poster.buy(NEEDS.translate());
    log(`   ${r2.outcome}: ${r2.note}`);

    // 3. a job done carelessly
    log("\n3. Buying: " + NEEDS.changelog().title);
    const r3 = await poster.buy(NEEDS.changelog());
    log(`   sealed as task ${r3.taskId} for ${formatNear(r3.price)} NEAR`);
    const w3 = await careless.step();
    if (w3) works.push(w3);
    log(`   worker (careless): ${w3?.note}`);
    await settle(r3);

    // 4. a job nobody takes
    let r4: Receipt | null = null;
    const wait = input.reclaimWaitSeconds ?? 25;
    if (wait > 0) {
      log("\n4. Buying: " + NEEDS.release(wait).title + ` (nobody will take it; the window is ${wait}s)`);
      r4 = await poster.buy(NEEDS.release(wait));
      log(`   sealed as task ${r4.taskId}; waiting for its deadline`);
      await sleep((wait + 6) * 1000);
      await poster.reclaim(r4);
      await settle(r4);
    }

    // ---------------------------------------------------------------- check it against the chain
    const checks: Check[] = [];
    const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

    const t1 = r1.taskId === null ? null : await chain.getTask(r1.taskId);
    const t3 = r3.taskId === null ? null : await chain.getTask(r3.taskId);
    const price1 = BigInt(r1.price);

    check("the good job was approved and its worker paid", r1.outcome === "approved" && t1?.state === "Settled" && t1.payout?.status === "Paid", `${r1.outcome}, chain says ${t1?.state}/${t1?.payout?.status}`);
    check("the worker received 98% and the fee was 2%", t1 !== null && BigInt(t1.payout?.fee ?? 0) === price1 / 50n && BigInt(t1.payout?.amount ?? 0) === price1 - price1 / 50n, `paid ${formatNear(t1?.payout?.amount ?? "0")}, fee ${formatNear(t1?.payout?.fee ?? "0")} of ${formatNear(price1)}`);
    check("the over-budget job was walked away from, and nothing was sealed", r2.outcome === "walked_away" && r2.taskId === null, r2.note);
    check("the careless job was rejected and the poster refunded in full", r3.outcome === "rejected" && t3?.state === "Refunded" && t3.payout?.to === input.poster.account && BigInt(t3.payout.amount) === BigInt(r3.price), `${r3.outcome}, refunded ${formatNear(t3?.payout?.amount ?? "0")} to ${t3?.payout?.to}`);
    if (r4) check("the unclaimed job was reclaimed", r4.outcome === "reclaimed", r4.outcome);

    const verdictTasks = [t1, t3].filter((t): t is Task => t !== null);
    for (const t of verdictTasks) {
      const stored = await store.get(t.id);
      check(`task ${t.id}: the stored reasoning hashes to the hash on-chain`, stored !== null && reasoningMatches(stored, t.verdict?.reasoning_hash), `stored ${stored?.reasoningHash?.slice(0, 12)}..., chain ${t.verdict?.reasoning_hash.slice(0, 12)}...`);
    }
    check("the contract rejected nothing it should not have: both verdicts were at least 70% confident", verdictTasks.every((t) => (t.verdict?.confidence ?? 0) >= 70), verdictTasks.map((t) => t.verdict?.confidence).join(", "));

    const accounting = await chain.getAccounting();
    check("nothing is left in escrow", BigInt(accounting.escrow_held) === 0n, `${formatNear(accounting.escrow_held)} NEAR held`);
    check("the contract's balance covers what it owes", BigInt(accounting.contract_balance) >= BigInt(accounting.escrow_held) + BigInt(accounting.fees_accrued), `balance ${formatNear(accounting.contract_balance)}, owes ${formatNear(BigInt(accounting.escrow_held) + BigInt(accounting.fees_accrued))}`);
    check("the poster agent stayed inside its budget", budget.remaining >= 0n && budget.remaining === budget.cap - price1, `${formatNear(budget.remaining)} of ${formatNear(budget.cap)} NEAR left`);

    const all = [r1, r2, r3, ...(r4 ? [r4] : [])];
    const snapshot = buildSnapshot({
      contractId: input.contractId,
      exportedAt: new Date().toISOString(),
      judge: model.name,
      receipts: all,
      works,
      verdicts: await store.list(),
    });
    return { receipts: all, table: receipts.table(), checks, ok: checks.every((c) => c.ok), snapshot };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
