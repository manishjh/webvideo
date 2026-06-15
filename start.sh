#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
RTSP_SERVER_LOG="$RUN_DIR/rtsp-server.log"
RTSP_PUBLISHER_LOG="$RUN_DIR/rtsp-publisher.log"
BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
RTSP_PORT="${RTSP_PORT:-8554}"
RTP_PORT="${RTP_PORT:-5004}"
RTCP_PORT="${RTCP_PORT:-5005}"
WEBTRANSPORT_PORT="${WEBTRANSPORT_PORT:-9443}"
START_RTSP="${START_RTSP:-auto}"
START_4K_RTSP="${START_4K_RTSP:-1}"
START_4K_STRESS_RTSP="${START_4K_STRESS_RTSP:-$START_4K_RTSP}"
START_WEBTRANSPORT="${START_WEBTRANSPORT:-1}"
SETUP_RTSP_TOOLS="${SETUP_RTSP_TOOLS:-auto}"
SETUP_QUIC_TOOLS="${SETUP_QUIC_TOOLS:-auto}"
SETUP_RTSP_TOOLS_ONLY="${SETUP_RTSP_TOOLS_ONLY:-0}"
SETUP_QUIC_TOOLS_ONLY="${SETUP_QUIC_TOOLS_ONLY:-0}"
SETUP_SAMPLE_FOOTAGE_ONLY="${SETUP_SAMPLE_FOOTAGE_ONLY:-0}"
WEBVIDEO_SAMPLE_FOOTAGE="${WEBVIDEO_SAMPLE_FOOTAGE:-0}"
WEBVIDEO_RTSP_COPY_INPUTS="${WEBVIDEO_RTSP_COPY_INPUTS:-auto}"
WEBVIDEO_RTSP_FPS="${WEBVIDEO_RTSP_FPS:-30}"
WEBVIDEO_RTSP_ADAPTIVE_FPS="${WEBVIDEO_RTSP_ADAPTIVE_FPS:-15}"
WEBVIDEO_RTSP_4K_FPS="${WEBVIDEO_RTSP_4K_FPS:-15}"
WEBVIDEO_RTSP_4K_STRESS_FPS="${WEBVIDEO_RTSP_4K_STRESS_FPS:-60}"
WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS="${WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS:-24}"
WEBVIDEO_RTSP_4K_STRESS_LOW_FPS="${WEBVIDEO_RTSP_4K_STRESS_LOW_FPS:-15}"
WEBVIDEO_RTSP_EMERGENCY_FPS="${WEBVIDEO_RTSP_EMERGENCY_FPS:-5}"
WEBVIDEO_RTSP_ULTRA_LOW_FPS="${WEBVIDEO_RTSP_ULTRA_LOW_FPS:-2}"
WEBVIDEO_FRONTEND_MODE="${WEBVIDEO_FRONTEND_MODE:-production}"
MEDIAMTX_WRITE_QUEUE_SIZE="${MEDIAMTX_WRITE_QUEUE_SIZE:-8192}"
DEMO_CHANNEL_ID="${DEMO_CHANNEL_ID:-channel-001}"
BACKEND_PROJECT="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/WebVideo.Backend.DemoHost.csproj"
BACKEND_DLL="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/bin/Debug/net10.0/WebVideo.Backend.DemoHost.dll"
RTSP_TOOLS_DIR="$ROOT_DIR/.tools/rtsp"
SAMPLE_FOOTAGE_DIR="$RTSP_TOOLS_DIR/footage"
QUIC_TOOLS_DIR="$ROOT_DIR/.tools/quic"
QUIC_LIB_DIR="$QUIC_TOOLS_DIR/lib"
RTSP_CONFIG="$RUN_DIR/mediamtx.yml"
MEDIAMTX_BIN="${MEDIAMTX_BIN:-}"
FFMPEG_BIN="${FFMPEG_BIN:-}"

mkdir -p "$RUN_DIR" "$RTSP_TOOLS_DIR" "$SAMPLE_FOOTAGE_DIR" "$QUIC_TOOLS_DIR" "$QUIC_LIB_DIR"
RTSP_PUBLISHER_PIDS=()

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
export WEBVIDEO_WEBTRANSPORT_PORT="$WEBTRANSPORT_PORT"
export WEBVIDEO_ENABLE_WEBTRANSPORT="$START_WEBTRANSPORT"
export WEBVIDEO_DEV_CERT_PATH="$RUN_DIR/webtransport-devcert.pfx"
export WEBVIDEO_DEV_CERT_PASSWORD="${WEBVIDEO_DEV_CERT_PASSWORD:-webvideo-dev}"

cleanup() {
  local exit_code=$?

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  for publisher_pid in "${RTSP_PUBLISHER_PIDS[@]:-}"; do
    if [[ -n "$publisher_pid" ]] && kill -0 "$publisher_pid" 2>/dev/null; then
      kill "$publisher_pid" 2>/dev/null || true
    fi
  done

  if [[ -n "${RTSP_SERVER_PID:-}" ]] && kill -0 "$RTSP_SERVER_PID" 2>/dev/null; then
    kill "$RTSP_SERVER_PID" 2>/dev/null || true
  fi

  wait "${FRONTEND_PID:-}" 2>/dev/null || true
  wait "${BACKEND_PID:-}" 2>/dev/null || true
  for publisher_pid in "${RTSP_PUBLISHER_PIDS[@]:-}"; do
    wait "$publisher_pid" 2>/dev/null || true
  done
  wait "${RTSP_SERVER_PID:-}" 2>/dev/null || true

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

wait_for_tcp() {
  local host=$1
  local port=$2
  local label=$3

  for _ in $(seq 1 30); do
    if python3 - "$host" "$port" >/dev/null 2>&1 <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.create_connection((host, port), timeout=1):
    raise SystemExit(0)
PY
    then
      return 0
    fi

    sleep 1
  done

  echo "Timed out waiting for $label at ${host}:${port}" >&2
  return 1
}

wait_for_log() {
  local log_file=$1
  local pattern=$2
  local label=$3

  for _ in $(seq 1 30); do
    if grep -q "$pattern" "$log_file"; then
      return 0
    fi

    if [[ -n "${RTSP_PUBLISHER_PID:-}" ]] && ! kill -0 "$RTSP_PUBLISHER_PID" 2>/dev/null; then
      echo "$label stopped before becoming ready." >&2
      echo "RTSP server log: $RTSP_SERVER_LOG" >&2
      echo "RTSP publisher log: $RTSP_PUBLISHER_LOG" >&2
      return 1
    fi

    sleep 1
  done

  echo "Timed out waiting for $label in $log_file" >&2
  echo "RTSP server log: $RTSP_SERVER_LOG" >&2
  echo "RTSP publisher log: $RTSP_PUBLISHER_LOG" >&2
  return 1
}

require_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    DOWNLOADER="python3"
    return 0
  fi

  echo "Need curl or python3 to download local RTSP tools." >&2
  return 1
}

