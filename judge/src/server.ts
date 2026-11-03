/**
 * The judge's HTTP interface.
 *
 *   POST /submissions   {"taskId": "3", "content": "..."}   the worker hands over the work text
 *   GET  /verdicts      every verdict the judge has recorded
 *   GET  /verdicts/:id  one verdict, including the exact reasoning text whose hash is on-chain
 *   GET  /health        which mode and contract this is. No secrets.
 *
 * Verdicts are public by design, so GETs allow any origin (the dashboard reads them). POST does
 * not: nothing in a browser has a reason to hand work to the judge from another site.
 */

import http from "node:http";
import type { JudgeOutcome } from "./service.js";
import type { VerdictStore } from "./store.js";

export interface ServerInfo {
  mode: string;
  model: string;
  contract: string;
  judge: string;
  threshold: number;
}

export interface ServerDeps {
  judge: { judgeTask(taskId: string, content: string): Promise<JudgeOutcome> };
  store: VerdictStore;
  info: ServerInfo;
}

export interface ServerOptions {
  maxBodyBytes?: number;
  maxContentChars?: number;
}

const TASK_ID = /^\d{1,20}$/;

function send(res: http.ServerResponse, status: number, body: unknown, cors = false) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...(cors ? { "access-control-allow-origin": "*" } : {}),
  });
  res.end(text);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      // Past the limit, keep draining but keep NOTHING: memory stays bounded, and the response can
      // still be sent. (Destroying the request here would drop the connection before the 413.)
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createJudgeServer(deps: ServerDeps, options: ServerOptions = {}): http.Server {
  const maxBody = options.maxBodyBytes ?? 256 * 1024;
  const maxContent = options.maxContentChars ?? 50_000;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-max-age": "600" });
        return void res.end();
      }

      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, ...deps.info }, true);

      if (req.method === "GET" && path === "/verdicts") return send(res, 200, await deps.store.list(), true);

      const one = /^\/verdicts\/([^/]+)$/.exec(path);
      if (req.method === "GET" && one) {
        const id = decodeURIComponent(one[1]!);
        if (!TASK_ID.test(id)) return send(res, 400, { error: "bad_task_id", message: "a task id is digits only" }, true);
        const verdict = await deps.store.get(id);
        return verdict
          ? send(res, 200, verdict, true)
          : send(res, 404, { error: "not_found", message: "no verdict for that task" }, true);
      }

      if (req.method === "POST" && path === "/submissions") {
        let raw: string;
        try {
          raw = await readBody(req, maxBody);
        } catch (error) {
          if (error instanceof BodyTooLarge) {
            // Answer, then close: a client still sending a huge body is not worth reading to the end.
            res.setHeader("connection", "close");
            res.once("finish", () => req.destroy());
            return send(res, 413, { error: "too_large", message: "the request body is too large" });
          }
          throw error;
        }
        let body: { taskId?: unknown; content?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return send(res, 400, { error: "bad_json", message: "the body must be a JSON object" });
        }
        const taskId = typeof body.taskId === "number" ? String(body.taskId) : body.taskId;
        if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
          return send(res, 400, { error: "bad_task_id", message: "taskId must be a task id (digits only)" });
        }
        if (typeof body.content !== "string") return send(res, 400, { error: "bad_content", message: "content must be a string" });
        if (body.content.length > maxContent) {
          return send(res, 413, { error: "too_large", message: `the submission is longer than ${maxContent} characters` });
        }

        const outcome = await deps.judge.judgeTask(taskId, body.content);
        switch (outcome.status) {
          case "settled":
          case "held":
            return send(res, 200, outcome);
          case "refused": {
            const status = outcome.code === "not_found" ? 404 : outcome.code.endsWith("_mismatch") ? 422 : 409;
            return send(res, status, { error: outcome.code, message: outcome.message });
          }
          case "failed":
            return send(res, 502, { error: "settlement_failed", message: outcome.message });
        }
      }

      return send(res, 404, { error: "not_found", message: "no such route" });
    } catch {
      // Nothing from the error is repeated: it could carry a URL or a header.
      return send(res, 500, { error: "internal", message: "the judge hit an unexpected error" });
    }
  });
}
