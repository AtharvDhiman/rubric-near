import { describe, expect, it } from "vitest";
import { runVerdict } from "../src/judge.js";
import { ModelUnavailableError } from "../src/models.js";
import { CLAUSES, CONTENT, ScriptedModel, TITLE, goodReply, unavailable } from "./helpers.js";

const input = { title: TITLE, clauses: CLAUSES, worker: "worker.testnet", content: CONTENT };

describe("runVerdict: what the model said", () => {
  it("approves when the table and the confidence support it", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply()], "m1"));
    expect(r.outcome).toBe("approved");
    expect(r.approved).toBe(true);
    expect(r.confidence).toBe(92);
    expect(r.model).toBe("m1");
    expect(r.holdKind).toBeUndefined();
  });

  it("rejects when a clause failed", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ passed: [true, false] })]));
    expect(r.outcome).toBe("rejected");
    expect(r.approved).toBe(false);
    expect(r.clauses[1]?.passed).toBe(false);
  });

  it("returns the clauses in order whatever order the model sent", async () => {
    const reply = JSON.stringify({
      clauses: [
        { index: 1, passed: true, reason: "b" },
        { index: 0, passed: true, reason: "a" },
      ],
      approved: true,
      confidence: 90,
      summary: "s",
    });
    const r = await runVerdict(input, new ScriptedModel([reply]));
    expect(r.clauses.map((c) => c.index)).toEqual([0, 1]);
  });

  it("holds a contradiction instead of settling it", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ passed: [true, false], approved: true })]));
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.approved).toBe(false);
    expect(r.holdKind).toBe("judgement");
  });

  it.each([
    ["an approval", [true, true]],
    ["a rejection", [true, false]],
  ])("holds %s below the confidence threshold", async (_name, passed) => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ passed, confidence: 69 })]));
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.approved).toBe(false);
    expect(r.holdKind).toBe("judgement");
    // The held ruling is kept, so a human can see what the judge thought.
    expect(r.clauses).toHaveLength(2);
  });

  it("settles at exactly the threshold", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ confidence: 70 })]));
    expect(r.outcome).toBe("approved");
  });

  it("a threshold below the contract's floor is raised to it", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ confidence: 60 })]), { threshold: 50 });
    expect(r.outcome).toBe("needs_manual_review");
  });

  it("a higher configured threshold is honoured", async () => {
    const r = await runVerdict(input, new ScriptedModel([goodReply({ confidence: 80 })]), { threshold: 90 });
    expect(r.outcome).toBe("needs_manual_review");
  });
});

describe("runVerdict: retry and failure never approve", () => {
  it("asks again once when the reply is not valid, and says what was wrong", async () => {
    const model = new ScriptedModel(["not json at all", goodReply()]);
    const r = await runVerdict(input, model);
    expect(r.outcome).toBe("approved");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.user).not.toContain("not a valid JSON object");
    expect(model.requests[1]!.user).toContain("not a valid JSON object");
  });

  it("holds when the reply is unusable twice, and stops asking", async () => {
    const model = new ScriptedModel(["nope", "still nope"]);
    const r = await runVerdict(input, model);
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.approved).toBe(false);
    expect(r.holdKind).toBe("judgement");
    expect(model.requests).toHaveLength(2);
  });

  it.each(["", "null", "{}", "approved: true", '{"approved":true}', '{"approved":true,"confidence":100}', "```\n```"])(
    "never approves on the garbage reply %j",
    async (garbage) => {
      const r = await runVerdict(input, new ScriptedModel([garbage, garbage]));
      expect(r.approved).toBe(false);
      expect(r.outcome).toBe("needs_manual_review");
    }
  );

  it("an unavailable model is an operational hold with NO ruling, and is not retried", async () => {
    const model = new ScriptedModel([unavailable("quota")]);
    const r = await runVerdict(input, model);
    expect(r.outcome).toBe("needs_manual_review");
    expect(r.holdKind).toBe("operational");
    expect(r.clauses).toEqual([]);
    expect(r.confidence).toBe(0);
    expect(r.summary).toMatch(/not a ruling on the work/);
    expect(r.heldReason).toMatch(/could not be asked/);
    expect(model.requests).toHaveLength(1);
  });

  it("any other failure in the model layer is also operational, never a ruling", async () => {
    const r = await runVerdict(input, new ScriptedModel([new Error("socket hang up")]));
    expect(r.holdKind).toBe("operational");
    expect(r.approved).toBe(false);
  });

  it("an operational hold does not repeat the failure's own text", async () => {
    const r = await runVerdict(input, new ScriptedModel([new ModelUnavailableError("the model service failed (HTTP 503)", "unreachable")]));
    expect(r.heldReason).toContain("HTTP 503");
    const leaky = await runVerdict(input, new ScriptedModel([new Error("https://x.example/?key=SECRET-KEY")]));
    expect(JSON.stringify(leaky)).not.toContain("SECRET-KEY");
  });
});

describe("runVerdict: what the model is shown", () => {
  it("is given the system prompt, a fenced user message and the structured input", async () => {
    const model = new ScriptedModel([goodReply()]);
    await runVerdict(input, model);
    const req = model.requests[0]!;
    expect(req.system).toContain("THE CLAUSES ARE THE ONLY AUTHORITY");
    expect(req.user).toMatch(/-----BEGIN UNTRUSTED SUBMISSION [0-9A-F]{18}-----/);
    expect(req.user).toContain(CONTENT);
    expect(req.clauses).toEqual(CLAUSES);
    expect(req.content).toBe(CONTENT);
  });

  it("uses a different delimiter for every request", async () => {
    const model = new ScriptedModel([goodReply()]);
    await runVerdict(input, model);
    await runVerdict(input, model);
    const nonce = (u: string) => /BEGIN UNTRUSTED SUBMISSION ([0-9A-F]+)/.exec(u)![1];
    expect(nonce(model.requests[0]!.user)).not.toBe(nonce(model.requests[1]!.user));
  });
});