download_file() {
  local url=$1
  local output=$2

  require_downloader
  if [[ "$DOWNLOADER" == "curl" ]]; then
    curl -fL --retry 3 --connect-timeout 20 --output "$output" "$url"
    return 0
  fi

  python3 - "$url" "$output" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
output = sys.argv[2]
with urllib.request.urlopen(url, timeout=60) as response, open(output, "wb") as target:
    target.write(response.read())
PY
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

should_copy_rtsp_input() {
  local input=$1

  if [[ -z "$input" ]]; then
    return 1
  fi

  case "$WEBVIDEO_RTSP_COPY_INPUTS" in
    auto|"")
      [[ "$input" == "$SAMPLE_FOOTAGE_DIR/"* ]]
      ;;
    *)
      is_truthy "$WEBVIDEO_RTSP_COPY_INPUTS"
      ;;
  esac
}

download_if_missing() {
  local url=$1
  local output=$2
  local label=$3

  if [[ -s "$output" ]]; then
    return 0
  fi

  local tmp="${output}.tmp"
  rm -f "$tmp"
  echo "Downloading $label into $SAMPLE_FOOTAGE_DIR ..."
  download_file "$url" "$tmp"
  mv "$tmp" "$output"
}

normalize_sample_footage() {
  local input=$1
  local output=$2
  local size=$3
  local rate=$4
  local bitrate=$5
  local label=$6

  if [[ -s "$output" ]]; then
    return 0
  fi

  local width="${size%x*}"
  local height="${size#*x}"
  local tmp="${output}.tmp.mp4"
  rm -f "$tmp"
  echo "Normalizing $label to a 30 second H.264 sample ..."
  "$FFMPEG_BIN" \
    -hide_banner \
    -y \
    -stream_loop -1 \
    -i "$input" \
    -t 30 \
    -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1" \
    -r "$rate" \
    -an \
    -c:v libx264 \
    -preset veryfast \
    -tune zerolatency \
    -profile:v baseline \
    -g "$rate" \
    -keyint_min "$rate" \
    -sc_threshold 0 \
    -b:v "$bitrate" \
    -pix_fmt yuv420p \
    -movflags +faststart \
    "$tmp" \
    >/dev/null 2>&1
  mv "$tmp" "$output"
}

