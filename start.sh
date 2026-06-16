#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${WEBVIDEO_RUN_DIR:-$ROOT_DIR/.run}"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
RTSP_SERVER_LOG="$RUN_DIR/rtsp-server.log"
RTSP_PUBLISHER_LOG="$RUN_DIR/rtsp-publisher.log"
BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
RTSP_PORT="${RTSP_PORT:-8554}"
RTP_PORT="${RTP_PORT:-5004}"
RTCP_PORT="${RTCP_PORT:-5005}"
GO2RTC_API_PORT="${GO2RTC_API_PORT:-1984}"
WEBTRANSPORT_PORT="${WEBTRANSPORT_PORT:-9443}"
WEBVIDEO_RTSP_SERVER="${WEBVIDEO_RTSP_SERVER:-go2rtc}"
START_RTSP="${START_RTSP:-auto}"
START_4K_RTSP="${START_4K_RTSP:-1}"
START_4K_STRESS_RTSP="${START_4K_STRESS_RTSP:-$START_4K_RTSP}"
START_WEBTRANSPORT="${START_WEBTRANSPORT:-1}"
WEBVIDEO_RTSP_SOURCE_VARIANTS="${WEBVIDEO_RTSP_SOURCE_VARIANTS:-0}"
SETUP_RTSP_TOOLS="${SETUP_RTSP_TOOLS:-auto}"
SETUP_QUIC_TOOLS="${SETUP_QUIC_TOOLS:-auto}"
SETUP_RTSP_TOOLS_ONLY="${SETUP_RTSP_TOOLS_ONLY:-0}"
SETUP_QUIC_TOOLS_ONLY="${SETUP_QUIC_TOOLS_ONLY:-0}"
SETUP_SAMPLE_FOOTAGE_ONLY="${SETUP_SAMPLE_FOOTAGE_ONLY:-0}"
if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
  WEBVIDEO_SAMPLE_FOOTAGE="${WEBVIDEO_SAMPLE_FOOTAGE:-1}"
else
  WEBVIDEO_SAMPLE_FOOTAGE="${WEBVIDEO_SAMPLE_FOOTAGE:-0}"
