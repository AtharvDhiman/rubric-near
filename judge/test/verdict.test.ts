import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD,
  applyVerdictGuards,
  confidenceThreshold,
  parseJudgePayload,
  type JudgePayload,
} from "../src/verdict.js";

const ruling = (index: number, passed: boolean, reason = `reason ${index}`) => ({ index, passed, reason });
const payload = (over: Partial<JudgePayload> = {}): JudgePayload => ({
  clauses: [ruling(0, true), ruling(1, true)],
  approved: true,
  confidence: 90,
  summary: "ok",
  ...over,
});

describe("applyVerdictGuards", () => {
  it("approves when every clause passed and confidence clears the threshold", () => {
    expect(applyVerdictGuards(payload(), 2, 70)).toEqual({ outcome: "approved" });
  });

  it("rejects when a clause failed, citing it", () => {
    const p = payload({ clauses: [ruling(0, true), ruling(1, false)], approved: false });
    expect(applyVerdictGuards(p, 2, 70)).toEqual({ outcome: "rejected" });
  });

  it("recomputes approval: a model saying approved over a failing table is held", () => {
    const p = payload({ clauses: [ruling(0, true), ruling(1, false)], approved: true });
    const r = applyVerdictGuards(p, 2, 70);
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.heldReason).toMatch(/contradicted its own per-clause rulings/);
  });

  it("a model saying rejected over an all-pass table is held too", () => {
    const r = applyVerdictGuards(payload({ approved: false }), 2, 70);
    expect(r.outcome).toBe("needs_manual_review");
  });

  it.each([
    ["too few rulings", [ruling(0, true)]],
    ["too many rulings", [ruling(0, true), ruling(1, true), ruling(2, true)]],
    ["a repeated index", [ruling(0, true), ruling(0, true)]],
    ["a stray index", [ruling(0, true), ruling(5, true)]],
    ["a negative index", [ruling(0, true), ruling(-1, true)]],
  ])("holds on %s", (_name, clauses) => {
    const r = applyVerdictGuards(payload({ clauses }), 2, 70);
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.heldReason).toMatch(/rulings for 2 clauses/);
  });

  it("accepts rulings in any order, as long as every index is there once", () => {
    const p = payload({ clauses: [ruling(1, true), ruling(0, true)] });
    expect(applyVerdictGuards(p, 2, 70).outcome).toBe("approved");
  });

  it("holds a rejection that cites no real reason", () => {
    const p = payload({ clauses: [ruling(0, true), ruling(1, false, "   ")], approved: false });
    const r = applyVerdictGuards(p, 2, 70);
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.heldReason).toMatch(/did not cite a specific failed clause/);
  });

  it("the confidence gate applies to approvals AND rejections", () => {
    const approve = applyVerdictGuards(payload({ confidence: 69 }), 2, 70);
    const reject = applyVerdictGuards(
      payload({ clauses: [ruling(0, false), ruling(1, true)], approved: false, confidence: 69 }),
      2,
      70
    );
    for (const r of [approve, reject]) {
      expect(r.outcome).toBe("needs_manual_review");
      expect(r.heldReason).toMatch(/Confidence 69 is below the 70 threshold/);
    }
  });

  it("settles exactly at the threshold", () => {
    expect(applyVerdictGuards(payload({ confidence: 70 }), 2, 70).outcome).toBe("approved");
    expect(applyVerdictGuards(payload({ confidence: 85 }), 2, 85).outcome).toBe("approved");
    expect(applyVerdictGuards(payload({ confidence: 84 }), 2, 85).outcome).toBe("needs_manual_review");
  });

  it("a single-clause rubric works", () => {
    const p = payload({ clauses: [ruling(0, true)] });
    expect(applyVerdictGuards(p, 1, 70).outcome).toBe("approved");
  });
});

describe("parseJudgePayload", () => {
  const good = JSON.stringify(payload());

  it("parses plain JSON", () => {
    expect(parseJudgePayload(good)?.confidence).toBe(90);
  });

  it("parses JSON in a code fence or wrapped in prose", () => {
    expect(parseJudgePayload("```json\n" + good + "\n```")).not.toBeNull();
    expect(parseJudgePayload(`Here is my ruling:\n${good}\nHope that helps.`)).not.toBeNull();
  });

  it("copes with braces inside reasons", () => {
    const p = payload({ clauses: [ruling(0, true, "it printed {x: 1} as asked"), ruling(1, true)] });
    expect(parseJudgePayload(JSON.stringify(p))?.clauses[0]?.reason).toContain("{x: 1}");
  });

  it.each([
    ["empty", ""],
    ["no JSON", "I think it passes."],
    ["broken JSON", '{"clauses": ['],
    ["an array", "[1,2,3]"],
    ["a string", '"approved"'],
    ["missing approved", JSON.stringify({ clauses: [ruling(0, true)], confidence: 90, summary: "s" })],
    ["confidence over 100", JSON.stringify(payload({ confidence: 150 }))],
    ["confidence below 0", JSON.stringify(payload({ confidence: -1 }))],
    ["a fractional confidence", JSON.stringify(payload({ confidence: 90.5 }))],
    ["a non-boolean passed", '{"clauses":[{"index":0,"passed":"yes","reason":"r"}],"approved":true,"confidence":90,"summary":"s"}'],
    ["an empty reason", JSON.stringify(payload({ clauses: [ruling(0, true, "")] }))],
    ["an empty summary", JSON.stringify(payload({ summary: "" }))],
  ])("returns null for %s", (_name, raw) => {
    expect(parseJudgePayload(raw)).toBeNull();
  });
});

describe("confidenceThreshold", () => {
  it("defaults to 70", () => {
    expect(confidenceThreshold({})).toBe(DEFAULT_THRESHOLD);
  });

  it("can be raised", () => {
    expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: "85" })).toBe(85);
    expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: "100" })).toBe(100);
  });

  it("is never below the contract's floor, because a lower one could only produce verdicts the chain refuses", () => {
    expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: "50" })).toBe(70);
    expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: "0" })).toBe(70);
  });

  it("is capped at 100 and falls back to the default on nonsense", () => {
    expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: "250" })).toBe(100);
    for (const bad of ["abc", "", "80.5", "NaN", "Infinity"]) {
      expect(confidenceThreshold({ CONFIDENCE_THRESHOLD: bad }), bad).toBe(70);
    }
  });
});
