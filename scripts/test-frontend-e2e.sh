#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN_DIR="$ROOT_DIR/.tools/node/bin"
LIB_DIR_A="$ROOT_DIR/.tools/browser-libs/root/usr/lib/x86_64-linux-gnu"
LIB_DIR_B="$ROOT_DIR/.tools/browser-libs/root/lib/x86_64-linux-gnu"

export PATH="$NODE_BIN_DIR:$PATH"
export LD_LIBRARY_PATH="$LIB_DIR_A:$LIB_DIR_B${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd "$ROOT_DIR/frontend"
"$NODE_BIN_DIR/npm" run test:serve >/tmp/webvideo-vite.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT

python3 - <<'PY'
import socket
import time

deadline = time.time() + 15
while time.time() < deadline:
    sock = socket.socket()
    try:
        sock.connect(("127.0.0.1", 4173))
        sock.close()
        break
    except OSError:
        time.sleep(0.25)
else:
    raise SystemExit("Timed out waiting for the Vite test server on 127.0.0.1:4173.")
PY

"$NODE_BIN_DIR/npm" run test:e2e

