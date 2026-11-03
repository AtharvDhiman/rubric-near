import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_CODE, base58, nearCodeHash } from "../src/codehash.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("base58", () => {
  it("matches known encodings", () => {
    expect(base58(new Uint8Array([]))).toBe("");
    expect(base58(Buffer.from("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(base58(Buffer.from("7e0565981db0573acf062999195c0fd9ee14d423061d8b789e874e08451d9399", "hex"))).toBe(
      "9Uw9HnhaJ5EogugRQzdtc2E7o3yF2kdrRRnKU4HFfW7S"
    );
  });

  it("writes each leading zero byte as a 1, and only those", () => {
    expect(base58(new Uint8Array([0]))).toBe("1");
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new Uint8Array([1, 0]))).toBe("5R");
  });

  it("reports an account with no contract as 32 ones, which is 32 zero bytes", () => {
    expect(base58(new Uint8Array(32))).toBe(NO_CODE);
  });
});

describe("the committed contract", () => {
  const wasm = readFileSync(resolve(here, "../../contract/res/rubric_near.wasm"));

  it("has the hash its README and the deployment instructions state", () => {
    const readme = readFileSync(resolve(here, "../../contract/res/README.md"), "utf8");
    const sha = createHash("sha256").update(wasm).digest("hex");
    // If the wasm is rebuilt and recommitted, this fails until the documentation is updated with it.
    expect(readme).toContain(sha);
    expect(readme).toContain(nearCodeHash(wasm));
    expect(readme).toContain(`${wasm.length.toLocaleString("en-US")} bytes`);
  });

  it("is a wasm module", () => {
    expect([...wasm.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
