/**
 * Reading a NEAR account's secret key for local development and demos.
 *
 * Keys come from, in order: an explicit environment variable, then the credentials file the NEAR
 * CLI wrote (`~/.near-credentials/<network>/<account>.json`, or `NEAR_CREDENTIALS_DIR`). The value
 * is returned to the caller and never logged. This is for throwaway TESTNET accounts: nothing here
 * is meant to hold a key that guards real money.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KeySource {
  /** The environment variable to check first, e.g. "JUDGE_PRIVATE_KEY". */
  envVar?: string;
  network?: string;
}

const KEY_FORMAT = /^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/;

/** True if `value` looks like an "ed25519:<base58>" secret key. It says nothing about whether it is valid. */
export function looksLikeSecretKey(value: string): boolean {
  return KEY_FORMAT.test(value);
}

export function loadSecretKey(accountId: string, source: KeySource = {}): string {
  const fromEnv = source.envVar ? process.env[source.envVar] : undefined;
  if (fromEnv && fromEnv.trim().length > 0) return validated(fromEnv.trim(), `the ${source.envVar} environment variable`);

  const network = source.network ?? process.env.NEAR_NETWORK ?? "testnet";
  const dir = process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials");
  const file = join(dir, network, `${accountId}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `no key for ${accountId}: set ${source.envVar ?? "its environment variable"}, or create the account with ` +
        `cargo-near so its key is saved to ${file}`
    );
  }
  const parsed = JSON.parse(text) as { private_key?: string; secret_key?: string };
  const key = parsed.private_key ?? parsed.secret_key;
  if (!key) throw new Error(`${file} has no private_key`);
  return validated(key, file);
}

/** The key's SHAPE is checked, and a wrong value is reported WITHOUT echoing it. */
function validated(key: string, where: string): string {
  if (!looksLikeSecretKey(key)) throw new Error(`the key from ${where} is not an "ed25519:..." secret key`);
  return key;
}
