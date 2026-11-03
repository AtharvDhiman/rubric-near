import { describe, expect, it } from "vitest";
import {
  MAX_CLAUSE_CHARS,
  canonicalRubric,
  hashRubric,
  hashSubmission,
  isValidHash,
  rubricProblems,
} from "../src/rubric.js";

describe("the clause hash agrees with the contract", () => {
  // The SAME vectors pinned in contract/src/tests.rs, computed independently with Node's crypto.
  // If either side changes the canonical form, both test suites go red.
  const vectors: Array<[string, string[], string]> = [
    [
      "Fix the docs",
      ["The submission lists numbered steps.", "It quotes the exact error text."],
      "85274b4ea772c3a3e6a2da1e3acd995415bff05aa71a8dd0b323504aaba2c018",
    ],
    ["T", ["One."], "fb51a0041d64a5a16f5eeb266df22782f7e8d75b7306d3940335b4d2861f6e84"],
    [
      "Unicode ok",
      ["Café — résumé stays as written."],
      "d4922f425accc8f14837adb7e9e6b0a1936292bdfa1a93f4163bfa309807c735",
    ],
  ];

  it.each(vectors)("%s", (title, clauses, expected) => {
    expect(hashRubric(title, clauses)).toBe(expected);
  });

  it("the canonical text is exactly what the contract builds", () => {
    expect(canonicalRubric("T", ["One."])).toBe("rubric-near/v1\nT\n1\nOne.\n");
  });

  it("is unambiguous: moving text between clauses, or merging clauses, changes it", () => {
    const a = hashRubric("T", ["ab", "c"]);
    const b = hashRubric("T", ["a", "bc"]);
    const c = hashRubric("T", ["abc"]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(hashRubric("T", ["abc"])).not.toBe(hashRubric("U", ["abc"]));
  });

  it("is order-sensitive", () => {
    expect(hashRubric("T", ["one", "two"])).not.toBe(hashRubric("T", ["two", "one"]));
  });
});

describe("hashSubmission", () => {
  it("is SHA-256 of the UTF-8 text, in lowercase hex", () => {
    expect(hashSubmission("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashSubmission("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is sensitive to a single character", () => {
    expect(hashSubmission("done.")).not.toBe(hashSubmission("done!"));
  });
});

describe("isValidHash", () => {
  it("accepts a lowercase 64-character hex digest", () => {
    expect(isValidHash(hashSubmission("x"))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "abc"],
    ["all zero", "0".repeat(64)],
    ["uppercase", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
    ["too long", `${"a".repeat(64)}0`],
  ])("rejects %s", (_name, value) => {
    expect(isValidHash(value)).toBe(false);
  });
});

describe("rubricProblems mirrors the contract's rules", () => {
  it("a good rubric has none", () => {
    expect(rubricProblems("Fix the docs", ["One clause."])).toEqual([]);
  });

  it("names each problem", () => {
    expect(rubricProblems("", ["x"])).toContain("the title must not be empty");
    expect(rubricProblems("T", [])).toContain("a task needs at least one clause");
    expect(rubricProblems("T", Array.from({ length: 9 }, (_, i) => `c${i}`))).toContain("no more than 8 clauses");
    expect(rubricProblems("T", [""])).toContain("clause 1 must not be empty");
    expect(rubricProblems("T", [" padded"])).toContain("clause 1 must not start or end with whitespace");
    expect(rubricProblems("T", ["two\nlines"])).toContain("clause 1 must not contain control characters or line breaks");
    expect(rubricProblems("T", ["tab\there"])).toContain("clause 1 must not contain control characters or line breaks");
    expect(rubricProblems("T", ["x".repeat(MAX_CLAUSE_CHARS + 1)])).toContain("clause 1 is longer than 280 characters");
  });

  it("counts characters, not UTF-16 units: 280 emoji is allowed, 281 is not", () => {
    expect(rubricProblems("T", ["\u{1F600}".repeat(280)])).toEqual([]);
    expect(rubricProblems("T", ["\u{1F600}".repeat(281)])).toContain("clause 1 is longer than 280 characters");
  });

  it("reports every problem, not just the first", () => {
    const problems = rubricProblems(" ", ["", "ok", "bad\n"]);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
