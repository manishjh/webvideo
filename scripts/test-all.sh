#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -x "$ROOT_DIR/.tools/node/bin/npm" ]]; then
  NPM_BIN="$ROOT_DIR/.tools/node/bin/npm"
  export PATH="$ROOT_DIR/.tools/node/bin:$PATH"
else
  NPM_BIN="npm"
fi

case "${WEBVIDEO_TEST_PROFILE:-default}" in
  default|"")
    ;;
  hardware-gpu)
    export WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1
    export WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1
    : "${CHROME_WEBGPU_EXECUTABLE:=/usr/bin/google-chrome-stable}"
    export CHROME_WEBGPU_EXECUTABLE
    ;;
  long)
    export WEBVIDEO_E2E_LONG=1
    ;;
  hardware-long)
    export WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1
    export WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1
    export WEBVIDEO_E2E_LONG=1
    : "${CHROME_WEBGPU_EXECUTABLE:=/usr/bin/google-chrome-stable}"
    export CHROME_WEBGPU_EXECUTABLE
    ;;
  hardware-mixed-4k-long)
    export WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1
    export WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1
    export WEBVIDEO_E2E_LONG=1
    export WEBVIDEO_E2E_4K=1
    export START_4K_RTSP=1
    export WEBVIDEO_E2E_LONG_CHANNELS="${WEBVIDEO_E2E_LONG_CHANNELS:-channel-4k,channel-003,channel-001}"
    export WEBVIDEO_E2E_LONG_DURATION_MS="${WEBVIDEO_E2E_LONG_DURATION_MS:-180000}"
    export WEBVIDEO_E2E_LONG_MIN_FPS_RATIO="${WEBVIDEO_E2E_LONG_MIN_FPS_RATIO:-0.25}"
    export WEBVIDEO_E2E_LONG_FRAME_INTERVAL_P95_BUDGET_MS="${WEBVIDEO_E2E_LONG_FRAME_INTERVAL_P95_BUDGET_MS:-300}"
    export WEBVIDEO_E2E_LONG_S2R_P95_BUDGET_MS="${WEBVIDEO_E2E_LONG_S2R_P95_BUDGET_MS:-30000}"
    export WEBVIDEO_E2E_LONG_R2R_P95_BUDGET_MS="${WEBVIDEO_E2E_LONG_R2R_P95_BUDGET_MS:-1200}"
    export WEBVIDEO_E2E_LONG_DROP_RATIO_BUDGET="${WEBVIDEO_E2E_LONG_DROP_RATIO_BUDGET:-0.10}"
    export WEBVIDEO_E2E_LONG_BACKEND_DROP_RATIO_BUDGET="${WEBVIDEO_E2E_LONG_BACKEND_DROP_RATIO_BUDGET:-0.50}"
    : "${CHROME_WEBGPU_EXECUTABLE:=/usr/bin/google-chrome-stable}"
    export CHROME_WEBGPU_EXECUTABLE
    ;;
  4k)
    export WEBVIDEO_E2E_4K=1
    export START_4K_RTSP=1
    ;;
  hardware-4k)
    export WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1
    export WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1
    export WEBVIDEO_E2E_4K=1
    export START_4K_RTSP=1
    : "${CHROME_WEBGPU_EXECUTABLE:=/usr/bin/google-chrome-stable}"
    export CHROME_WEBGPU_EXECUTABLE
    ;;
  *)
    echo "Unknown WEBVIDEO_TEST_PROFILE='${WEBVIDEO_TEST_PROFILE}'." >&2
    echo "Supported profiles: default, hardware-gpu, long, hardware-long, hardware-mixed-4k-long, 4k, hardware-4k." >&2
    exit 2
    ;;
esac

run_step() {
  local label=$1
  shift

  echo
  echo "==> $label"
  "$@"
}

run_step "backend unit/spec/demo-host tests" "$ROOT_DIR/scripts/test-backend.sh"
run_step "frontend unit/contract tests" "$ROOT_DIR/scripts/test-frontend-unit.sh"
run_step "frontend TypeScript typecheck" "$NPM_BIN" --prefix "$ROOT_DIR/frontend" exec -- tsc -p "$ROOT_DIR/frontend/tsconfig.json" --noEmit

if [[ "${SKIP_E2E:-0}" == "1" || "${SKIP_E2E:-}" == "true" ]]; then
  echo
  echo "==> frontend Playwright e2e skipped by SKIP_E2E=${SKIP_E2E}"
else
  run_step "frontend Playwright e2e" "$ROOT_DIR/scripts/test-frontend-e2e.sh"
fi

echo
echo "All requested tests passed."
