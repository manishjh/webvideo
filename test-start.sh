#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export START_RTSP="${START_RTSP:-1}"
export WEBVIDEO_SAMPLE_FOOTAGE="${WEBVIDEO_SAMPLE_FOOTAGE:-1}"
export START_4K_RTSP="${START_4K_RTSP:-0}"
export START_4K_STRESS_RTSP="${START_4K_STRESS_RTSP:-0}"
export WEBVIDEO_RTSP_SOURCE_VARIANTS="${WEBVIDEO_RTSP_SOURCE_VARIANTS:-0}"

exec "$ROOT_DIR/start.sh"
