// The dashboard. It reads the contract from the chain, then re-derives everything it can from what
// it read (see lib.js). Text from the chain or from the published snapshot only ever goes into the
// page as a text node, so nothing a task's author wrote can become markup.

import { accountUrl, describeOutcome, formatNear, judgeModels, loadChain, nsToDate, short, tally, txUrl, verifyTask } from "./lib.js";

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @typedef {import("./lib.js").Check} Check */

// ----------------------------------------------------------------------------------- building DOM

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children strings become text; arrays are flattened
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "onclick") el.addEventListener("click", value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** A link that opens elsewhere, or plain text if there is no safe URL. */
const external = (/** @type {string | null} */ url, /** @type {string} */ text, props = {}) =>
  url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", ...props }, text) : h("span", props, text);

/** @param {string} tone @param {string} glyph @param {string} word */
const chip = (tone, glyph, word) => h("span", { class: `chip tone-${tone}` }, h("span", { class: "glyph", "aria-hidden": "true" }, glyph), word);

const GLYPH = { open: "○", wait: "◌", paid: "●", refund: "↩", alarm: "✕", ink: "✓" };
const outcomeChip = (/** @type {any} */ task, /** @type {bigint} */ nowNs) => {
  const { label, tone } = describeOutcome(task, nowNs);
  return chip(tone, GLYPH[tone], label);
};

/** @param {Check["status"]} status */
const checkChip = (status) =>
  status === "pass" ? chip("ink", GLYPH.ink, "MATCHES") : status === "fail" ? chip("alarm", GLYPH.alarm, "MISMATCH") : chip("wait", GLYPH.wait, "NOT CHECKED");

/** A task's checks in one chip: red if any failed, amber if any could not be run, ink if all passed. */
function tallyChip(/** @type {readonly Check[]} */ checks) {
  const t = tally(checks);
  if (t.fail > 0) return chip("alarm", GLYPH.alarm, `${t.fail} MISMATCH`);
  if (t.skip > 0) return chip("wait", GLYPH.wait, `${t.pass}/${t.total} CHECKED`);
  return chip("ink", GLYPH.ink, `${t.pass}/${t.total} MATCH`);
}

const utc = (/** @type {string} */ ns) => `${nsToDate(ns).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const near = (/** @type {string | bigint} */ yocto) => `${formatNear(yocto)} NEAR`;

// ------------------------------------------------------------------------------------------ loading

/**
 * @typedef {object} Model
 * @property {any} config
 * @property {any} chain
 * @property {any | null} snapshot the judge's reasoning and the submitted work, which is not trusted
 * @property {string | null} snapshotNote why there is no snapshot, if there is not
 * @property {Map<string, Check[]>} checks
 * @property {bigint} nowNs
 */

/** @type {Model | null} */
let model = null;

async function loadSnapshot(/** @type {any} */ config) {
  try {
    const response = await fetch("data/verdicts.json", { cache: "no-cache" });
    if (!response.ok) return { snapshot: null, note: "No judge reasoning was published with this page, so the checks that need it are marked not checked." };
    const data = await response.json();
    if (data?.version !== 1 || data.contract !== config.contract) {
      return { snapshot: null, note: `The published reasoning belongs to ${String(data?.contract ?? "an unknown contract")}, not ${config.contract}, so it was ignored.` };
    }
    return { snapshot: data, note: null };
  } catch {
    return { snapshot: null, note: "The published reasoning could not be read, so the checks that need it are marked not checked." };
  }
}

/** The snapshot's record for a task. Own properties only: an id is never allowed to reach the prototype. */
function entryFor(/** @type {any} */ snapshot, /** @type {string} */ id) {
  const tasks = snapshot?.tasks;
  return tasks && Object.hasOwn(tasks, id) ? tasks[id] : null;
}

async function boot() {
  app.replaceChildren(h("p", { class: "status" }, "Reading the chain…"));
  try {
    const configResponse = await fetch("config.json", { cache: "no-cache" });
    if (!configResponse.ok) throw new Error("config.json could not be read");
    const config = await configResponse.json();
    const [chain, { snapshot, note }] = await Promise.all([loadChain(config.rpc, config.contract), loadSnapshot(config)]);

    const ctx = { contract: config.contract, feeBps: chain.config.fee_bps, minConfidence: chain.config.min_confidence };
    /** @type {Map<string, Check[]>} */
    const checks = new Map();
    for (const task of chain.tasks) checks.set(task.id, await verifyTask(task, entryFor(snapshot, task.id), ctx));

    model = { config, chain, snapshot, snapshotNote: note, checks, nowNs: BigInt(Date.now()) * 1_000_000n };
    document.getElementById("net")?.replaceChildren(`${String(config.network).toUpperCase()} · UNAUDITED · TEST FUNDS`);
    route();
  } catch (error) {
    renderError(error);
  }
}

function renderError(/** @type {unknown} */ error) {
  const message = error instanceof Error ? error.message : String(error);
  app.replaceChildren(
    h(
      "div",
      { class: "notice notice-alarm" },
      h("p", null, h("strong", null, "The chain could not be read. "), "Nothing is shown rather than something stale. ", message),
      h("button", { type: "button", onclick: boot }, "Try again")
    )
  );
}

// ------------------------------------------------------------------------------------------ docket

function renderDocket(/** @type {Model} */ m) {
  const { config, chain, snapshot } = m;
  const everything = chain.tasks.flatMap((/** @type {any} */ t) => m.checks.get(t.id) ?? []);
  const total = tally(everything);
  const models = judgeModels(snapshot);
  const judgeName = models.length > 0 ? models.map((name) => (name === "mock" ? "mock (offline)" : name)).join(", ") : "not published";
  const usesMock = models.includes("mock");

  const rows = chain.tasks.map((/** @type {any} */ task) => {
    const verdict = task.verdict;
    return h(
      "tr",
      null,
      h("td", { class: "fig" }, h("a", { class: "row-link", href: `#/task/${task.id}` }, task.id)),
      h("td", null, h("a", { class: "row-link title", href: `#/task/${task.id}` }, task.title)),
      h("td", { class: "fig num" }, near(task.bounty)),
      h("td", null, outcomeChip(task, m.nowNs)),
      h("td", { class: "fig" }, verdict ? `${verdict.approved ? "APPROVED" : "REJECTED"} · ${verdict.confidence}` : "—"),
      h("td", null, tallyChip(m.checks.get(task.id) ?? []))
    );
  });

  return [
    h(
      "section",
      { class: "lede" },
      h("h1", null, "Pay on proof, not on trust."),
      h(
        "p",
        null,
        "A poster seals acceptance clauses on NEAR with the bounty. A worker submits. An AI judge rules clause by clause, and the contract pays the worker or refunds the poster. The clauses cannot change after they are sealed, and every ruling cites them."
      ),
      h("p", { class: "soft" }, "Below is the live docket. Your browser re-derives each claim from the chain instead of taking this page's word for it.")
    ),
    usesMock &&
      (models.length === 1
        ? h(
            "p",
            { class: "notice notice-hold" },
            h("strong", null, "The judge in this demo is the offline mock. "),
            "It follows deterministic keyword rules and is not a language model. The contract, the hashes and the payouts are real testnet state; the README shows how to run the same flow with a model on NEAR AI Cloud."
          )
        : h(
            "p",
            { class: "notice notice-hold" },
            h("strong", null, "Some of these verdicts come from the offline mock judge. "),
            "Each task names the judge that ruled on it. The mock follows deterministic keyword rules and is not a language model; the others were ruled by a model."
          )),
    m.snapshotNote && h("p", { class: "notice notice-hold" }, m.snapshotNote),
    h(
      "dl",
      { class: "ledger" },
      ...[
        ["Tasks sealed", chain.config.tasks_total],
        ["Held in escrow", near(chain.accounting.escrow_held)],
        [`Fees accrued (${chain.config.fee_bps / 100}%)`, near(chain.accounting.fees_accrued)],
        ["Minimum confidence", String(chain.config.min_confidence)],
        ["Judge model", judgeName],
      ].map(([label, value]) => h("div", null, h("dt", null, label), h("dd", null, value))),
      h("div", null, h("dt", null, "Judge account"), h("dd", null, external(accountUrl(config.explorerAccount, chain.config.judge_id), chain.config.judge_id))),
      h("div", null, h("dt", null, "Fees go to"), h("dd", null, external(accountUrl(config.explorerAccount, chain.config.owner_id), chain.config.owner_id))),
      h("div", null, h("dt", null, "Contract"), h("dd", null, external(accountUrl(config.explorerAccount, config.contract), config.contract)))
    ),
    h(
      "p",
      { class: "tally" },
      h("span", { class: "label" }, "Checked in your browser"),
      h("span", { class: "fig" }, `${total.pass} match`),
      h("span", { class: "fig" }, `${total.fail} mismatch`),
      h("span", { class: "fig" }, `${total.skip} not checked`)
    ),
    chain.tasks.length === 0
      ? h("p", { class: "status" }, "No task has been sealed on this contract yet.")
      : h(
          "div",
          { class: "scroll" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ...["ID", "Task", "Bounty", "State", "Ruling", "Checks"].map((c, i) => h("th", { class: i === 2 ? "num" : "" }, c)))),
            h("tbody", null, rows)
          )
        ),
  ];
}