prepare_sample_footage_inputs() {
  if ! is_truthy "$WEBVIDEO_SAMPLE_FOOTAGE"; then
    return 0
  fi

  local lobby_rate="${WEBVIDEO_CCTV_LOBBY_RATE:-$WEBVIDEO_RTSP_FPS}"
  local entrance_rate="${WEBVIDEO_CCTV_ENTRANCE_RATE:-$WEBVIDEO_RTSP_FPS}"
  local floor_rate="${WEBVIDEO_CCTV_FLOOR_RATE:-$WEBVIDEO_RTSP_FPS}"
  local adaptive_rate="${WEBVIDEO_CCTV_ADAPTIVE_RATE:-$WEBVIDEO_RTSP_ADAPTIVE_FPS}"
  local parking_rate="${WEBVIDEO_CCTV_4K_RATE:-$WEBVIDEO_RTSP_4K_FPS}"
  local crowd_rate="${WEBVIDEO_CCTV_4K_CROWD_RATE:-$WEBVIDEO_RTSP_4K_STRESS_FPS}"
  local crowd_adaptive_rate="${WEBVIDEO_CCTV_4K_CROWD_ADAPTIVE_RATE:-$WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS}"
  local crowd_low_rate="${WEBVIDEO_CCTV_4K_CROWD_LOW_RATE:-$WEBVIDEO_RTSP_4K_STRESS_LOW_FPS}"
  local emergency_rate="${WEBVIDEO_CCTV_EMERGENCY_RATE:-$WEBVIDEO_RTSP_EMERGENCY_FPS}"
  local ultra_low_rate="${WEBVIDEO_CCTV_ULTRA_LOW_RATE:-$WEBVIDEO_RTSP_ULTRA_LOW_FPS}"

  local sample_base="https://www.c-mor.com/video-surveillance-demo/sample-recordings-of-the-video-surveillance-system-c-mor"
  local crowd_sample_url="https://assets.mixkit.co/videos/4401/4401-720.mp4"
  local lobby_source="$SAMPLE_FOOTAGE_DIR/source-cctv-lobby-720p.mp4"
  local entrance_source="$SAMPLE_FOOTAGE_DIR/source-cctv-entrance-720p.mp4"
  local floor_source="$SAMPLE_FOOTAGE_DIR/source-cctv-floor-1080p.mp4"
  local parking_source="$SAMPLE_FOOTAGE_DIR/source-cctv-parking-1080p.mp4"
  local crowd_source="$SAMPLE_FOOTAGE_DIR/source-cctv-road-crowd-720p.mp4"
  local lobby_sample="$SAMPLE_FOOTAGE_DIR/cctv-lobby-720p-${lobby_rate}fps-30s.mp4"
  local entrance_sample="$SAMPLE_FOOTAGE_DIR/cctv-entrance-720p-${entrance_rate}fps-30s.mp4"
  local floor_sample="$SAMPLE_FOOTAGE_DIR/cctv-floor-1080p-${floor_rate}fps-30s.mp4"
  local lobby_adaptive_sample="$SAMPLE_FOOTAGE_DIR/cctv-lobby-720p-adaptive-${adaptive_rate}fps-30s.mp4"
  local entrance_adaptive_sample="$SAMPLE_FOOTAGE_DIR/cctv-entrance-720p-adaptive-${adaptive_rate}fps-30s.mp4"
  local floor_adaptive_sample="$SAMPLE_FOOTAGE_DIR/cctv-floor-1080p-adaptive-${adaptive_rate}fps-30s.mp4"
  local lobby_emergency_sample="$SAMPLE_FOOTAGE_DIR/cctv-lobby-720p-emergency-${emergency_rate}fps-30s.mp4"
  local entrance_emergency_sample="$SAMPLE_FOOTAGE_DIR/cctv-entrance-720p-emergency-${emergency_rate}fps-30s.mp4"
  local floor_emergency_sample="$SAMPLE_FOOTAGE_DIR/cctv-floor-1080p-emergency-${emergency_rate}fps-30s.mp4"
  local lobby_ultra_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-lobby-720p-ultra-low-${ultra_low_rate}fps-30s.mp4"
  local entrance_ultra_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-entrance-720p-ultra-low-${ultra_low_rate}fps-30s.mp4"
  local floor_ultra_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-floor-1080p-ultra-low-${ultra_low_rate}fps-30s.mp4"
  local parking_sample="$SAMPLE_FOOTAGE_DIR/cctv-parking-4k-${parking_rate}fps-30s.mp4"
  local parking_adaptive_sample="$SAMPLE_FOOTAGE_DIR/cctv-parking-1080p-${parking_rate}fps-30s.mp4"
  local parking_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-parking-720p-${parking_rate}fps-30s.mp4"
  local parking_emergency_sample="$SAMPLE_FOOTAGE_DIR/cctv-parking-720p-emergency-${emergency_rate}fps-30s.mp4"
  local parking_ultra_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-parking-720p-ultra-low-${ultra_low_rate}fps-30s.mp4"
  local crowd_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-4k60-${crowd_rate}fps-30s.mp4"
  local crowd_1080p60_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-1080p60-${crowd_rate}fps-30s.mp4"
  local crowd_adaptive_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-1080p24-${crowd_adaptive_rate}fps-30s.mp4"
  local crowd_720p60_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-720p60-${crowd_rate}fps-30s.mp4"
  local crowd_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-720p15-${crowd_low_rate}fps-30s.mp4"
  local crowd_emergency_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-720p5-${emergency_rate}fps-30s.mp4"
  local crowd_ultra_low_sample="$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-720p2-${ultra_low_rate}fps-30s.mp4"

  download_if_missing "${sample_base}?download=27:motion-detection-entrance-area" "$lobby_source" "CCTV lobby source sample"
  download_if_missing "${sample_base}?download=29:motion-detection-outside-entrance" "$entrance_source" "CCTV entrance source sample"
  download_if_missing "${sample_base}?download=28:motion-detection-warehouse-door" "$floor_source" "CCTV floor source sample"
  normalize_sample_footage "$lobby_source" "$lobby_sample" "1280x720" "$lobby_rate" "4000k" "CCTV lobby"
  normalize_sample_footage "$entrance_source" "$entrance_sample" "1280x720" "$entrance_rate" "4000k" "CCTV entrance"
  normalize_sample_footage "$floor_source" "$floor_sample" "1920x1080" "$floor_rate" "7000k" "CCTV floor"
  normalize_sample_footage "$lobby_source" "$lobby_adaptive_sample" "1280x720" "$adaptive_rate" "2500k" "CCTV lobby adaptive"
  normalize_sample_footage "$entrance_source" "$entrance_adaptive_sample" "1280x720" "$adaptive_rate" "2500k" "CCTV entrance adaptive"
  normalize_sample_footage "$floor_source" "$floor_adaptive_sample" "1920x1080" "$adaptive_rate" "4500k" "CCTV floor adaptive"
  normalize_sample_footage "$lobby_source" "$lobby_emergency_sample" "1280x720" "$emergency_rate" "1500k" "CCTV lobby emergency"
  normalize_sample_footage "$entrance_source" "$entrance_emergency_sample" "1280x720" "$emergency_rate" "1500k" "CCTV entrance emergency"
  normalize_sample_footage "$floor_source" "$floor_emergency_sample" "1920x1080" "$emergency_rate" "2500k" "CCTV floor emergency"
  normalize_sample_footage "$lobby_source" "$lobby_ultra_low_sample" "1280x720" "$ultra_low_rate" "900k" "CCTV lobby ultra low"
  normalize_sample_footage "$entrance_source" "$entrance_ultra_low_sample" "1280x720" "$ultra_low_rate" "900k" "CCTV entrance ultra low"
  normalize_sample_footage "$floor_source" "$floor_ultra_low_sample" "1920x1080" "$ultra_low_rate" "1600k" "CCTV floor ultra low"

  : "${WEBVIDEO_CCTV_LOBBY_INPUT:=$lobby_sample}"
  : "${WEBVIDEO_CCTV_ENTRANCE_INPUT:=$entrance_sample}"
  : "${WEBVIDEO_CCTV_FLOOR_INPUT:=$floor_sample}"
  : "${WEBVIDEO_CCTV_LOBBY_ADAPTIVE_INPUT:=$lobby_adaptive_sample}"
  : "${WEBVIDEO_CCTV_ENTRANCE_ADAPTIVE_INPUT:=$entrance_adaptive_sample}"
  : "${WEBVIDEO_CCTV_FLOOR_ADAPTIVE_INPUT:=$floor_adaptive_sample}"
  : "${WEBVIDEO_CCTV_LOBBY_EMERGENCY_INPUT:=$lobby_emergency_sample}"
  : "${WEBVIDEO_CCTV_ENTRANCE_EMERGENCY_INPUT:=$entrance_emergency_sample}"
  : "${WEBVIDEO_CCTV_FLOOR_EMERGENCY_INPUT:=$floor_emergency_sample}"
  : "${WEBVIDEO_CCTV_LOBBY_ULTRA_LOW_INPUT:=$lobby_ultra_low_sample}"
  : "${WEBVIDEO_CCTV_ENTRANCE_ULTRA_LOW_INPUT:=$entrance_ultra_low_sample}"
  : "${WEBVIDEO_CCTV_FLOOR_ULTRA_LOW_INPUT:=$floor_ultra_low_sample}"

  if is_truthy "$START_4K_RTSP"; then
    download_if_missing "${sample_base}?download=26:motion-detection-computer-room" "$parking_source" "CCTV parking source sample"
    normalize_sample_footage "$parking_source" "$parking_sample" "3840x2160" "$parking_rate" "14000k" "CCTV parking 4K"
    normalize_sample_footage "$parking_source" "$parking_adaptive_sample" "1920x1080" "$parking_rate" "7000k" "CCTV parking 1080p adaptive"
    normalize_sample_footage "$parking_source" "$parking_low_sample" "1280x720" "$parking_rate" "3500k" "CCTV parking 720p adaptive"
    normalize_sample_footage "$parking_source" "$parking_emergency_sample" "1280x720" "$emergency_rate" "1800k" "CCTV parking 720p emergency"
    normalize_sample_footage "$parking_source" "$parking_ultra_low_sample" "1280x720" "$ultra_low_rate" "1000k" "CCTV parking 720p ultra low"
    : "${WEBVIDEO_CCTV_4K_INPUT:=$parking_sample}"
    : "${WEBVIDEO_CCTV_4K_ADAPTIVE_INPUT:=$parking_adaptive_sample}"
    : "${WEBVIDEO_CCTV_4K_LOW_INPUT:=$parking_low_sample}"
    : "${WEBVIDEO_CCTV_4K_EMERGENCY_INPUT:=$parking_emergency_sample}"
    : "${WEBVIDEO_CCTV_4K_ULTRA_LOW_INPUT:=$parking_ultra_low_sample}"
  fi

  if is_truthy "$START_4K_STRESS_RTSP"; then
    download_if_missing "$crowd_sample_url" "$crowd_source" "CCTV road crowd source sample"
    normalize_sample_footage "$crowd_source" "$crowd_sample" "3840x2160" "$crowd_rate" "28000k" "CCTV road crowd 4K60"
    normalize_sample_footage "$crowd_source" "$crowd_1080p60_sample" "1920x1080" "$crowd_rate" "14000k" "CCTV road crowd 1080p60"
    normalize_sample_footage "$crowd_source" "$crowd_adaptive_sample" "1920x1080" "$crowd_adaptive_rate" "7000k" "CCTV road crowd 1080p adaptive"
    normalize_sample_footage "$crowd_source" "$crowd_720p60_sample" "1280x720" "$crowd_rate" "7000k" "CCTV road crowd 720p60"
    normalize_sample_footage "$crowd_source" "$crowd_low_sample" "1280x720" "$crowd_low_rate" "3500k" "CCTV road crowd 720p low"
    normalize_sample_footage "$crowd_source" "$crowd_emergency_sample" "1280x720" "$emergency_rate" "1800k" "CCTV road crowd 720p emergency"
    normalize_sample_footage "$crowd_source" "$crowd_ultra_low_sample" "1280x720" "$ultra_low_rate" "1000k" "CCTV road crowd 720p ultra low"
    : "${WEBVIDEO_CCTV_4K_CROWD_INPUT:=$crowd_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_1080P60_INPUT:=$crowd_1080p60_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_ADAPTIVE_INPUT:=$crowd_adaptive_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_720P60_INPUT:=$crowd_720p60_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_LOW_INPUT:=$crowd_low_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_EMERGENCY_INPUT:=$crowd_emergency_sample}"
    : "${WEBVIDEO_CCTV_4K_CROWD_ULTRA_LOW_INPUT:=$crowd_ultra_low_sample}"
  fi

  export WEBVIDEO_CCTV_LOBBY_INPUT
  export WEBVIDEO_CCTV_ENTRANCE_INPUT
  export WEBVIDEO_CCTV_FLOOR_INPUT
  export WEBVIDEO_CCTV_LOBBY_ADAPTIVE_INPUT
  export WEBVIDEO_CCTV_ENTRANCE_ADAPTIVE_INPUT
  export WEBVIDEO_CCTV_FLOOR_ADAPTIVE_INPUT
  export WEBVIDEO_CCTV_LOBBY_EMERGENCY_INPUT
  export WEBVIDEO_CCTV_ENTRANCE_EMERGENCY_INPUT
  export WEBVIDEO_CCTV_FLOOR_EMERGENCY_INPUT
  export WEBVIDEO_CCTV_LOBBY_ULTRA_LOW_INPUT
  export WEBVIDEO_CCTV_ENTRANCE_ULTRA_LOW_INPUT
  export WEBVIDEO_CCTV_FLOOR_ULTRA_LOW_INPUT
  export WEBVIDEO_CCTV_4K_INPUT
  export WEBVIDEO_CCTV_4K_ADAPTIVE_INPUT
  export WEBVIDEO_CCTV_4K_LOW_INPUT
  export WEBVIDEO_CCTV_4K_EMERGENCY_INPUT
  export WEBVIDEO_CCTV_4K_ULTRA_LOW_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_1080P60_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_ADAPTIVE_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_720P60_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_LOW_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_EMERGENCY_INPUT
  export WEBVIDEO_CCTV_4K_CROWD_ULTRA_LOW_INPUT
}

