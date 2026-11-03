#!/usr/bin/env bash
# Rebuild contract/res/rubric_near.wasm from contract/src.
#
# You only need this to change the contract. A built copy is committed, so running the demo and the
# tests needs no Rust at all.
#
# Needs: Rust (the version in contract/rust-toolchain.toml installs itself via rustup), the
# wasm32-unknown-unknown target (also listed there), and cargo-near:
#   https://github.com/near/cargo-near
#
# The build is not reproducible bit for bit across machines (it is not a Docker build), so the hash
# printed here can differ from the committed file's even for identical source. What the committed
# file's hash is, and which source it was built from, is recorded in contract/res/README.md.
set -euo pipefail

cd "$(dirname "$0")/../contract"

cargo near build non-reproducible-wasm

mkdir -p res
cp target/near/rubric_near.wasm res/rubric_near.wasm

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum res/rubric_near.wasm
else
  shasum -a 256 res/rubric_near.wasm
fi
wc -c < res/rubric_near.wasm | awk '{ print $1 " bytes" }'
