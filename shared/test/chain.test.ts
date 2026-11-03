import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainError, failureMessage, storageAllowance } from "../src/chain.js";
import { loadSecretKey, looksLikeSecretKey } from "../src/credentials.js";
import { NEAR, formatNear, parseNear } from "../src/types.js";

describe("failureMessage", () => {
  it("extracts the contract's own panic text from a failed outcome", () => {
    const failure = {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: only the judge can settle" } },
      },
    };
    expect(failureMessage(failure)).toBe("only the judge can settle");
  });

  it("extracts it from a thrown error's text", () => {
    const error = new Error('{"kind":{"ExecutionError":"Smart contract panicked: the deadline has not passed"}}');
    expect(failureMessage(error)).toBe("the deadline has not passed");
  });

  it("reports a balance problem plainly", () => {
    expect(failureMessage('{"kind":"LackBalanceForState"}')).toBe("LackBalanceForState");
  });

  it("falls back to the text, truncated", () => {
    const msg = failureMessage("x".repeat(1000));
    expect(msg.length).toBeLessThan(400);
    expect(msg.endsWith("...")).toBe(true);
  });

  it("does not throw on something that cannot be stringified", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => failureMessage(cyclic)).not.toThrow();
  });

  it("ChainError carries the message and the transaction", () => {
    const e = new ChainError("seal was refused: nope", "ABC");
    expect(e.message).toBe("seal was refused: nope");
    expect(e.txHash).toBe("ABC");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("exact NEAR amounts", () => {
  it("round-trips without floating point", () => {
    for (const text of ["0", "1", "0.98", "0.000000000000000000000001", "12345.6789", "0.02"]) {
      expect(formatNear(parseNear(text))).toBe(text);
    }
  });

  it("parses to the exact yoctoNEAR", () => {
    expect(parseNear("1")).toBe(NEAR);
    expect(parseNear("0.5")).toBe(NEAR / 2n);
    expect(parseNear("0.02")).toBe(NEAR / 50n);
  });

  it("is exact beyond Number's safe range", () => {
    expect(formatNear(123456789012345678901234567890n)).toBe("123456.78901234567890123456789");
  });

  it.each(["", "abc", "-1", "1.", ".5", "1.1234567890123456789012345", "1e3"])("refuses %j", (bad) => {
    expect(() => parseNear(bad)).toThrow(/not a NEAR amount/);
  });
});

describe("storageAllowance", () => {
  it("grows with the text and is never zero", () => {
    const small = storageAllowance("T", ["One."]);
    const big = storageAllowance("T", Array.from({ length: 8 }, () => "x".repeat(280)));
    expect(small > 0n).toBe(true);
    expect(big > small).toBe(true);
  });

  it("counts bytes, not characters: multi-byte text costs more", () => {
    expect(storageAllowance("T", ["é".repeat(100)]) > storageAllowance("T", ["e".repeat(100)])).toBe(true);
  });

  it("stays well under a NEAR even for the largest rubric", () => {
    const worst = storageAllowance("t".repeat(120), Array.from({ length: 8 }, () => "\u{1F600}".repeat(280)));
    expect(worst < NEAR / 2n).toBe(true);
  });
});

describe("loading a secret key", () => {
  const KEY = `ed25519:${"3".repeat(60)}`;
  let dir: string | undefined;
  const saved = { dir: process.env.NEAR_CREDENTIALS_DIR, env: process.env.TEST_KEY_VAR };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (saved.dir === undefined) delete process.env.NEAR_CREDENTIALS_DIR;
    else process.env.NEAR_CREDENTIALS_DIR = saved.dir;
    if (saved.env === undefined) delete process.env.TEST_KEY_VAR;
    else process.env.TEST_KEY_VAR = saved.env;
  });

  function credentialsFile(account: string, body: unknown) {
    dir = mkdtempSync(join(tmpdir(), "rubric-creds-"));
    mkdirSync(join(dir, "testnet"));
    writeFileSync(join(dir, "testnet", `${account}.json`), JSON.stringify(body));
    process.env.NEAR_CREDENTIALS_DIR = dir;
  }

  it("recognises the shape of a key", () => {
    expect(looksLikeSecretKey(KEY)).toBe(true);
    expect(looksLikeSecretKey("ed25519:")).toBe(false);
    expect(looksLikeSecretKey("secp256k1:abc")).toBe(false);
    expect(looksLikeSecretKey("not a key")).toBe(false);
  });

  it("prefers the environment variable", () => {
    process.env.TEST_KEY_VAR = KEY;
    expect(loadSecretKey("a.testnet", { envVar: "TEST_KEY_VAR" })).toBe(KEY);
  });

  it("reads the credentials file the NEAR CLI writes", () => {
    credentialsFile("a.testnet", { account_id: "a.testnet", public_key: "ed25519:pub", private_key: KEY });
    expect(loadSecretKey("a.testnet")).toBe(KEY);
  });

  it("says where it looked when there is no key", () => {
    dir = mkdtempSync(join(tmpdir(), "rubric-creds-"));
    process.env.NEAR_CREDENTIALS_DIR = dir;
    expect(() => loadSecretKey("missing.testnet", { envVar: "TEST_KEY_VAR" })).toThrow(/no key for missing.testnet/);
  });

  it("rejects a value that is not a key, and never repeats it", () => {
    process.env.TEST_KEY_VAR = "hunter2-this-is-not-a-key";
    let message = "";
    try {
      loadSecretKey("a.testnet", { envVar: "TEST_KEY_VAR" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not an "ed25519:..." secret key/);
    expect(message).not.toContain("hunter2");
  });

  it("rejects a credentials file with no key in it", () => {
    credentialsFile("a.testnet", { account_id: "a.testnet" });
    expect(() => loadSecretKey("a.testnet")).toThrow(/has no private_key/);
  });
});