normalize_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo "amd64"
      ;;
    aarch64|arm64)
      echo "arm64"
      ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

ensure_linux_tool_host() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Automatic RTSP tool setup currently supports Linux only. Set MEDIAMTX_BIN and FFMPEG_BIN manually on this host." >&2
    return 1
  fi
}

resolve_mediamtx_asset_url() {
  local arch=$1

  python3 - "$arch" <<'PY'
import json
import sys
import urllib.request

arch = sys.argv[1]
suffix = f"linux_{arch}.tar.gz"
with urllib.request.urlopen("https://api.github.com/repos/bluenviron/mediamtx/releases/latest", timeout=60) as response:
    release = json.load(response)

for asset in release.get("assets", []):
    name = asset.get("name", "")
    if name.endswith(suffix):
        print(asset["browser_download_url"])
        raise SystemExit(0)

print(f"No mediamtx release asset matched *{suffix}", file=sys.stderr)
raise SystemExit(1)
PY
}

ensure_mediamtx() {
  if [[ -n "$MEDIAMTX_BIN" ]]; then
    return 0
  fi

  if command -v mediamtx >/dev/null 2>&1; then
    MEDIAMTX_BIN="$(command -v mediamtx)"
    return 0
  fi

  local local_bin="$RTSP_TOOLS_DIR/mediamtx"
  if [[ -x "$local_bin" ]]; then
    MEDIAMTX_BIN="$local_bin"
    return 0
  fi

  ensure_linux_tool_host
  local arch
  arch="$(normalize_arch)"
  local asset_url
  asset_url="$(resolve_mediamtx_asset_url "$arch")"
  local archive="$RTSP_TOOLS_DIR/mediamtx-linux-${arch}.tar.gz"

  echo "Downloading mediamtx into $RTSP_TOOLS_DIR ..."
  download_file "$asset_url" "$archive"
  tar -xzf "$archive" -C "$RTSP_TOOLS_DIR" mediamtx
  chmod +x "$local_bin"
  MEDIAMTX_BIN="$local_bin"
}

