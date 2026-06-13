#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
BACKEND_PROJECT="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/WebVideo.Backend.DemoHost.csproj"
BACKEND_DLL="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/bin/Debug/net10.0/WebVideo.Backend.DemoHost.dll"

mkdir -p "$RUN_DIR"

if [[ -x "$ROOT_DIR/.tools/dotnet/dotnet" ]]; then
  DOTNET_BIN="$ROOT_DIR/.tools/dotnet/dotnet"
else
  DOTNET_BIN="dotnet"
fi

if [[ -x "$ROOT_DIR/.tools/node/bin/npm" ]]; then
  NPM_BIN="$ROOT_DIR/.tools/node/bin/npm"
  export PATH="$ROOT_DIR/.tools/node/bin:$PATH"
else
  NPM_BIN="npm"
fi

export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
export DOTNET_CLI_HOME="$ROOT_DIR/.tools/dotnet-home"
export ASPNETCORE_URLS="http://127.0.0.1:${BACKEND_PORT}"
export MSBUILDDISABLENODEREUSE=1

cleanup() {
  local exit_code=$?

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  wait "${FRONTEND_PID:-}" 2>/dev/null || true
  wait "${BACKEND_PID:-}" 2>/dev/null || true

  exit "$exit_code"
}

wait_for_http() {
  local url=$1
  local label=$2

  for _ in $(seq 1 60); do
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
  echo "Backend log: $BACKEND_LOG" >&2
  echo "Frontend log: $FRONTEND_LOG" >&2
  return 1
}

trap cleanup INT TERM EXIT

: >"$BACKEND_LOG"
: >"$FRONTEND_LOG"

"$DOTNET_BIN" build "$BACKEND_PROJECT" -nodeReuse:false -maxcpucount:1 >>"$BACKEND_LOG" 2>&1

"$DOTNET_BIN" "$BACKEND_DLL" \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

"$NPM_BIN" --prefix "$ROOT_DIR/frontend" run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
  >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

wait_for_http "http://127.0.0.1:${BACKEND_PORT}/healthz" "backend"
wait_for_http "http://127.0.0.1:${FRONTEND_PORT}/live-demo.html" "frontend"

echo
echo "WebVideo demo is running."
echo "Frontend page: http://127.0.0.1:${FRONTEND_PORT}/live-demo.html"
echo "Backend JSON:  http://127.0.0.1:${BACKEND_PORT}/api/demo/streams/camera-001"
echo "Logs:"
echo "  $BACKEND_LOG"
echo "  $FRONTEND_LOG"
echo
echo "Press Ctrl+C to stop both processes."

wait "$BACKEND_PID" "$FRONTEND_PID"