fi
START_RTSP_ONLY="${START_RTSP_ONLY:-0}"
WEBVIDEO_RTSP_COPY_INPUTS="${WEBVIDEO_RTSP_COPY_INPUTS:-auto}"
WEBVIDEO_RTSP_FPS="${WEBVIDEO_RTSP_FPS:-30}"
WEBVIDEO_RTSP_ADAPTIVE_FPS="${WEBVIDEO_RTSP_ADAPTIVE_FPS:-15}"
WEBVIDEO_RTSP_4K_FPS="${WEBVIDEO_RTSP_4K_FPS:-15}"
WEBVIDEO_RTSP_4K_STRESS_FPS="${WEBVIDEO_RTSP_4K_STRESS_FPS:-60}"
WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS="${WEBVIDEO_RTSP_4K_STRESS_ADAPTIVE_FPS:-24}"
WEBVIDEO_RTSP_4K_STRESS_LOW_FPS="${WEBVIDEO_RTSP_4K_STRESS_LOW_FPS:-15}"
WEBVIDEO_RTSP_EMERGENCY_FPS="${WEBVIDEO_RTSP_EMERGENCY_FPS:-5}"
WEBVIDEO_RTSP_ULTRA_LOW_FPS="${WEBVIDEO_RTSP_ULTRA_LOW_FPS:-2}"
WEBVIDEO_BACKEND_RTSP_TRANSPORT="${WEBVIDEO_BACKEND_RTSP_TRANSPORT:-tcp}"
WEBVIDEO_FRONTEND_MODE="${WEBVIDEO_FRONTEND_MODE:-production}"
MEDIAMTX_WRITE_QUEUE_SIZE="${MEDIAMTX_WRITE_QUEUE_SIZE:-8192}"
DEMO_CHANNEL_ID="${DEMO_CHANNEL_ID:-channel-4k-crowd}"
BACKEND_PROJECT="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/WebVideo.Backend.DemoHost.csproj"
BACKEND_DLL="$ROOT_DIR/backend/src/WebVideo.Backend.DemoHost/bin/Debug/net10.0/WebVideo.Backend.DemoHost.dll"
RTSP_TOOLS_DIR="$ROOT_DIR/.tools/rtsp"
SAMPLE_FOOTAGE_DIR="${WEBVIDEO_SAMPLE_FOOTAGE_DIR:-$RTSP_TOOLS_DIR/footage}"
QUIC_TOOLS_DIR="$ROOT_DIR/.tools/quic"
QUIC_LIB_DIR="$QUIC_TOOLS_DIR/lib"
RTSP_CONFIG="$RUN_DIR/mediamtx.yml"
GO2RTC_CONFIG="$RUN_DIR/go2rtc.yaml"
MEDIAMTX_BIN="${MEDIAMTX_BIN:-}"
GO2RTC_BIN="${GO2RTC_BIN:-}"
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
export BACKEND_PORT
export FRONTEND_PORT
export WEBTRANSPORT_PORT
export VITE_WEBTRANSPORT_PORT="$WEBTRANSPORT_PORT"
export ASPNETCORE_URLS="http://127.0.0.1:${BACKEND_PORT}"
export MSBUILDDISABLENODEREUSE=1
export WEBVIDEO_WEBTRANSPORT_PORT="$WEBTRANSPORT_PORT"
export WEBVIDEO_ENABLE_WEBTRANSPORT="$START_WEBTRANSPORT"
export WEBVIDEO_DEV_CERT_PATH="$RUN_DIR/webtransport-devcert.pfx"
export WEBVIDEO_DEV_CERT_PASSWORD="${WEBVIDEO_DEV_CERT_PASSWORD:-webvideo-dev}"
export WEBVIDEO_DEMO_SOURCE_VARIANTS="$WEBVIDEO_RTSP_SOURCE_VARIANTS"
export WEBVIDEO_BACKEND_RTSP_TRANSPORT

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