ensure_ffmpeg() {
  if [[ -n "$FFMPEG_BIN" ]]; then
    return 0
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_BIN="$(command -v ffmpeg)"
    return 0
  fi

  local local_bin="$RTSP_TOOLS_DIR/ffmpeg"
  if [[ -x "$local_bin" ]]; then
    FFMPEG_BIN="$local_bin"
    return 0
  fi

  ensure_linux_tool_host
  local arch
  arch="$(normalize_arch)"
  local ffmpeg_arch="$arch"
  if [[ "$ffmpeg_arch" == "amd64" ]]; then
    ffmpeg_arch="amd64"
  elif [[ "$ffmpeg_arch" == "arm64" ]]; then
    ffmpeg_arch="arm64"
  fi

  local archive="$RTSP_TOOLS_DIR/ffmpeg-release-${ffmpeg_arch}-static.tar.xz"
  local extract_dir="$RTSP_TOOLS_DIR/ffmpeg-extract"
  local url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ffmpeg_arch}-static.tar.xz"

  echo "Downloading ffmpeg static build into $RTSP_TOOLS_DIR ..."
  download_file "$url" "$archive"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  tar -xJf "$archive" -C "$extract_dir" --strip-components=1
  cp "$extract_dir/ffmpeg" "$local_bin"
  chmod +x "$local_bin"
  FFMPEG_BIN="$local_bin"
}

ensure_rtsp_tools() {
  if [[ "$SETUP_RTSP_TOOLS" == "0" || "$SETUP_RTSP_TOOLS" == "false" ]]; then
    if [[ -z "$MEDIAMTX_BIN" ]] && command -v mediamtx >/dev/null 2>&1; then
      MEDIAMTX_BIN="$(command -v mediamtx)"
    fi
    if [[ -z "$FFMPEG_BIN" ]] && command -v ffmpeg >/dev/null 2>&1; then
      FFMPEG_BIN="$(command -v ffmpeg)"
    fi

    if [[ -z "$MEDIAMTX_BIN" || -z "$FFMPEG_BIN" ]]; then
      echo "RTSP tool setup is disabled, but mediamtx or ffmpeg is missing." >&2
      return 1
    fi

    return 0
  fi

  ensure_mediamtx
  ensure_ffmpeg
}

ensure_quic_runtime() {
  if [[ "$START_WEBTRANSPORT" == "0" || "$START_WEBTRANSPORT" == "false" ]]; then
    echo "WebTransport disabled by START_WEBTRANSPORT=$START_WEBTRANSPORT."
    return 0
  fi

  if [[ "$SETUP_QUIC_TOOLS" == "0" || "$SETUP_QUIC_TOOLS" == "false" ]]; then
    export LD_LIBRARY_PATH="$QUIC_LIB_DIR:${LD_LIBRARY_PATH:-}"
    return 0
  fi

  ensure_linux_tool_host
  local arch
  arch="$(normalize_arch)"
  local deb_arch="$arch"
  if [[ "$deb_arch" == "amd64" ]]; then
    deb_arch="amd64"
  elif [[ "$deb_arch" == "arm64" ]]; then
    deb_arch="arm64"
  else
    echo "Unsupported QUIC package architecture: $deb_arch" >&2
    return 1
  fi

  if [[ ! -e "$QUIC_LIB_DIR/libmsquic.so.2" ]]; then
    local libmsquic_version="${LIBMSQUIC_VERSION:-2.5.9~rc}"
    local libmsquic_deb="$QUIC_TOOLS_DIR/libmsquic_${libmsquic_version}_${deb_arch}.deb"
    local libmsquic_extract="$QUIC_TOOLS_DIR/libmsquic-extract"
    local libmsquic_url="https://packages.microsoft.com/ubuntu/24.04/prod/pool/main/libm/libmsquic/libmsquic_${libmsquic_version}_${deb_arch}.deb"

    echo "Downloading libmsquic into $QUIC_TOOLS_DIR ..."
    download_file "$libmsquic_url" "$libmsquic_deb"
    rm -rf "$libmsquic_extract"
    mkdir -p "$libmsquic_extract"
    dpkg-deb -x "$libmsquic_deb" "$libmsquic_extract"
    cp -a "$libmsquic_extract/usr/lib/"*"/libmsquic.so."* "$QUIC_LIB_DIR/"
  fi

  if [[ ! -e "$QUIC_LIB_DIR/libxdp.so.1" ]] && ! ldconfig -p 2>/dev/null | grep -q 'libxdp\.so\.1'; then
    local libxdp_extract="$QUIC_TOOLS_DIR/libxdp-extract"
    local libxdp_deb
    echo "Downloading libxdp1 into $QUIC_TOOLS_DIR ..."
    rm -rf "$libxdp_extract"
    mkdir -p "$libxdp_extract"
    (
      cd "$QUIC_TOOLS_DIR"
      rm -f libxdp1_*_"$deb_arch".deb
      apt-get download libxdp1 >/dev/null
    )
    libxdp_deb="$(find "$QUIC_TOOLS_DIR" -maxdepth 1 -name "libxdp1_*_${deb_arch}.deb" | head -n 1)"
    if [[ -z "$libxdp_deb" ]]; then
      echo "Failed to download libxdp1 for $deb_arch." >&2
      return 1
    fi

    dpkg-deb -x "$libxdp_deb" "$libxdp_extract"
    cp -a "$libxdp_extract/usr/lib/"*"/libxdp.so."* "$QUIC_LIB_DIR/"
  fi

  export LD_LIBRARY_PATH="$QUIC_LIB_DIR:${LD_LIBRARY_PATH:-}"

  if ! python3 - >/dev/null 2>&1 <<'PY'
import ctypes

ctypes.CDLL("libmsquic.so.2")
PY
  then
    echo "libmsquic is not loadable. Check $QUIC_LIB_DIR and LD_LIBRARY_PATH." >&2
    return 1
  fi
}

