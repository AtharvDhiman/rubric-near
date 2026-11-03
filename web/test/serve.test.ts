import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticServer, resolvePath } from "../serve.mjs";

let dir: string;
let root: string;
let server: ReturnType<typeof createStaticServer>;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rubric-web-"));
  root = join(dir, "public");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>home</h1>");
  await writeFile(join(root, "app.js"), "export {}");
  await writeFile(join(root, "data", "v.json"), "{}");
  await writeFile(join(dir, "secret.txt"), "the secret");
  server = createStaticServer(root);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe("resolvePath", () => {
  const R = resolve("/srv/public");
  it("keeps ordinary paths inside the root", () => {
    expect(resolvePath("/", R)).toBe(R);
    expect(resolvePath("/app.js", R)).toBe(resolve(R, "app.js"));
    expect(resolvePath("/data/v.json?x=1#y", R)).toBe(resolve(R, "data", "v.json"));
  });

  it("refuses anything that climbs out of the root, however it is spelled", () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/data/../../secret.txt", "/%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/a\\..\\..\\b", "/x\0y", "/%00", "/%zz"]) {
      expect(resolvePath(p, R), p).toBeNull();
    }
  });

  it("refuses a sibling directory whose name merely starts with the root's", () => {
    expect(resolvePath("/../public-evil/x", R)).toBeNull();
  });
});

describe("the server", () => {
  it("serves the index at / with the right type", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  it("serves scripts and JSON with their types, and tells the browser not to sniff", async () => {
    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/data/v.json`)).headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("will not serve a file outside the root", async () => {
    // fetch() normalises "/../", so send the escape as a raw request path.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolveStatus) => {
      const r = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/%2e%2e/secret.txt", method: "GET" }, (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      r.end();
    });
    expect(status).toBe(404);
  });

  it("answers 404 for a missing file and 405 for anything but GET and HEAD", async () => {
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST", body: "x" })).status).toBe(405);
    const head = await fetch(`${base}/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
