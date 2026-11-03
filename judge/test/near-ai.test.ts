import { describe, expect, it } from "vitest";
import { DEFAULT_NEAR_AI_MODEL, NEAR_AI_BASE_URL, NearAiModel, classify, type ChatClient } from "../src/near-ai.js";
import { ModelUnavailableError, type ModelRequest } from "../src/models.js";

const request: ModelRequest = { system: "SYS", user: "USER", title: "T", clauses: ["c"], content: "w" };

interface Call {
  body: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

function fakeClient(responses: Array<string | (Error & { status?: number })>) {
  const calls: Call[] = [];
  let i = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        async create(body, options) {
          calls.push({ body, options });
          const next = responses[Math.min(i++, responses.length - 1)];
          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: next ?? null } }] };
        },
      },
    },
  };
  return { client, calls };
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("NearAiModel", () => {
  it("defaults to a documented model and names itself after it", () => {
    const m = new NearAiModel({ apiKey: "k", client: fakeClient(["x"]).client });
    expect(m.name).toBe(`near-ai:${DEFAULT_NEAR_AI_MODEL}`);
    expect(NEAR_AI_BASE_URL).toBe("https://cloud-api.near.ai/v1");
  });

  it("sends the system and user messages, at temperature 0, in JSON mode", async () => {
    const f = fakeClient(['{"ok":true}']);
    const m = new NearAiModel({ apiKey: "k", model: "some/model", client: f.client });
    expect(await m.ask(request)).toBe('{"ok":true}');
    expect(f.calls[0]!.body).toMatchObject({
      model: "some/model",
      temperature: 0,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("applies a request timeout", async () => {
    const f = fakeClient(["x"]);
    await new NearAiModel({ apiKey: "k", client: f.client, timeoutMs: 1234 }).ask(request);
    expect(f.calls[0]!.options).toEqual({ timeout: 1234 });
  });

  it("returns an empty string when the model sends no content", async () => {
    const f = fakeClient([null as unknown as string]);
    expect(await new NearAiModel({ apiKey: "k", client: f.client }).ask(request)).toBe("");
  });

  it("falls back to no JSON mode if the API rejects it, once, and remembers", async () => {
    const f = fakeClient([httpError(400, "response_format json_object is not supported"), "fallback", "second"]);
    const m = new NearAiModel({ apiKey: "k", client: f.client });
    expect(await m.ask(request)).toBe("fallback");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.body.response_format).toBeDefined();
    expect(f.calls[1]!.body.response_format).toBeUndefined();

    expect(await m.ask(request)).toBe("second");
    expect(f.calls[2]!.body.response_format).toBeUndefined();
  });

  it("does not take a 400 about something else as a JSON-mode problem", async () => {
    const f = fakeClient([httpError(400, "context length exceeded")]);
    await expect(new NearAiModel({ apiKey: "k", client: f.client }).ask(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(f.calls).toHaveLength(1);
  });

  it("turns an SDK failure into 'the model could not be asked'", async () => {
    const f = fakeClient([httpError(429, "Rate limit exceeded")]);
    await expect(new NearAiModel({ apiKey: "k", client: f.client }).ask(request)).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("classify", () => {
  it.each([
    [httpError(429, "slow down"), "quota"],
    [httpError(402, "payment required"), "quota"],
    [new Error("You have insufficient credits"), "quota"],
    [new Error("Request timed out"), "timeout"],
    [new Error("ETIMEDOUT"), "timeout"],
    [httpError(503, "bad gateway"), "unreachable"],
    [new Error("fetch failed"), "unreachable"],
    [new Error("getaddrinfo ENOTFOUND cloud-api.near.ai"), "unreachable"],
    [httpError(401, "bad key"), "other"],
    [httpError(403, "forbidden"), "other"],
    [new Error("something strange"), "other"],
  ] as const)("%j -> %s", (error, kind) => {
    const c = classify(error);
    expect(c).toBeInstanceOf(ModelUnavailableError);
    expect(c.kind).toBe(kind);
  });

  it("passes an already-classified error through unchanged", () => {
    const e = new ModelUnavailableError("m", "quota");
    expect(classify(e)).toBe(e);
  });

  it("never repeats the raw message, which can carry a URL or a key", () => {
    const secret = "Bearer sk-SUPERSECRET at https://cloud-api.near.ai/v1/chat?key=abc";
    for (const error of [new Error(secret), httpError(418, secret)]) {
      expect(classify(error).message).not.toMatch(/SUPERSECRET|cloud-api|key=abc/);
    }
  });
});