create_rtsp_concat_loop_input() {
  local path=$1
  local input=$2
  local repeats="${WEBVIDEO_RTSP_CONCAT_REPEATS:-20}"
  local concat_file="$RUN_DIR/rtsp-${path}.ffconcat"

  if ! [[ "$repeats" =~ ^[0-9]+$ ]] || [[ "$repeats" -lt 1 ]]; then
    repeats=20
  fi

  {
    printf 'ffconcat version 1.0\n'
    for _ in $(seq 1 "$repeats"); do
      printf "file '%s'\n" "$input"
    done
  } >"$concat_file"

  printf '%s\n' "$concat_file"
}

publish_rtsp_source() {
  local path=$1
  local size=$2
  local rate=$3
  local bitrate=$4
  local label=$5
  local input=${6:-}

  if should_copy_rtsp_input "$input"; then
    local concat_input
    concat_input="$(create_rtsp_concat_loop_input "$path" "$input")"
    echo "Publishing $label with H.264 stream copy from $input."
    "$FFMPEG_BIN" \
      -hide_banner \
      -loglevel warning \
      -re \
      -fflags +genpts \
      -f concat \
      -safe 0 \
      -stream_loop -1 \
      -i "$concat_input" \
      -map 0:v:0 \
      -an \
      -c:v copy \
      -muxdelay 0 \
      -muxpreload 0 \
      -rtsp_transport tcp \
      -f rtsp \
      "rtsp://127.0.0.1:${RTSP_PORT}/live/${path}" \
      >>"$RTSP_PUBLISHER_LOG" 2>&1 &

    RTSP_PUBLISHER_PID=$!
    RTSP_PUBLISHER_PIDS+=("$RTSP_PUBLISHER_PID")
    wait_for_log "$RTSP_SERVER_LOG" "path live/${path}.*stream is available and online" "$label publisher"
    return 0
  fi

  local ffmpeg_filters=()
  if [[ -n "$input" ]]; then
    local width="${size%x*}"
    local height="${size#*x}"
    ffmpeg_filters+=("scale=${width}:${height}:force_original_aspect_ratio=decrease")
    ffmpeg_filters+=("pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2")
    ffmpeg_filters+=("setsar=1")
  fi

  if "$FFMPEG_BIN" -hide_banner -filters 2>/dev/null | grep -qE '(^|[[:space:]])drawtext([[:space:]]|$)'; then
    ffmpeg_filters+=("drawtext=text='${label} %{pts\\:hms}':x=24:y=24:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.55")
  else
    echo "ffmpeg build does not include drawtext; publishing $path without timestamp overlay."
  fi

  local ffmpeg_filter_args=()
  if [[ ${#ffmpeg_filters[@]} -gt 0 ]]; then
    local filter_graph
    filter_graph="$(IFS=,; echo "${ffmpeg_filters[*]}")"
    ffmpeg_filter_args=(-vf "$filter_graph")
  fi

  local input_args=()
  if [[ -n "$input" ]]; then
    input_args=(-stream_loop -1 -i "$input")
  else
    input_args=(-f lavfi -i "testsrc2=size=${size}:rate=${rate}")
  fi

  "$FFMPEG_BIN" \
    -re \
    "${input_args[@]}" \
    "${ffmpeg_filter_args[@]}" \
    -r "$rate" \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -profile:v baseline \
    -g "$rate" \
    -keyint_min "$rate" \
    -sc_threshold 0 \
    -b:v "$bitrate" \
    -pix_fmt yuv420p \
    -muxdelay 0 \
    -muxpreload 0 \
    -rtsp_transport tcp \
    -f rtsp \
    "rtsp://127.0.0.1:${RTSP_PORT}/live/${path}" \
    >>"$RTSP_PUBLISHER_LOG" 2>&1 &

  RTSP_PUBLISHER_PID=$!
  RTSP_PUBLISHER_PIDS+=("$RTSP_PUBLISHER_PID")
  wait_for_log "$RTSP_SERVER_LOG" "path live/${path}.*stream is available and online" "$label publisher"
}

start_rtsp_source() {
  if [[ "$START_RTSP" == "0" || "$START_RTSP" == "false" ]]; then
    echo "Local RTSP sources disabled by START_RTSP=$START_RTSP."
    return 0
  fi

  local lobby_rate="${WEBVIDEO_CCTV_LOBBY_RATE:-$WEBVIDEO_RTSP_FPS}"
  local entrance_rate="${WEBVIDEO_CCTV_ENTRANCE_RATE:-$WEBVIDEO_RTSP_FPS}"
  local floor_rate="${WEBVIDEO_CCTV_FLOOR_RATE:-$WEBVIDEO_RTSP_FPS}"
  local adaptive_rate="${WEBVIDEO_CCTV_ADAPTIVE_RATE:-$WEBVIDEO_RTSP_ADAPTIVE_FPS}"
  local parking_rate="${WEBVIDEO_CCTV_4K_RATE:-$WEBVIDEO_RTSP_4K_FPS}"
  local crowd_rate="${WEBVIDEO_CCTV_4K_CROWD_RATE:-$WEBVIDEO_RTSP_4K_STRESS_FPS}"
  local crowd_adaptive_rate="${WEBVIDEO_CCTV_4K_CROWD_ADAPTIVE_RATE:-$WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS}"
  local crowd_low_rate="${WEBVIDEO_CCTV_4K_CROWD_LOW_RATE:-$WEBVIDEO_RTSP_4K_STRESS_LOW_FPS}"
  local emergency_rate="${WEBVIDEO_CCTV_EMERGENCY_RATE:-$WEBVIDEO_RTSP_EMERGENCY_FPS}"
  local ultra_low_rate="${WEBVIDEO_CCTV_ULTRA_LOW_RATE:-$WEBVIDEO_RTSP_ULTRA_LOW_FPS}"

  ensure_rtsp_tools
  prepare_sample_footage_inputs

  cat >"$RTSP_CONFIG" <<EOF
logLevel: info
writeQueueSize: ${MEDIAMTX_WRITE_QUEUE_SIZE}
rtsp: yes
rtspAddress: :${RTSP_PORT}
rtspTransports: [tcp]
rtpAddress: :${RTP_PORT}
rtcpAddress: :${RTCP_PORT}
rtmp: no
hls: no
webrtc: no
srt: no
moq: no
paths:
  all_others:
EOF

  "$MEDIAMTX_BIN" "$RTSP_CONFIG" >"$RTSP_SERVER_LOG" 2>&1 &
  RTSP_SERVER_PID=$!

  wait_for_tcp "127.0.0.1" "$RTSP_PORT" "local RTSP server"

  publish_rtsp_source "cctv-lobby-720p" "1280x720" "$lobby_rate" "4000k" "CCTV Lobby" "${WEBVIDEO_CCTV_LOBBY_INPUT:-}"
  publish_rtsp_source "cctv-entrance-720p" "1280x720" "$entrance_rate" "4000k" "CCTV Entrance" "${WEBVIDEO_CCTV_ENTRANCE_INPUT:-}"
  publish_rtsp_source "cctv-floor-1080p" "1920x1080" "$floor_rate" "7000k" "CCTV Floor" "${WEBVIDEO_CCTV_FLOOR_INPUT:-}"
  publish_rtsp_source "cctv-lobby-720p15" "1280x720" "$adaptive_rate" "2500k" "CCTV Lobby adaptive" "${WEBVIDEO_CCTV_LOBBY_ADAPTIVE_INPUT:-}"
  publish_rtsp_source "cctv-entrance-720p15" "1280x720" "$adaptive_rate" "2500k" "CCTV Entrance adaptive" "${WEBVIDEO_CCTV_ENTRANCE_ADAPTIVE_INPUT:-}"
  publish_rtsp_source "cctv-floor-1080p15" "1920x1080" "$adaptive_rate" "4500k" "CCTV Floor adaptive" "${WEBVIDEO_CCTV_FLOOR_ADAPTIVE_INPUT:-}"
  publish_rtsp_source "cctv-lobby-720p5" "1280x720" "$emergency_rate" "1500k" "CCTV Lobby emergency" "${WEBVIDEO_CCTV_LOBBY_EMERGENCY_INPUT:-}"
  publish_rtsp_source "cctv-entrance-720p5" "1280x720" "$emergency_rate" "1500k" "CCTV Entrance emergency" "${WEBVIDEO_CCTV_ENTRANCE_EMERGENCY_INPUT:-}"
  publish_rtsp_source "cctv-floor-1080p5" "1920x1080" "$emergency_rate" "2500k" "CCTV Floor emergency" "${WEBVIDEO_CCTV_FLOOR_EMERGENCY_INPUT:-}"
  publish_rtsp_source "cctv-lobby-720p2" "1280x720" "$ultra_low_rate" "900k" "CCTV Lobby ultra low" "${WEBVIDEO_CCTV_LOBBY_ULTRA_LOW_INPUT:-}"
  publish_rtsp_source "cctv-entrance-720p2" "1280x720" "$ultra_low_rate" "900k" "CCTV Entrance ultra low" "${WEBVIDEO_CCTV_ENTRANCE_ULTRA_LOW_INPUT:-}"
  publish_rtsp_source "cctv-floor-1080p2" "1920x1080" "$ultra_low_rate" "1600k" "CCTV Floor ultra low" "${WEBVIDEO_CCTV_FLOOR_ULTRA_LOW_INPUT:-}"

  if is_truthy "$START_4K_RTSP"; then
    publish_rtsp_source "cctv-parking-4k" "3840x2160" "$parking_rate" "14000k" "CCTV Parking 4K" "${WEBVIDEO_CCTV_4K_INPUT:-}"
    publish_rtsp_source "cctv-parking-1080p15" "1920x1080" "$parking_rate" "7000k" "CCTV Parking 1080p adaptive" "${WEBVIDEO_CCTV_4K_ADAPTIVE_INPUT:-}"
    publish_rtsp_source "cctv-parking-720p15" "1280x720" "$parking_rate" "3500k" "CCTV Parking 720p adaptive" "${WEBVIDEO_CCTV_4K_LOW_INPUT:-}"
    publish_rtsp_source "cctv-parking-720p5" "1280x720" "$emergency_rate" "1800k" "CCTV Parking 720p emergency" "${WEBVIDEO_CCTV_4K_EMERGENCY_INPUT:-}"
    publish_rtsp_source "cctv-parking-720p2" "1280x720" "$ultra_low_rate" "1000k" "CCTV Parking 720p ultra low" "${WEBVIDEO_CCTV_4K_ULTRA_LOW_INPUT:-}"
  fi

  if is_truthy "$START_4K_STRESS_RTSP"; then
    publish_rtsp_source "cctv-road-crowd-4k60" "3840x2160" "$crowd_rate" "28000k" "CCTV Road Crowd 4K60" "${WEBVIDEO_CCTV_4K_CROWD_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-1080p60" "1920x1080" "$crowd_rate" "14000k" "CCTV Road Crowd 1080p60" "${WEBVIDEO_CCTV_4K_CROWD_1080P60_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-1080p24" "1920x1080" "$crowd_adaptive_rate" "7000k" "CCTV Road Crowd 1080p adaptive" "${WEBVIDEO_CCTV_4K_CROWD_ADAPTIVE_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-720p60" "1280x720" "$crowd_rate" "7000k" "CCTV Road Crowd 720p60" "${WEBVIDEO_CCTV_4K_CROWD_720P60_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-720p15" "1280x720" "$crowd_low_rate" "3500k" "CCTV Road Crowd 720p low" "${WEBVIDEO_CCTV_4K_CROWD_LOW_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-720p5" "1280x720" "$emergency_rate" "1800k" "CCTV Road Crowd 720p emergency" "${WEBVIDEO_CCTV_4K_CROWD_EMERGENCY_INPUT:-}"
    publish_rtsp_source "cctv-road-crowd-720p2" "1280x720" "$ultra_low_rate" "1000k" "CCTV Road Crowd 720p ultra low" "${WEBVIDEO_CCTV_4K_CROWD_ULTRA_LOW_INPUT:-}"
  fi

  export WEBVIDEO_CHANNEL_001_FRAMERATE="${WEBVIDEO_CHANNEL_001_FRAMERATE:-$lobby_rate}"
  export WEBVIDEO_CHANNEL_002_FRAMERATE="${WEBVIDEO_CHANNEL_002_FRAMERATE:-$entrance_rate}"
  export WEBVIDEO_CHANNEL_003_FRAMERATE="${WEBVIDEO_CHANNEL_003_FRAMERATE:-$floor_rate}"
  export WEBVIDEO_CHANNEL_4K_FRAMERATE="${WEBVIDEO_CHANNEL_4K_FRAMERATE:-$parking_rate}"
  export WEBVIDEO_CHANNEL_4K_CROWD_FRAMERATE="${WEBVIDEO_CHANNEL_4K_CROWD_FRAMERATE:-$crowd_rate}"
  export WEBVIDEO_RTSP_CAPTURE=1
  export WEBVIDEO_RTSP_CAPTURE_REQUIRED=1
  export WEBVIDEO_FFMPEG_BIN="$FFMPEG_BIN"
}

trap cleanup INT TERM EXIT

: >"$BACKEND_LOG"
: >"$FRONTEND_LOG"
: >"$RTSP_SERVER_LOG"
: >"$RTSP_PUBLISHER_LOG"

if [[ "$SETUP_RTSP_TOOLS_ONLY" == "1" || "$SETUP_RTSP_TOOLS_ONLY" == "true" ]]; then
  ensure_rtsp_tools
  echo "RTSP tools are ready:"
  echo "  mediamtx: $MEDIAMTX_BIN"
  echo "  ffmpeg:   $FFMPEG_BIN"
  exit 0
fi

if [[ "$SETUP_SAMPLE_FOOTAGE_ONLY" == "1" || "$SETUP_SAMPLE_FOOTAGE_ONLY" == "true" ]]; then
  ensure_ffmpeg
  WEBVIDEO_SAMPLE_FOOTAGE=1
  prepare_sample_footage_inputs
  echo "Sample footage is ready:"
  echo "  lobby:    ${WEBVIDEO_CCTV_LOBBY_INPUT:-}"
  echo "  entrance: ${WEBVIDEO_CCTV_ENTRANCE_INPUT:-}"
  echo "  floor:    ${WEBVIDEO_CCTV_FLOOR_INPUT:-}"
  if [[ -n "${WEBVIDEO_CCTV_4K_INPUT:-}" ]]; then
    echo "  4K:       $WEBVIDEO_CCTV_4K_INPUT"
  fi
  if [[ -n "${WEBVIDEO_CCTV_4K_CROWD_INPUT:-}" ]]; then
    echo "  4K crowd: $WEBVIDEO_CCTV_4K_CROWD_INPUT"
  fi
  exit 0
fi

if [[ "$SETUP_QUIC_TOOLS_ONLY" == "1" || "$SETUP_QUIC_TOOLS_ONLY" == "true" ]]; then
  ensure_quic_runtime
  echo "QUIC tools are ready:"
  echo "  libraries: $QUIC_LIB_DIR"
  exit 0
fi

start_rtsp_source
ensure_quic_runtime

"$DOTNET_BIN" build "$BACKEND_PROJECT" -nodeReuse:false -maxcpucount:1 >>"$BACKEND_LOG" 2>&1

"$DOTNET_BIN" "$BACKEND_DLL" \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

if [[ "$WEBVIDEO_FRONTEND_MODE" == "dev" || "$WEBVIDEO_FRONTEND_MODE" == "development" ]]; then
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
    >"$FRONTEND_LOG" 2>&1 &
else
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run build >>"$FRONTEND_LOG" 2>&1
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run preview -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
    >"$FRONTEND_LOG" 2>&1 &
fi
FRONTEND_PID=$!

wait_for_http "http://127.0.0.1:${BACKEND_PORT}/healthz" "backend"
wait_for_http "http://127.0.0.1:${FRONTEND_PORT}/live-demo.html" "frontend"

echo
echo "WebVideo demo is running."
echo "Frontend mode:  $WEBVIDEO_FRONTEND_MODE"
echo "VMS client:     http://127.0.0.1:${FRONTEND_PORT}/vms.html"
if command -v chrome-webgpu >/dev/null 2>&1; then
  echo "WebGPU Chrome:  chrome-webgpu http://127.0.0.1:${FRONTEND_PORT}/vms.html"
else
  echo "WebGPU Chrome:  launch Chrome with --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,VulkanFromANGLE"
fi
echo "Frontend page: http://127.0.0.1:${FRONTEND_PORT}/live-demo.html?channel=${DEMO_CHANNEL_ID}"
echo "Tile wall:     http://127.0.0.1:${FRONTEND_PORT}/tile-wall.html?channels=channel-001,channel-002,channel-003"
if is_truthy "$START_4K_RTSP"; then
  echo "4K tile wall:  http://127.0.0.1:${FRONTEND_PORT}/tile-wall.html?channels=channel-4k,channel-4k-crowd&frames=1"
fi
echo "Backend channels: http://127.0.0.1:${BACKEND_PORT}/api/demo/channels"
echo "WebTransport:    https://127.0.0.1:${WEBTRANSPORT_PORT}/live/${DEMO_CHANNEL_ID}"
echo "RTSP sources:"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-lobby-720p"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-entrance-720p"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-floor-1080p"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-lobby-720p15"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-entrance-720p15"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-floor-1080p15"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-lobby-720p5"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-entrance-720p5"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-floor-1080p5"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-lobby-720p2"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-entrance-720p2"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-floor-1080p2"
if is_truthy "$START_4K_RTSP"; then
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-parking-4k"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-parking-1080p15"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-parking-720p15"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-parking-720p5"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-parking-720p2"
fi
if is_truthy "$START_4K_STRESS_RTSP"; then
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-4k60"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-1080p60"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-1080p24"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-720p60"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-720p15"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-720p5"
  echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-720p2"
fi
echo "Logs:"
echo "  $BACKEND_LOG"
echo "  $FRONTEND_LOG"
echo "  $RTSP_SERVER_LOG"
echo "  $RTSP_PUBLISHER_LOG"
echo
echo "Press Ctrl+C to stop both processes."

wait "$BACKEND_PID" "$FRONTEND_PID"
