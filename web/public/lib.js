// The dashboard's logic, with no DOM in it, so it can be tested under Node and run in a browser.
//
// The rule this file exists to keep: nothing on the page is believed. The chain is read live over
// JSON-RPC, and everything else (the judge's reasoning, the submitted work) is accepted only if its
// SHA-256 equals a hash the chain holds. Where it cannot be checked, the check says so instead of
// passing.

export const HASH_DOMAIN = "rubric-near/v1";

/** One NEAR in yoctoNEAR. */
export const NEAR = 10n ** 24n;

/**
 * The text a rubric is hashed under. This must equal the contract's `canonical_rubric` and the
 * shared TypeScript `canonicalRubric` byte for byte; test/lib.test.ts holds it to the second.
 * @param {string} title
 * @param {readonly string[]} clauses
 */
export function canonicalRubric(title, clauses) {
  return [HASH_DOMAIN, title, String(clauses.length), ...clauses, ""].join("\n");
}

/** SHA-256 of a string's UTF-8 bytes, as lowercase hex. @param {string} text */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} title @param {readonly string[]} clauses */
export const hashRubric = (title, clauses) => sha256Hex(canonicalRubric(title, clauses));

/** yoctoNEAR as NEAR, trailing zeros trimmed: "0.098", "1", "0.0021". @param {string | bigint} yocto */
export function formatNear(yocto) {
  const v = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const frac = (v % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${v / NEAR}.${frac}` : `${v / NEAR}`;
}

/** A hash or id cut for display, never for comparison. @param {string} s @param {number} [n] */
export const short = (s, n = 12) => (s.length > n + 1 ? `${s.slice(0, n)}…` : s);

/** Nanoseconds since the epoch (a decimal string, as the contract returns it) as a Date. @param {string} ns */
export const nsToDate = (ns) => new Date(Number(BigInt(ns) / 1_000_000n));

// ---------------------------------------------------------------------------- reading the chain

/**
 * Call a view method on the contract over JSON-RPC. Nothing is signed and no key is involved.
 * @param {string} rpcUrl
 * @param {string} contractId
 * @param {string} method
 * @param {Record<string, unknown>} [args]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<any>}
 */
export async function viewCall(rpcUrl, contractId, method, args = {}, fetchImpl = globalThis.fetch) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "rubric-dashboard",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(String.fromCharCode(...bytes)),
      },
    }),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`the RPC refused ${method}: ${describeRpcError(body.error)}`);
  if (body.result?.error) throw new Error(`the contract could not answer ${method}: ${String(body.result.error).slice(0, 200)}`);
  const raw = new TextDecoder().decode(Uint8Array.from(body.result?.result ?? []));
  return raw.length === 0 ? null : JSON.parse(raw);
}

/** @param {any} error */
function describeRpcError(error) {
  const cause = error?.cause?.name ? ` (${error.cause.name})` : "";
  return `${error?.data ?? error?.message ?? "unknown error"}${cause}`.slice(0, 200);
}

/**
 * The contract's configuration and accounting, and every task, oldest first, paged 50 at a time.
 * @param {string} rpcUrl
 * @param {string} contractId
 * @param {typeof fetch} [fetchImpl]
 */
export async function loadChain(rpcUrl, contractId, fetchImpl = globalThis.fetch) {
  /** @param {string} method @param {Record<string, unknown>} args */
  const call = (method, args) => viewCall(rpcUrl, contractId, method, args, fetchImpl);
  const [config, accounting] = await Promise.all([call("get_config", {}), call("get_accounting", {})]);
  const total = Number(config.tasks_total);
  /** @type {any[]} */
  const tasks = [];
  for (let from = 0; from < total; from += 50) {
    tasks.push(...(await call("get_tasks", { from_index: String(from), limit: "50" })));
  }
  return { config, accounting, tasks };
}

/**
 * The models named by the verdicts in a snapshot, sorted and without duplicates. They are read from
 * each verdict because the file's own "judge" field is only a summary, and runs with different judges
 * can share one file.
 * @param {any} snapshot
 * @returns {string[]}
 */
export function judgeModels(snapshot) {
  const tasks = snapshot && typeof snapshot.tasks === "object" && snapshot.tasks ? Object.values(snapshot.tasks) : [];
  const names = tasks.map((/** @type {any} */ t) => t?.verdict?.model).filter((/** @type {unknown} */ m) => typeof m === "string" && m.length > 0);
  return [...new Set(names)].sort();
}

// ----------------------------------------------------------------------------------- explorer links

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * A link to a transaction, or null. The hash came from a file the page does not trust, so it is
 * checked to be a transaction hash before it is put into a URL.
 * @param {string} template contains {hash}
 * @param {string | undefined | null} hash
 */
export function txUrl(template, hash) {
  return typeof hash === "string" && TX_HASH.test(hash) ? template.replace("{hash}", hash) : null;
}

/** @param {string} template contains {account} @param {string | undefined | null} account */
export function accountUrl(template, account) {
  return typeof account === "string" && ACCOUNT_ID.test(account) ? template.replace("{account}", account) : null;
}

// ------------------------------------------------------------------------------ what a task is

/**
 * One plain word for where a task stands, and how loudly to say it.
 * @param {any} task
 * @param {bigint} nowNs
 * @returns {{ label: string, tone: "open" | "wait" | "paid" | "refund" | "alarm" }}
 */
export function describeOutcome(task, nowNs) {
  const payout = task.payout;
  if (payout?.status === "Failed") return { label: "PAYOUT FAILED", tone: "alarm" };
  switch (task.state) {
    case "Open":
      return BigInt(task.deadline_ns) <= nowNs ? { label: "EXPIRED", tone: "wait" } : { label: "OPEN", tone: "open" };
    case "Submitted":
      return { label: "AWAITING JUDGE", tone: "wait" };
    case "Settled":
      return payout?.status === "Paid" ? { label: "PAID", tone: "paid" } : { label: "PAYING", tone: "wait" };
    case "Refunded":
      if (payout?.status !== "Paid") return { label: "REFUNDING", tone: "wait" };
      return task.verdict ? { label: "REFUNDED", tone: "refund" } : { label: "RECLAIMED", tone: "refund" };
    default:
      return { label: String(task.state).toUpperCase(), tone: "wait" };
  }
}

// -------------------------------------------------------------------------------- the checks

/**
 * @typedef {{ id: string, label: string, status: "pass" | "fail" | "skip", detail: string }} Check
 * @typedef {{ contract: string, feeBps: number, minConfidence: number }} CheckContext
 */

/** @param {string} a @param {string} b */
const same = (a, b) => a === b;

/**
 * Re-derive, in this browser, everything about a task that can be derived. `entry` is the
 * snapshot's record for the task (the judge's reasoning and the submitted work), or null.
 * @param {any} task what the chain says
 * @param {any} entry what the snapshot says, which is not trusted
 * @param {CheckContext} ctx
 * @returns {Promise<Check[]>}
 */
export async function verifyTask(task, entry, ctx) {
  /** @type {Check[]} */
  const checks = [];
  /** @param {string} id @param {string} label @param {"pass" | "fail" | "skip"} status @param {string} detail */
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  // 1. The rubric: the clauses the chain stores are the clauses the chain sealed.
  const rubricHash = await hashRubric(task.title, task.clauses);
  add(
    "rubric",
    "The clauses on-chain hash to the seal",
    same(rubricHash, task.clauses_hash) ? "pass" : "fail",
    `computed ${short(rubricHash)} · sealed ${short(task.clauses_hash)}`
  );

  // 2. The work: the text shown is the text the worker committed to.
  if (task.submission_hash) {
    if (typeof entry?.submission !== "string") {
      add("submission", "The submitted work hashes to the worker's commitment", "skip", "this snapshot has no copy of the work");
    } else {
      const h = await sha256Hex(entry.submission);
      add(
        "submission",
        "The submitted work hashes to the worker's commitment",
        same(h, task.submission_hash) ? "pass" : "fail",
        `computed ${short(h)} · committed ${short(task.submission_hash)}`
      );
    }
  }

  // 3. The verdict.
  const verdict = task.verdict;
  if (verdict) {
    const text = entry?.verdict?.reasoningJson;
    /** @type {any} */
    let record = null;
    let reasoningOk = false;
    if (typeof text !== "string") {
      add("reasoning", "The judge's reasoning hashes to the chain's record", "skip", "this snapshot has no copy of the reasoning");
    } else {
      const h = await sha256Hex(text);
      reasoningOk = same(h, verdict.reasoning_hash);
      add(
        "reasoning",
        "The judge's reasoning hashes to the chain's record",
        reasoningOk ? "pass" : "fail",
        `computed ${short(h)} · on-chain ${short(verdict.reasoning_hash)}`
      );
      try {
        record = JSON.parse(text);
      } catch {
        record = null;
      }
    }

    if (!reasoningOk || !record) {
      add("binding", "The reasoning is about this task, these clauses and this work", "skip", "not checked: the reasoning did not verify");
      add("rulings", "The rulings agree with the verdict", "skip", "not checked: the reasoning did not verify");
    } else {
      const problems = [];
      if (record.contract !== ctx.contract) problems.push("it names another contract");
      if (record.taskId !== task.id) problems.push("it names another task");
      if (record.clausesHash !== task.clauses_hash) problems.push("it names other clauses");
      if (record.submissionHash !== task.submission_hash) problems.push("it names other work");
      if ((record.outcome === "approved") !== verdict.approved) problems.push("its outcome differs from the chain's");
      if (record.confidence !== verdict.confidence) problems.push("its confidence differs from the chain's");
      add(
        "binding",
        "The reasoning is about this task, these clauses and this work",
        problems.length === 0 ? "pass" : "fail",
        problems.length === 0 ? "contract, task id, clause hash, work hash, outcome and confidence all match" : problems.join("; ")
      );

      /** @type {Array<{ index: number, passed: boolean }>} */
      const rulings = Array.isArray(record.clauses) ? record.clauses : [];
      const complete = rulings.length === task.clauses.length && rulings.every((r, i) => r.index === i);
      const failed = rulings.filter((r) => r.passed === false).length;
      const coherent = verdict.approved ? failed === 0 : failed > 0;
      add(
        "rulings",
        verdict.approved ? "Every clause was ruled on, and every clause passed" : "Every clause was ruled on, and a failed clause is cited",
        complete && coherent ? "pass" : "fail",
        !complete
          ? `${rulings.length} rulings for ${task.clauses.length} clauses`
          : verdict.approved
            ? `${rulings.length} of ${rulings.length} passed`
            : `${failed} of ${rulings.length} failed`
      );
    }

    add(
      "confidence",
      "The judge ruled at or above the contract's minimum confidence",
      verdict.confidence >= ctx.minConfidence ? "pass" : "fail",
      `${verdict.confidence} against a minimum of ${ctx.minConfidence}`
    );
  }

  // 4. The money. Derived from the chain's own numbers; the snapshot is not involved.
  const payout = task.payout;
  if (payout) {
    const bounty = BigInt(task.bounty);
    const amount = BigInt(payout.amount);
    const fee = BigInt(payout.fee);
    if (task.state === "Settled") {
      const expectedFee = (bounty * BigInt(ctx.feeBps)) / 10_000n;
      const ok = fee === expectedFee && amount + fee === bounty && payout.to === task.worker;
      add(
        "payout",
        "The worker got the bounty less the fee, and nothing else moved",
        ok ? "pass" : "fail",
        `${formatNear(amount)} to the worker + ${formatNear(fee)} fee = ${formatNear(amount + fee)} of ${formatNear(bounty)}`
      );
    } else if (task.state === "Refunded") {
      const ok = fee === 0n && amount === bounty && payout.to === task.poster;
      add(
        "payout",
        "The poster was refunded in full, with no fee",
        ok ? "pass" : "fail",
        `${formatNear(amount)} to the poster of ${formatNear(bounty)}`
      );
    }
  }

  return checks;
}

/** How many checks passed, how many failed, how many could not be run. @param {readonly Check[]} checks */
export function tally(checks) {
  /** @param {string} s */
  const count = (s) => checks.filter((c) => c.status === s).length;
  return { pass: count("pass"), fail: count("fail"), skip: count("skip"), total: checks.length };
}
