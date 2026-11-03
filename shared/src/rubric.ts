/**
 * The rubric's canonical form and hash.
 *
 * THIS MUST AGREE WITH THE CONTRACT, byte for byte. The contract computes the clause hash on-chain
 * from the stored text (contract/src/lib.rs, `canonical_rubric`); the judge recomputes it here
 * from the text it READS FROM THE CHAIN, and refuses to rule if the two differ. The golden vectors
 * in test/rubric.test.ts are the same ones pinned in the contract's tests, computed independently.
 */

import { createHash } from "node:crypto";

export const HASH_DOMAIN = "rubric-near/v1";
export const MAX_CLAUSES = 8;
export const MAX_CLAUSE_CHARS = 280;
export const MAX_TITLE_CHARS = 120;

/** The one text a rubric is hashed under. Control characters are forbidden in the text itself, which
 * is what makes joining with newlines unambiguous; the clause count is included as well. */
export function canonicalRubric(title: string, clauses: readonly string[]): string {
  return [HASH_DOMAIN, title, String(clauses.length), ...clauses, ""].join("\n");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashRubric(title: string, clauses: readonly string[]): string {
  return sha256Hex(canonicalRubric(title, clauses));
}

/** Characters, not UTF-16 units: a character outside the Basic Multilingual Plane counts once, as
 * it does in the contract. */
const chars = (s: string) => [...s].length;

/**
 * The same rules the contract enforces, so a client can say what is wrong before spending gas.
 * The contract is the authority: it checks again, and this only mirrors it.
 */
export function rubricProblems(title: string, clauses: readonly string[]): string[] {
  const problems: string[] = [];
  const line = (what: string, text: string, max: number) => {
    if (text.length === 0) problems.push(`${what} must not be empty`);
    else {
      if (text.trim() !== text) problems.push(`${what} must not start or end with whitespace`);
      if (/\p{Cc}/u.test(text)) problems.push(`${what} must not contain control characters or line breaks`);
      if (chars(text) > max) problems.push(`${what} is longer than ${max} characters`);
    }
  };
  line("the title", title, MAX_TITLE_CHARS);
  if (clauses.length === 0) problems.push("a task needs at least one clause");
  if (clauses.length > MAX_CLAUSES) problems.push(`no more than ${MAX_CLAUSES} clauses`);
  clauses.forEach((c, i) => line(`clause ${i + 1}`, c, MAX_CLAUSE_CHARS));
  return problems;
}

/** The submission hash the worker commits to on-chain: SHA-256 (hex) of the submission text as UTF-8. */
export const hashSubmission = sha256Hex;

const HEX64 = /^[0-9a-f]{64}$/;
/** A lowercase hex SHA-256 that is not all zeroes: the same test the contract applies. */
export function isValidHash(s: string): boolean {
  return HEX64.test(s) && /[1-9a-f]/.test(s);
}
