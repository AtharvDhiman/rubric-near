/**
 * The real judge model: NEAR AI Cloud, through its OpenAI-compatible API.
 *
 * Base URL, bearer key and the model catalogue are documented at docs.near.ai (the gateway is
 * https://cloud-api.near.ai/v1). The key is read from the environment by the caller and held in
 * memory here; it is never logged.
 */

import OpenAI from "openai";
import { ModelUnavailableError, type JudgeModel, type ModelRequest } from "./models.js";

export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
/** Overridable with NEAR_AI_MODEL; any model in https://cloud-api.near.ai/v1/model/list works. */
export const DEFAULT_NEAR_AI_MODEL = "anthropic/claude-sonnet-5-5";

/** The slice of the OpenAI client this uses, so a test can supply a fake with no network. */
export interface ChatClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

export interface NearAiOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  client?: ChatClient;
}

export class NearAiModel implements JudgeModel {
  readonly name: string;
  private readonly client: ChatClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  /** Cleared if the API rejects JSON mode, so the next request does not repeat the mistake. */
  private jsonMode = true;

  constructor(options: NearAiOptions) {
    this.model = options.model ?? DEFAULT_NEAR_AI_MODEL;
    this.name = `near-ai:${this.model}`;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL ?? NEAR_AI_BASE_URL,
        // The judge does its own bounded retry; keep the SDK's to a single extra attempt.
        maxRetries: 1,
      }) as unknown as ChatClient);
  }

  async ask(request: ModelRequest): Promise<string> {
    const body = (json: boolean): Record<string, unknown> => ({
      model: this.model,
      // The same input should give the same ruling as far as the model allows.
      temperature: 0,
      max_tokens: 2_000,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });

    try {
      return await this.send(body(this.jsonMode));
    } catch (error) {
      // Some models reject JSON mode. Say so once, fall back to asking for JSON in the prompt
      // (which it already does), and try again; any other failure is not about that.
      if (this.jsonMode && statusOf(error) === 400 && /response_format|json/i.test(messageOf(error))) {
        this.jsonMode = false;
        try {
          return await this.send(body(false));
        } catch (retry) {
          throw classify(retry);
        }
      }
      throw classify(error);
    }
  }

  private async send(body: Record<string, unknown>): Promise<string> {
    const response = await this.client.chat.completions.create(body, { timeout: this.timeoutMs });
    return response.choices[0]?.message?.content ?? "";
  }
}

const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;
const messageOf = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error);

/** Turn an SDK or network failure into "the model could not be asked", with a reason that never carries the key. */
export function classify(error: unknown): ModelUnavailableError {
  if (error instanceof ModelUnavailableError) return error;
  const status = statusOf(error);
  const text = messageOf(error);
  if (status === 429 || /rate limit|quota|insufficient (credits|funds)|payment required/i.test(text) || status === 402) {
    return new ModelUnavailableError("the model is rate limited or out of credits", "quota");
  }
  if (/timed? ?out|timeout|ETIMEDOUT|aborted/i.test(text)) {
    return new ModelUnavailableError("the model did not answer in time", "timeout");
  }
  if (status !== undefined && status >= 500) return new ModelUnavailableError(`the model service failed (HTTP ${status})`, "unreachable");
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(text)) {
    return new ModelUnavailableError("the model service could not be reached", "unreachable");
  }
  if (status === 401 || status === 403) return new ModelUnavailableError("the model service refused the API key", "other");
  // The fixed sentence only. The raw message can carry a URL or a header, so it is not repeated.
  return new ModelUnavailableError("the model could not be asked", "other");
}
