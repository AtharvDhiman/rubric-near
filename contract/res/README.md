# The built contract

`rubric_near.wasm` is the escrow contract, built from [`../src`](../src). It is committed so that
running the sandbox demo and the integration tests needs no Rust.

| | |
|---|---|
| Size | 173,754 bytes |
| SHA-256 | `7e0565981db0573acf062999195c0fd9ee14d423061d8b789e874e08451d9399` |
| NEAR code hash (the same SHA-256, base58) | `9Uw9HnhaJ5EogugRQzdtc2E7o3yF2kdrRRnKU4HFfW7S` |
| Built from | `src/lib.rs` with SHA-256 `80f13943945524b013deb1a2d666eb0462fbc65285dcc2b92527aebfaa598f65`, and the `Cargo.lock` beside it |
| Toolchain | rustc 1.95.0, cargo-near 0.22.0, near-sdk 5.30.0 |

## Check that the file is what it says

```bash
sha256sum contract/res/rubric_near.wasm      # or: shasum -a 256 contract/res/rubric_near.wasm
```

## Check that the testnet deployment runs this exact file

The contract at `rubric-escrow-1d2c.testnet` reports a code hash. It is the same value as the one in
the table, because NEAR's code hash is the SHA-256 of the wasm in base58:

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"rubric-escrow-1d2c.testnet"}}'
```

Look for `"code_hash":"9Uw9HnhaJ5EogugRQzdtc2E7o3yF2kdrRRnKU4HFfW7S"`. This was checked on 2026-11-03.

## Rebuilding

```bash
scripts/build-contract.sh
```

This needs Rust and [cargo-near](https://github.com/near/cargo-near). The build is not a Docker
("reproducible") build, so a different machine or toolchain can produce different bytes from the same
source. That is why the hash of this particular file is recorded above rather than promised for any
rebuild. A rebuild on the machine that produced this file, from a clean `target/`, gave the same bytes.
