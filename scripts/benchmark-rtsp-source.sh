#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${WEBVIDEO_RTSP_BENCH_SERVER:-go2rtc}"
DURATION_SECONDS="${WEBVIDEO_RTSP_BENCH_DURATION_SECONDS:-20}"
STREAMS="${WEBVIDEO_RTSP_BENCH_STREAMS:-cctv-road-crowd-4k60}"
RTSP_PORT="${WEBVIDEO_RTSP_BENCH_RTSP_PORT:-9654}"
RTP_PORT="${WEBVIDEO_RTSP_BENCH_RTP_PORT:-5704}"
RTCP_PORT="${WEBVIDEO_RTSP_BENCH_RTCP_PORT:-5705}"
GO2RTC_API_PORT="${WEBVIDEO_RTSP_BENCH_GO2RTC_API_PORT:-1989}"
RUN_DIR="${WEBVIDEO_RTSP_BENCH_RUN_DIR:-$ROOT_DIR/.run/rtsp-source-bench-${SERVER}-$(date +%s)}"
OUTPUT_PATH="${WEBVIDEO_RTSP_BENCH_OUTPUT:-$ROOT_DIR/.run/profiles/rtsp-source-${SERVER}-$(date +%s).json}"

if [[ -x "$ROOT_DIR/.tools/rtsp/ffmpeg" ]]; then
  FFMPEG_BIN="$ROOT_DIR/.tools/rtsp/ffmpeg"
else
  FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"
fi

mkdir -p "$RUN_DIR" "$(dirname "$OUTPUT_PATH")"

START_PID=""
CONSUMER_PIDS=()

cleanup() {
  local exit_code=$?

  for pid in "${CONSUMER_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  if [[ -n "$START_PID" ]] && kill -0 "$START_PID" 2>/dev/null; then
    kill "$START_PID" 2>/dev/null || true
  fi

  for pid in "${CONSUMER_PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  if [[ -n "$START_PID" ]]; then
    wait "$START_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

wait_for_tcp() {
  local host=$1
  local port=$2

  for _ in $(seq 1 80); do
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
    sleep 0.25
  done

  echo "Timed out waiting for RTSP source stack on ${host}:${port}" >&2
  return 1
}

wait_for_pid_file() {
  local pid_file=$1

  for _ in $(seq 1 120); do
    if [[ -s "$pid_file" ]]; then
      return 0
    fi
    sleep 0.25
  done

  echo "Timed out waiting for PID file $pid_file" >&2
  return 1
}

trap cleanup INT TERM EXIT

WEBVIDEO_RUN_DIR="$RUN_DIR" \
WEBVIDEO_RTSP_SERVER="$SERVER" \
WEBVIDEO_SAMPLE_FOOTAGE=1 \
START_RTSP_ONLY=1 \
START_WEBTRANSPORT=0 \
START_4K_RTSP="${WEBVIDEO_RTSP_BENCH_START_4K_RTSP:-0}" \
START_4K_STRESS_RTSP="${WEBVIDEO_RTSP_BENCH_START_4K_STRESS_RTSP:-0}" \
WEBVIDEO_RTSP_SOURCE_VARIANTS="${WEBVIDEO_RTSP_BENCH_SOURCE_VARIANTS:-0}" \
RTSP_PORT="$RTSP_PORT" \
RTP_PORT="$RTP_PORT" \
RTCP_PORT="$RTCP_PORT" \
GO2RTC_API_PORT="$GO2RTC_API_PORT" \
"$ROOT_DIR/start.sh" >"$RUN_DIR/start.log" 2>&1 &
START_PID=$!

wait_for_tcp "127.0.0.1" "$RTSP_PORT"
wait_for_pid_file "$RUN_DIR/rtsp-server.pid"

for stream in $STREAMS; do
  "$FFMPEG_BIN" \
    -hide_banner \
    -loglevel error \
    -rtsp_transport tcp \
    -i "rtsp://127.0.0.1:${RTSP_PORT}/live/${stream}" \
    -t "$((DURATION_SECONDS + 3))" \
    -map 0:v:0 \
    -c copy \
    -f null \
    - \
    >"$RUN_DIR/consumer-${stream//\//_}.log" 2>&1 &
  CONSUMER_PIDS+=("$!")
done

# Let lazy producers, especially go2rtc ffmpeg children, come online before sampling.
sleep 2

python3 - "$RUN_DIR" "$SERVER" "$STREAMS" "$DURATION_SECONDS" "$OUTPUT_PATH" <<'PY'
import json
import os
import sys
import time
from pathlib import Path

run_dir = Path(sys.argv[1])
server = sys.argv[2]
streams = sys.argv[3].split()
duration = float(sys.argv[4])
output_path = Path(sys.argv[5])
clock_ticks = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
page_size = os.sysconf("SC_PAGE_SIZE")


def read_pid_file(path):
    if not path.exists():
        return []
    pids = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.isdigit() and Path("/proc", line).exists():
            pids.append(int(line))
    return pids


def process_table():
    table = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        stat_path = entry / "stat"
        try:
            stat = stat_path.read_text()
        except OSError:
            continue
        end = stat.rfind(")")
        if end < 0:
            continue
        fields = stat[end + 2 :].split()
        if len(fields) < 22:
            continue
        pid = int(entry.name)
        ppid = int(fields[1])
        utime = int(fields[11])
        stime = int(fields[12])
        rss_pages = int(fields[21])
        table[pid] = {
            "ppid": ppid,
            "cpu_ticks": utime + stime,
            "rss_bytes": max(0, rss_pages) * page_size,
        }
    return table


def descendants(roots, table):
    wanted = set(pid for pid in roots if pid in table)
    changed = True
    while changed:
        changed = False
        for pid, info in table.items():
            if pid not in wanted and info["ppid"] in wanted:
                wanted.add(pid)
                changed = True
    return wanted


def sample():
    roots = read_pid_file(run_dir / "rtsp-server.pid") + read_pid_file(run_dir / "rtsp-publishers.pids")
    table = process_table()
    pids = descendants(roots, table)
    cpu_ticks = sum(table[pid]["cpu_ticks"] for pid in pids if pid in table)
    rss_bytes = sum(table[pid]["rss_bytes"] for pid in pids if pid in table)
    return {
        "timestamp": time.time(),
        "roots": roots,
        "pids": sorted(pids),
        "processCount": len(pids),
        "cpuTicks": cpu_ticks,
        "rssBytes": rss_bytes,
    }


samples = [sample()]
deadline = time.monotonic() + duration
while time.monotonic() < deadline:
    time.sleep(1)
    samples.append(sample())

first = samples[0]
last = samples[-1]
elapsed = max(0.001, last["timestamp"] - first["timestamp"])
cpu_seconds = max(0.0, (last["cpuTicks"] - first["cpuTicks"]) / clock_ticks)
rss_values = [s["rssBytes"] for s in samples]
result = {
    "server": server,
    "streams": streams,
    "durationSeconds": elapsed,
    "sampleCount": len(samples),
    "cpuSeconds": cpu_seconds,
    "cpuPercentOneCore": cpu_seconds / elapsed * 100.0,
    "rssStartBytes": first["rssBytes"],
    "rssEndBytes": last["rssBytes"],
    "rssMaxBytes": max(rss_values) if rss_values else 0,
    "processCountMax": max(s["processCount"] for s in samples),
    "pidsEnd": last["pids"],
}

output_path.write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
PY

for pid in "${CONSUMER_PIDS[@]:-}"; do
  wait "$pid" 2>/dev/null || true
done

echo
echo "RTSP source benchmark written to: $OUTPUT_PATH"
