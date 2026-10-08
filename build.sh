#!/usr/bin/env bash
# Builds the multiplayer module into pkg/. Run inside `nix develop`.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --manifest-path net/Cargo.toml --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir pkg \
  net/target/wasm32-unknown-unknown/release/intersched_net.wasm
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
  --enable-reference-types --enable-sign-ext --enable-mutable-globals \
  pkg/intersched_net_bg.wasm -o pkg/intersched_net_bg.wasm