write_rtsp_pid_files() {
  if [[ -n "${RTSP_SERVER_PID:-}" ]]; then
    printf '%s\n' "$RTSP_SERVER_PID" >"$RUN_DIR/rtsp-server.pid"
  fi

  : >"$RUN_DIR/rtsp-publishers.pids"
  for publisher_pid in "${RTSP_PUBLISHER_PIDS[@]:-}"; do
    if [[ -n "$publisher_pid" ]]; then
      printf '%s\n' "$publisher_pid" >>"$RUN_DIR/rtsp-publishers.pids"
    fi
  done
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

require_sample_footage_file() {
  local input=$1
  local label=$2

  if [[ -s "$input" ]]; then
    return 0
  fi

  echo "Missing $label sample footage at $input." >&2
  echo "Place the MP4 at that path or override the matching WEBVIDEO_*_INPUT variable." >&2
  return 1
}

prepare_sample_footage_inputs() {
  if ! is_truthy "$WEBVIDEO_SAMPLE_FOOTAGE"; then
    return 0
  fi

  : "${WEBVIDEO_CCTV_4K_CROWD_INPUT:=$SAMPLE_FOOTAGE_DIR/cctv-road-crowd-4k60-clean-v2-60fps-30s.mp4}"
  : "${WEBVIDEO_DOWNLOAD_13535786_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/13535786_3840_2160_60fps.mp4}"
  : "${WEBVIDEO_DOWNLOAD_15116604_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/15116604_3840_2160_30fps.mp4}"
  : "${WEBVIDEO_DOWNLOAD_15139494_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/15139494_3840_2160_60fps.mp4}"
  : "${WEBVIDEO_DOWNLOAD_15300856_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/15300856_3840_2160_60fps.mp4}"
  : "${WEBVIDEO_DOWNLOAD_15956743_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/15956743_3840_2160_60fps.mp4}"
  : "${WEBVIDEO_DOWNLOAD_16147856_INPUT:=$SAMPLE_FOOTAGE_DIR/downloads/16147856_3840_2160_24fps.mp4}"

  export WEBVIDEO_CCTV_4K_CROWD_INPUT
  export WEBVIDEO_DOWNLOAD_13535786_INPUT
  export WEBVIDEO_DOWNLOAD_15116604_INPUT
  export WEBVIDEO_DOWNLOAD_15139494_INPUT
  export WEBVIDEO_DOWNLOAD_15300856_INPUT
  export WEBVIDEO_DOWNLOAD_15956743_INPUT
  export WEBVIDEO_DOWNLOAD_16147856_INPUT

  require_sample_footage_file "$WEBVIDEO_CCTV_4K_CROWD_INPUT" "CCTV Road Crowd 4K60"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_13535786_INPUT" "Clip 13535786 4K60"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_15116604_INPUT" "Clip 15116604 4K30"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_15139494_INPUT" "Clip 15139494 4K60"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_15300856_INPUT" "Clip 15300856 4K60"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_15956743_INPUT" "Clip 15956743 4K60"
  require_sample_footage_file "$WEBVIDEO_DOWNLOAD_16147856_INPUT" "Clip 16147856 4K24"
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

resolve_go2rtc_asset_url() {
  local arch=$1

  python3 - "$arch" <<'PY'
import json
import sys
import urllib.request

arch = sys.argv[1]
asset_name = f"go2rtc_linux_{arch}"
with urllib.request.urlopen("https://api.github.com/repos/AlexxIT/go2rtc/releases/latest", timeout=60) as response:
    release = json.load(response)

for asset in release.get("assets", []):
    if asset.get("name") == asset_name:
        print(asset["browser_download_url"])
        raise SystemExit(0)

print(f"No go2rtc release asset matched {asset_name}", file=sys.stderr)
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

ensure_go2rtc() {
  if [[ -n "$GO2RTC_BIN" ]]; then
    return 0
  fi

  if command -v go2rtc >/dev/null 2>&1; then
    GO2RTC_BIN="$(command -v go2rtc)"
    return 0
  fi

  local local_bin="$RTSP_TOOLS_DIR/go2rtc"
  if [[ -x "$local_bin" ]]; then
    GO2RTC_BIN="$local_bin"
    return 0
  fi

  ensure_linux_tool_host
  local arch
  arch="$(normalize_arch)"
  local asset_url
  asset_url="$(resolve_go2rtc_asset_url "$arch")"

  echo "Downloading go2rtc into $RTSP_TOOLS_DIR ..."
  download_file "$asset_url" "$local_bin"
  chmod +x "$local_bin"
  GO2RTC_BIN="$local_bin"
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
  case "$WEBVIDEO_RTSP_SERVER" in
    go2rtc|mediamtx)
      ;;
    *)
      echo "Unsupported WEBVIDEO_RTSP_SERVER=$WEBVIDEO_RTSP_SERVER. Expected go2rtc or mediamtx." >&2
      return 1
      ;;
  esac

  if [[ "$SETUP_RTSP_TOOLS" == "0" || "$SETUP_RTSP_TOOLS" == "false" ]]; then
    if [[ "$WEBVIDEO_RTSP_SERVER" == "mediamtx" && -z "$MEDIAMTX_BIN" ]] && command -v mediamtx >/dev/null 2>&1; then
      MEDIAMTX_BIN="$(command -v mediamtx)"
    fi
    if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" && -z "$GO2RTC_BIN" ]] && command -v go2rtc >/dev/null 2>&1; then
      GO2RTC_BIN="$(command -v go2rtc)"
    fi
    if [[ -z "$FFMPEG_BIN" ]] && command -v ffmpeg >/dev/null 2>&1; then
      FFMPEG_BIN="$(command -v ffmpeg)"
    fi

    if [[ "$WEBVIDEO_RTSP_SERVER" == "mediamtx" && -z "$MEDIAMTX_BIN" ]]; then
      echo "RTSP tool setup is disabled, but mediamtx is missing." >&2
      return 1
    fi
    if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" && -z "$GO2RTC_BIN" ]]; then
      echo "RTSP tool setup is disabled, but go2rtc is missing." >&2
      return 1
    fi
    if [[ -z "$FFMPEG_BIN" ]]; then
      echo "RTSP tool setup is disabled, but ffmpeg is missing." >&2
      return 1
    fi

    return 0
  fi

  if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
    ensure_go2rtc
  else
    ensure_mediamtx
  fi
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

yaml_quote() {
  python3 - "$1" <<'PY'
import json
import sys

print(json.dumps(sys.argv[1]))
PY
}

write_go2rtc_config_header() {
  local quoted_ffmpeg_bin
  quoted_ffmpeg_bin="$(yaml_quote "$FFMPEG_BIN")"

  cat >"$GO2RTC_CONFIG" <<EOF
log:
  level: info
api:
  listen: "127.0.0.1:${GO2RTC_API_PORT}"
rtsp:
  listen: "127.0.0.1:${RTSP_PORT}"
webrtc:
  listen: ""
ffmpeg:
  bin: ${quoted_ffmpeg_bin}
  global: "-hide_banner -loglevel warning"
  mp4loop: "-re -stream_loop -1 -fflags +genpts -i {input}"
  lavfi: "-re -f lavfi -i {input}"
streams:
EOF
}

append_go2rtc_stream() {
  local path=$1
  local size=$2
  local rate=$3
  local bitrate=$4
  local label=$5
  local input=${6:-}
  local source

  if should_copy_rtsp_input "$input"; then
    source="ffmpeg:${input}#input=mp4loop#video=copy#audio=copy"
    echo "Serving $label with go2rtc H.264 stream copy from $input." >>"$RTSP_PUBLISHER_LOG"
  elif [[ -n "$input" ]]; then
    source="ffmpeg:${input}#input=mp4loop#video=h264#audio=copy#raw=-r ${rate} -preset ultrafast -tune zerolatency -profile:v baseline -g ${rate} -keyint_min ${rate} -sc_threshold 0 -b:v ${bitrate} -pix_fmt yuv420p"
    echo "Serving $label with go2rtc ffmpeg H.264 transcode from $input." >>"$RTSP_PUBLISHER_LOG"
  else
    source="ffmpeg:testsrc2=size=${size}:rate=${rate}#input=lavfi#video=h264#audio=copy#raw=-preset ultrafast -tune zerolatency -profile:v baseline -g ${rate} -keyint_min ${rate} -sc_threshold 0 -b:v ${bitrate} -pix_fmt yuv420p"
    echo "Serving $label with go2rtc generated H.264 test pattern." >>"$RTSP_PUBLISHER_LOG"
  fi

  printf '  %s: %s\n' "$(yaml_quote "live/${path}")" "$(yaml_quote "$source")" >>"$GO2RTC_CONFIG"
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

register_rtsp_source() {
  if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
    append_go2rtc_stream "$@"
  else
    publish_rtsp_source "$@"
  fi
}

start_rtsp_source() {
  if [[ "$START_RTSP" == "0" || "$START_RTSP" == "false" ]]; then
    echo "Local RTSP sources disabled by START_RTSP=$START_RTSP."
    return 0
  fi

  ensure_rtsp_tools
  prepare_sample_footage_inputs

  if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
    write_go2rtc_config_header
  else
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
  fi

  register_rtsp_source "cctv-road-crowd-4k60" "3840x2160" "60" "28000k" "CCTV Road Crowd 4K60" "${WEBVIDEO_CCTV_4K_CROWD_INPUT:-}"
  register_rtsp_source "download-13535786-4k60" "3840x2160" "60" "33000k" "Clip 13535786 4K60" "${WEBVIDEO_DOWNLOAD_13535786_INPUT:-}"
  register_rtsp_source "download-15116604-4k30" "3840x2160" "30" "72000k" "Clip 15116604 4K30" "${WEBVIDEO_DOWNLOAD_15116604_INPUT:-}"
  register_rtsp_source "download-15139494-4k60" "3840x2160" "60" "32000k" "Clip 15139494 4K60" "${WEBVIDEO_DOWNLOAD_15139494_INPUT:-}"
  register_rtsp_source "download-15300856-4k60" "3840x2160" "59.94" "64000k" "Clip 15300856 4K60" "${WEBVIDEO_DOWNLOAD_15300856_INPUT:-}"
  register_rtsp_source "download-15956743-4k60" "3840x2160" "59.94" "38000k" "Clip 15956743 4K60" "${WEBVIDEO_DOWNLOAD_15956743_INPUT:-}"
  register_rtsp_source "download-16147856-4k24" "3840x2160" "23.98" "17000k" "Clip 16147856 4K24" "${WEBVIDEO_DOWNLOAD_16147856_INPUT:-}"

  if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
    "$GO2RTC_BIN" -c "$GO2RTC_CONFIG" >"$RTSP_SERVER_LOG" 2>&1 &
    RTSP_SERVER_PID=$!
    wait_for_tcp "127.0.0.1" "$RTSP_PORT" "local go2rtc RTSP server"
  fi

  export WEBVIDEO_CHANNEL_4K_CROWD_RTSP_URL="${WEBVIDEO_CHANNEL_4K_CROWD_RTSP_URL:-rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-4k60}"
  export WEBVIDEO_CHANNEL_4K_CROWD_DISPLAY_NAME="${WEBVIDEO_CHANNEL_4K_CROWD_DISPLAY_NAME:-CCTV Road Crowd 4K60}"
  export WEBVIDEO_CHANNEL_4K_CROWD_SUMMARY="${WEBVIDEO_CHANNEL_4K_CROWD_SUMMARY:-Crowd-heavy road junction 4K60 feed retained from the original demo set.}"
  export WEBVIDEO_CHANNEL_4K_CROWD_FRAMERATE="${WEBVIDEO_CHANNEL_4K_CROWD_FRAMERATE:-60}"
  export WEBVIDEO_RTSP_CAPTURE=1
  export WEBVIDEO_RTSP_CAPTURE_REQUIRED=1
  export WEBVIDEO_FFMPEG_BIN="$FFMPEG_BIN"
}

trap cleanup INT TERM EXIT

: >"$BACKEND_LOG"
: >"$FRONTEND_LOG"
: >"$RTSP_SERVER_LOG"
: >"$RTSP_PUBLISHER_LOG"
rm -f "$RUN_DIR/rtsp-server.pid" "$RUN_DIR/rtsp-publishers.pids"

if [[ "$SETUP_RTSP_TOOLS_ONLY" == "1" || "$SETUP_RTSP_TOOLS_ONLY" == "true" ]]; then
  ensure_rtsp_tools
  echo "RTSP tools are ready:"
  echo "  server:   $WEBVIDEO_RTSP_SERVER"
  if [[ "$WEBVIDEO_RTSP_SERVER" == "go2rtc" ]]; then
    echo "  go2rtc:   $GO2RTC_BIN"
  else
    echo "  mediamtx: $MEDIAMTX_BIN"
  fi
  echo "  ffmpeg:   $FFMPEG_BIN"
  exit 0
fi

if [[ "$SETUP_SAMPLE_FOOTAGE_ONLY" == "1" || "$SETUP_SAMPLE_FOOTAGE_ONLY" == "true" ]]; then
  ensure_ffmpeg
  WEBVIDEO_SAMPLE_FOOTAGE=1
  prepare_sample_footage_inputs
  echo "Sample footage is ready:"
  echo "  4K crowd:  ${WEBVIDEO_CCTV_4K_CROWD_INPUT:-}"
  echo "  13535786:  ${WEBVIDEO_DOWNLOAD_13535786_INPUT:-}"
  echo "  15116604:  ${WEBVIDEO_DOWNLOAD_15116604_INPUT:-}"
  echo "  15139494:  ${WEBVIDEO_DOWNLOAD_15139494_INPUT:-}"
  echo "  15300856:  ${WEBVIDEO_DOWNLOAD_15300856_INPUT:-}"
  echo "  15956743:  ${WEBVIDEO_DOWNLOAD_15956743_INPUT:-}"
  echo "  16147856:  ${WEBVIDEO_DOWNLOAD_16147856_INPUT:-}"
  exit 0
fi

if [[ "$SETUP_QUIC_TOOLS_ONLY" == "1" || "$SETUP_QUIC_TOOLS_ONLY" == "true" ]]; then
  ensure_quic_runtime
  echo "QUIC tools are ready:"
  echo "  libraries: $QUIC_LIB_DIR"
  exit 0
fi

start_rtsp_source
write_rtsp_pid_files

if [[ "$START_RTSP_ONLY" == "1" || "$START_RTSP_ONLY" == "true" ]]; then
  echo
  echo "RTSP source stack is running."
  echo "Server: $WEBVIDEO_RTSP_SERVER"
  echo "RTSP:   rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-4k60"
  echo "Logs:"
  echo "  $RTSP_SERVER_LOG"
  echo "  $RTSP_PUBLISHER_LOG"
  echo
  echo "Press Ctrl+C to stop."

  if [[ -n "${RTSP_SERVER_PID:-}" ]]; then
    wait "$RTSP_SERVER_PID"
  else
    while true; do
      sleep 3600
    done
  fi
fi

ensure_quic_runtime

"$DOTNET_BIN" build "$BACKEND_PROJECT" -nodeReuse:false -maxcpucount:1 >>"$BACKEND_LOG" 2>&1

"$DOTNET_BIN" "$BACKEND_DLL" \
  >>"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

if [[ "$WEBVIDEO_FRONTEND_MODE" == "dev" || "$WEBVIDEO_FRONTEND_MODE" == "development" ]]; then
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
    >>"$FRONTEND_LOG" 2>&1 &
else
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run build >>"$FRONTEND_LOG" 2>&1
  "$NPM_BIN" --prefix "$ROOT_DIR/frontend" run preview -- --host 127.0.0.1 --port "$FRONTEND_PORT" \
    >>"$FRONTEND_LOG" 2>&1 &
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
echo "Tile wall:     http://127.0.0.1:${FRONTEND_PORT}/tile-wall.html?channels=channel-4k-crowd,channel-13535786,channel-15139494"
echo "4K tile wall:  http://127.0.0.1:${FRONTEND_PORT}/tile-wall.html?channels=channel-4k-crowd,channel-13535786,channel-15139494,channel-15300856&frames=1"
echo "Backend channels: http://127.0.0.1:${BACKEND_PORT}/api/demo/channels"
echo "WebTransport:    https://127.0.0.1:${WEBTRANSPORT_PORT}/live/${DEMO_CHANNEL_ID}"
echo "RTSP source server: $WEBVIDEO_RTSP_SERVER"
echo "Backend RTSP reader transport: ${WEBVIDEO_BACKEND_RTSP_TRANSPORT}"
if is_truthy "$WEBVIDEO_RTSP_SOURCE_VARIANTS"; then
  echo "Source variants: enabled"
else
  echo "Source variants: disabled; set WEBVIDEO_RTSP_SOURCE_VARIANTS=1 to publish the full ladder"
fi
echo "RTSP sources:"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/cctv-road-crowd-4k60"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-13535786-4k60"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-15116604-4k30"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-15139494-4k60"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-15300856-4k60"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-15956743-4k60"
echo "  rtsp://127.0.0.1:${RTSP_PORT}/live/download-16147856-4k24"
echo "Logs:"
echo "  $BACKEND_LOG"
echo "  $FRONTEND_LOG"
echo "  $RTSP_SERVER_LOG"
echo "  $RTSP_PUBLISHER_LOG"
echo
echo "Press Ctrl+C to stop both processes."

wait "$BACKEND_PID" "$FRONTEND_PID"
