/**
 * What the judge needs from a model, and the two models that exist: NEAR AI Cloud (real) and a
 * deterministic offline rule (mock, for demos and tests with no key).
 */

export interface ModelRequest {
  system: string;
  user: string;
  /**
   * The same input, structured. A real model reads `system` and `user` and ignores these; the
   * offline mock reads these instead of parsing a prompt.
   */
  title: string;
  clauses: readonly string[];
  content: string;
}

export interface JudgeModel {
  /** Shown on the record, so a verdict says which model produced it. */
  readonly name: string;
  /** Returns the model's raw reply: a JSON object, possibly wrapped in prose or fences. */
  ask(request: ModelRequest): Promise<string>;
}

/** The model could not be ASKED. That is not a ruling on the work, and the judge never treats it as one. */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "quota" | "timeout" | "unreachable" | "other"
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}
