import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createJudgeServer } from "../src/server.js";
import { MemoryStore, type StoredVerdict } from "../src/store.js";
import type { JudgeOutcome } from "../src/service.js";

const verdict = (taskId: string): StoredVerdict => ({
  taskId,
  status: "settled",
  outcome: "approved",
  confidence: 92,
  clauses: [{ index: 0, passed: true, reason: "r" }],
  summary: "s",
  model: "mock",
  at: "2026-11-04T10:00:00.000Z",
  reasoningJson: "{}",
  reasoningHash: "a".repeat(64),
  txHash: "TX",
});

let next: JudgeOutcome | Error = { status: "settled", verdict: verdict("0") };
const asked: Array<{ taskId: string; content: string }> = [];
const store = new MemoryStore();
let server: Server;
let base = "";

beforeAll(async () => {
  server = createJudgeServer(
    {
      judge: {
        async judgeTask(taskId, content) {
          asked.push({ taskId, content });
          if (next instanceof Error) throw next;
          return next;
        },
      },
      store,
      info: { mode: "mock", model: "mock", contract: "escrow.testnet", judge: "judge.testnet", threshold: 70 },
    },
    { maxBodyBytes: 2_000, maxContentChars: 500 }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (body: unknown, raw = false) =>
  fetch(`${base}/submissions`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) });

describe("POST /submissions", () => {
  it("hands the work to the judge and returns the outcome", async () => {
    next = { status: "settled", verdict: verdict("3") };
    asked.length = 0;
    const res = await post({ taskId: "3", content: "my work" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("settled");
    expect(asked).toEqual([{ taskId: "3", content: "my work" }]);
  });

  it("accepts a numeric task id", async () => {
    asked.length = 0;
    await post({ taskId: 7, content: "x" });
    expect(asked[0]?.taskId).toBe("7");
  });

  it("returns a hold as a normal 200", async () => {
    next = { status: "held", verdict: { ...verdict("1"), status: "held", outcome: "needs_manual_review" } };
    const res = await post({ taskId: "1", content: "x" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("held");
  });

  it.each([
    ["not JSON", "{nope", 400, "bad_json"],
    ["a missing task id", JSON.stringify({ content: "x" }), 400, "bad_task_id"],
    ["a non-numeric task id", JSON.stringify({ taskId: "abc", content: "x" }), 400, "bad_task_id"],
    ["a path-like task id", JSON.stringify({ taskId: "../../etc/passwd", content: "x" }), 400, "bad_task_id"],
    ["a negative task id", JSON.stringify({ taskId: "-1", content: "x" }), 400, "bad_task_id"],
    ["a non-string content", JSON.stringify({ taskId: "1", content: 5 }), 400, "bad_content"],
    ["content that is too long", JSON.stringify({ taskId: "1", content: "x".repeat(501) }), 413, "too_large"],
    ["a body that is too large", JSON.stringify({ taskId: "1", content: "x".repeat(3_000) }), 413, "too_large"],
  ])("rejects %s", async (_name, body, status, code) => {
    asked.length = 0;
    const res = await post(body, true);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
    expect(asked).toHaveLength(0);
  });

  it.each([
    ["not_found", 404],
    ["not_submitted", 409],
    ["already_judged", 409],
    ["in_progress", 409],
    ["rubric_hash_mismatch", 422],
    ["submission_hash_mismatch", 422],
  ] as const)("maps the refusal %s to HTTP %i", async (code, status) => {
    next = { status: "refused", code, message: "m" };
    const res = await post({ taskId: "1", content: "x" });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });

  it("maps a failed settlement to 502", async () => {
    next = { status: "failed", message: "settle was refused: only the judge can settle" };
    const res = await post({ taskId: "1", content: "x" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("settlement_failed");
  });

  it("an oversized body gets a 413 that tells the client the connection is closing", async () => {
    const res = await post(JSON.stringify({ taskId: "1", content: "x".repeat(3_000) }), true);
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("an unexpected error is a 500 that repeats nothing from the error", async () => {
    next = new Error("https://rpc.example/?api-key=ed25519:SUPERSECRET");
    const res = await post({ taskId: "1", content: "x" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("rpc.example");
  });
});

describe("GET routes", () => {
  it("/health says the mode and contract, and carries no secret", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "mock", contract: "escrow.testnet", judge: "judge.testnet", threshold: 70 });
    expect(JSON.stringify(body)).not.toMatch(/key|secret|ed25519/i);
  });

  it("/verdicts lists what the store holds, oldest first", async () => {
    await store.put(verdict("5"));
    await store.put(verdict("2"));
    const body = (await (await fetch(`${base}/verdicts`)).json()) as StoredVerdict[];
    expect(body.map((v) => v.taskId)).toEqual(["2", "5"]);
  });

  it("/verdicts/:id returns the record, with the reasoning text whose hash is on-chain", async () => {
    await store.put(verdict("8"));
    const body = await (await fetch(`${base}/verdicts/8`)).json();
    expect(body.reasoningJson).toBe("{}");
    expect(body.reasoningHash).toBe("a".repeat(64));
  });

  it("404 for an unknown verdict, 400 for a bad id", async () => {
    expect((await fetch(`${base}/verdicts/999`)).status).toBe(404);
    expect((await fetch(`${base}/verdicts/abc`)).status).toBe(400);
    expect((await fetch(`${base}/verdicts/..%2F..%2Fsecret`)).status).toBe(400);
  });

  it("404 for an unknown route, including a GET on /submissions", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/submissions`)).status).toBe(404);
  });
});

describe("CORS", () => {
  it("allows any origin to READ public verdicts", async () => {
    const res = await fetch(`${base}/verdicts`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does not allow a cross-origin page to POST work to the judge", async () => {
    const res = await post({ taskId: "1", content: "x" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(`${base}/submissions`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET");
  });

  it("never caches", async () => {
    expect((await fetch(`${base}/health`)).headers.get("cache-control")).toBe("no-store");
  });
});