// ------------------------------------------------------------------------------------------- task

/** @param {readonly Check[]} checks @param {string} id */
const statusOf = (checks, id) => checks.find((c) => c.id === id)?.status;

function renderTask(/** @type {Model} */ m, /** @type {string} */ id) {
  const { config, chain, snapshot } = m;
  const task = chain.tasks.find((/** @type {any} */ t) => t.id === id);
  const back = h("a", { class: "back", href: "#/" }, "← ALL TASKS");
  if (!task) return [back, h("p", { class: "notice" }, `There is no task ${id} on ${config.contract}.`)];

  const checks = m.checks.get(id) ?? [];
  const entry = entryFor(snapshot, id);
  const txs = entry?.txs ?? {};
  const txLink = (/** @type {string | undefined} */ hash) => (hash ? external(txUrl(config.explorerTx, hash), `tx ${short(hash, 8)}`) : null);
  const account = (/** @type {string} */ name) => external(accountUrl(config.explorerAccount, name), name);

  // The judge's reasoning is shown only if it hashed to what the chain holds AND is about this task.
  /** @type {any | null} */
  let record = null;
  if (statusOf(checks, "reasoning") === "pass" && statusOf(checks, "binding") === "pass" && statusOf(checks, "rulings") === "pass") {
    try {
      record = JSON.parse(entry.verdict.reasoningJson);
    } catch {
      record = null;
    }
  }
  const failed = tally(checks).fail > 0;

  const clauses = task.clauses.map((/** @type {string} */ text, /** @type {number} */ i) => {
    const ruling = record?.clauses?.[i];
    const bad = ruling && ruling.passed === false;
    return h(
      "li",
      { class: `clause${bad ? " failed" : ""}` },
      h("span", { class: "no" }, `C${i + 1}`),
      h("span", { class: "text" }, text),
      ruling &&
        h(
          "div",
          { class: "ruling" },
          bad ? chip("alarm", GLYPH.alarm, "FAILED") : chip("ink", GLYPH.ink, "PASSED"),
          h("span", { class: "reason" }, ruling.reason)
        )
    );
  });

  // The money, from the chain's own numbers.
  const payout = task.payout;
  const moneyRows = [];
  moneyRows.push(h("tr", null, h("td", null, "Bounty"), h("td", null, near(task.bounty))));
  if (payout && task.state === "Settled") {
    moneyRows.push(h("tr", null, h("td", null, "To the worker"), h("td", { class: "paid" }, near(payout.amount))));
    moneyRows.push(h("tr", null, h("td", null, "Protocol fee"), h("td", null, near(payout.fee))));
  } else if (payout && task.state === "Refunded") {
    moneyRows.push(h("tr", null, h("td", null, "Back to the poster"), h("td", null, near(payout.amount))));
  } else {
    moneyRows.push(h("tr", null, h("td", null, "In escrow"), h("td", null, "held")));
  }

  // What happened, in order, with the transactions that did it.
  const steps = [];
  steps.push(
    h("li", null, h("span", { class: "when" }, utc(task.created_ns)), h("span", { class: "what" }, "Sealed with the bounty"), h("div", { class: "who" }, account(task.poster), " ", txLink(txs.seal)))
  );
  if (task.submitted_ns) {
    steps.push(
      h("li", null, h("span", { class: "when" }, utc(task.submitted_ns)), h("span", { class: "what" }, "Work submitted"), h("div", { class: "who" }, account(task.worker), " ", txLink(txs.submit)))
    );
  }
  if (task.verdict) {
    steps.push(
      h(
        "li",
        null,
        h("span", { class: "when" }, utc(task.verdict.decided_ns)),
        h("span", { class: "what" }, `Judge ruled: ${task.verdict.approved ? "approved" : "rejected"} at ${task.verdict.confidence}`),
        h("div", { class: "who" }, account(chain.config.judge_id), " ", txLink(txs.settle))
      )
    );
  }
  if (payout) {
    const what = task.state === "Settled" ? "Paid to the worker" : task.verdict ? "Refunded to the poster" : "Reclaimed by the poster";
    steps.push(h("li", null, h("span", { class: "what" }, what), h("div", { class: "who" }, account(payout.to), " · ", near(payout.amount))));
  } else if (task.state === "Open") {
    steps.push(h("li", null, h("span", { class: "when" }, utc(task.deadline_ns)), h("span", { class: "what" }, "Window closes")));
  }

  const rawText = entry?.verdict?.reasoningJson;
  return [
    back,
    h("div", { class: "task-head" }, h("h1", null, task.title), outcomeChip(task, m.nowNs)),
    h("p", { class: "parties" }, "Posted by ", account(task.poster), task.worker ? [" · worked by ", account(task.worker)] : " · nobody has submitted work"),
    failed &&
      h(
        "p",
        { class: "notice notice-alarm" },
        h("strong", null, "Something on this record does not match the chain. "),
        "The mismatched checks are marked below. The judge's reasoning is withheld until it verifies."
      ),
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "stack" },
        h(
          "section",
          { class: "panel" },
          h("h3", null, "Sealed clauses"),
          h("ol", { class: "clauses" }, clauses),
          record
            ? h(
                "p",
                { class: "summary" },
                h("span", { class: "label" }, `Judge's summary · ${record.model}`),
                h("br"),
                record.summary
              )
            : task.verdict && h("p", { class: "summary soft" }, "The judge's per-clause reasoning is not shown because it could not be verified against the chain.")
        ),
        h(
          "section",
          { class: "panel" },
          h("h3", null, "Checked in your browser"),
          h(
            "ul",
            { class: "checks" },
            checks.map((c) =>
              h("li", { class: "check" }, checkChip(c.status), h("span", null, c.label), h("span", { class: "detail" }, c.detail))
            )
          ),
          typeof rawText === "string" &&
            h(
              "details",
              null,
              h("summary", null, statusOf(checks, "reasoning") === "pass" ? "The exact text the on-chain reasoning hash covers" : "The reasoning text this page was given (it does not verify)"),
              h("pre", null, rawText),
              h("p", { class: "refs soft" }, `SHA-256 of that text must equal ${task.verdict?.reasoning_hash ?? ""}`)
            ),
          typeof entry?.submission === "string" &&
            h(
              "details",
              null,
              h("summary", null, statusOf(checks, "submission") === "pass" ? "The submitted work" : "The work this page was given (it does not verify)"),
              h("pre", null, entry.submission),
              h("p", { class: "refs soft" }, `SHA-256 of that text must equal ${task.submission_hash ?? ""}`)
            )
        )
      ),
      h(
        "div",
        { class: "stack" },
        h("section", { class: "panel" }, h("h3", null, "Money"), h("table", { class: "money" }, h("tbody", null, moneyRows))),
        h("section", { class: "panel" }, h("h3", null, "What happened"), h("ol", { class: "timeline" }, steps)),
        h(
          "section",
          { class: "panel" },
          h("h3", null, "Sealed under"),
          h("p", { class: "fig" }, short(task.clauses_hash, 16)),
          h("p", { class: "soft closes" }, `Closes ${utc(task.deadline_ns)}`)
        )
      )
    ),
  ];
}

// ----------------------------------------------------------------------------------------- routing

function route() {
  if (!model) return;
  const match = /^#\/task\/(\d{1,20})$/.exec(location.hash);
  const view = match ? renderTask(model, match[1] ?? "") : renderDocket(model);
  // A view lists its parts; a part that does not apply is false, and is simply left out.
  app.replaceChildren(...view.filter((part) => part instanceof Node));
  document.title = match ? `Task ${match[1]} · Rubric on NEAR` : "Rubric on NEAR";
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);

boot();
