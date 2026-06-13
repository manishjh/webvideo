#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN_DIR="$ROOT_DIR/.tools/node/bin"

export PATH="$NODE_BIN_DIR:$PATH"

cd "$ROOT_DIR/frontend"
"$NODE_BIN_DIR/npm" run test:unit

