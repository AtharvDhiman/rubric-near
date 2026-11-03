// A static file server for the dashboard, with no dependencies.
//
//   npm start -w web          then open http://localhost:8080
//
// The dashboard is plain files (web/public) and needs no build. This exists so that "run it" is
// one command on any machine with Node, and so that nothing outside web/public can be served.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "public");

/** @type {Record<string, string>} */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Where a URL path lives on disk, or null if it would leave `root` or is not a valid path.
 * @param {string} urlPath
 * @param {string} [root]
 * @returns {string | null}
 */
export function resolvePath(urlPath, root = ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath.split("?")[0] ?? "").split("#")[0] ?? "");
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const target = resolve(join(root, decoded));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** @param {string} [root] */
export function createStaticServer(root = ROOT) {
  return createServer(async (req, res) => {
    /** @param {number} status @param {string | Buffer} body @param {string} [type] */
    const reply = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "method not allowed\n");

    let file = resolvePath(req.url ?? "/", root);
    if (file === null) return reply(404, "not found\n");
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      reply(200, body, TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    } catch {
      reply(404, "not found\n");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  // Loopback only: this is a viewing aid, not a place to host the page.
  createStaticServer().listen(port, "127.0.0.1", () => {
    console.log(`Rubric dashboard: http://localhost:${port}`);
  });
}
