/**
 * The offline judge. NOT A LANGUAGE MODEL.
 *
 * It exists so the demo, the tests and anyone cloning this repository can run the whole loop with
 * no API key and no network. It applies a simple, deterministic, documented rule to each clause,
 * and it says "mock" on every record it produces. It is for showing the flow; it is not a claim
 * about how a real judge rules.
 *
 * The rule, per clause:
 *  - If the clause contains text in double quotes, the clause passes when the submission contains
 *    EVERY quoted phrase (case-insensitive), and fails naming the first missing one.
 *  - Otherwise it passes when the submission mentions at least half of the clause's key words
 *    (words of five or more letters, ignoring a few filler words).
 *  - An empty submission fails every clause, with high confidence.
 *
 * Two markers make the demo flows reachable on purpose:
 *  - "[mock:unsure]" in the submission makes the mock report low confidence, so a task is held.
 *  - Text that tries to instruct the judge ("ignore all previous instructions" and the like) is
 *    NOT obeyed; the mock just notes the attempt in its summary.
 */

import type { JudgeModel, ModelRequest } from "./models.js";

const QUOTED = /["“]([^"”]+)["”]/g;
const FILLER = new Set(["should", "submission", "include", "includes", "contain", "contains", "which", "there", "their", "about", "would", "could"]);
const INJECTION = /ignore (all )?(the )?(previous|prior|above) instructions|you are now|new instructions follow|^\s*system:/im;

export function quotedPhrases(clause: string): string[] {
  return [...clause.matchAll(QUOTED)].map((m) => m[1]!.trim()).filter((p) => p.length > 0);
}

export function keyWords(clause: string): string[] {
  const words = clause.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  return [...new Set(words.filter((w) => !FILLER.has(w)))];
}

interface Ruling {
  index: number;
  passed: boolean;
  reason: string;
}

function ruleClause(clause: string, index: number, content: string): Ruling {
  const text = content.toLowerCase();
  if (content.trim().length === 0) return { index, passed: false, reason: "The submission is empty." };

  const phrases = quotedPhrases(clause);
  if (phrases.length > 0) {
    const missing = phrases.find((p) => !text.includes(p.toLowerCase()));
    return missing === undefined
      ? { index, passed: true, reason: `The submission contains ${phrases.map((p) => `"${p}"`).join(" and ")}.` }
      : { index, passed: false, reason: `The submission does not contain "${missing}".` };
  }

  const words = keyWords(clause);
  if (words.length === 0) {
    return content.trim().length >= 20
      ? { index, passed: true, reason: "The clause names nothing specific to look for, and the submission has substance." }
      : { index, passed: false, reason: "The submission is too short to address the clause." };
  }
  const found = words.filter((w) => text.includes(w));
  const need = Math.ceil(words.length / 2);
  return found.length >= need
    ? { index, passed: true, reason: `The submission addresses the clause: it mentions ${found.slice(0, 3).map((w) => `"${w}"`).join(", ")}.` }
    : { index, passed: false, reason: `The submission mentions only ${found.length} of the ${words.length} key words the clause turns on.` };
}

export class MockModel implements JudgeModel {
  readonly name = "mock";

  async ask(request: ModelRequest): Promise<string> {
    const rulings = request.clauses.map((clause, i) => ruleClause(clause, i, request.content));
    const approved = rulings.every((r) => r.passed);
    const empty = request.content.trim().length === 0;
    const unsure = request.content.includes("[mock:unsure]");
    const attempted = INJECTION.test(request.content);

    const confidence = empty ? 95 : unsure ? 50 : 90;
    const failed = rulings.filter((r) => !r.passed).length;
    const verdict = approved
      ? `Every one of the ${rulings.length} clauses is satisfied.`
      : `${failed} of ${rulings.length} clauses failed; see the rulings.`;
    const note = attempted ? " The submission contained an instruction aimed at the judge, which was ignored." : "";
    return JSON.stringify({ clauses: rulings, approved, confidence, summary: `${verdict}${note} (Offline mock judge.)` });
  }
}
