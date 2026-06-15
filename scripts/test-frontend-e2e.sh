#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -x "$ROOT_DIR/.tools/node/bin/npm" ]]; then
  NPM_BIN="$ROOT_DIR/.tools/node/bin/npm"
  export PATH="$ROOT_DIR/.tools/node/bin:$PATH"
else
  NPM_BIN="npm"
fi

SERVER_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        break
      fi

      sleep 0.5
    done

    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi

    wait "$SERVER_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

wait_for_http() {
  local url=$1
  local label=$2

  for _ in $(seq 1 120); do
    if python3 - "$url" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url, timeout=1) as response:
    if 200 <= response.status < 400:
        raise SystemExit(0)

raise SystemExit(1)
PY
    then
      return 0
    fi

    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

trap cleanup EXIT INT TERM
mkdir -p "$ROOT_DIR/.run"

if [[ "${WEBVIDEO_PLAYWRIGHT_START_SERVER:-1}" != "0" && "${WEBVIDEO_PLAYWRIGHT_START_SERVER:-1}" != "false" ]]; then
  export WEBVIDEO_PLAYWRIGHT_EXTERNAL_SERVER=1
  (
    cd "$ROOT_DIR"
      START_RTSP="${START_RTSP:-1}" \
      WEBVIDEO_SAMPLE_FOOTAGE="${WEBVIDEO_SAMPLE_FOOTAGE:-1}" \
      START_4K_RTSP="${START_4K_RTSP:-1}" \
      ./start.sh
  ) &
  SERVER_PID=$!

  wait_for_http "http://127.0.0.1:${BACKEND_PORT:-8080}/healthz" "backend"
  wait_for_http "http://127.0.0.1:${FRONTEND_PORT:-4173}/live-demo.html?channel=channel-001" "frontend"
else
  export WEBVIDEO_PLAYWRIGHT_EXTERNAL_SERVER=1
fi

cd "$ROOT_DIR/frontend"
PLAYWRIGHT_ARGS=("$@")
if [[ -n "${WEBVIDEO_PLAYWRIGHT_GREP:-}" ]]; then
  PLAYWRIGHT_ARGS+=(--grep "$WEBVIDEO_PLAYWRIGHT_GREP")
fi

"$NPM_BIN" exec -- playwright test "${PLAYWRIGHT_ARGS[@]}"
