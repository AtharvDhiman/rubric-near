import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, as NEAR writes hashes and keys. */
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated division of the big-endian number by 58, collecting remainders.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

/** The `code_hash` NEAR reports for a deployed contract: the SHA-256 of its wasm, in base58. */
export function nearCodeHash(wasm: Uint8Array): string {
  return base58(createHash("sha256").update(wasm).digest());
}

/** What an account with no contract reports as its code hash. */
export const NO_CODE = "11111111111111111111111111111111";
