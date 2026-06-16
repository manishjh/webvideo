#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -x "$ROOT_DIR/.tools/dotnet/dotnet" ]]; then
  DOTNET_BIN="$ROOT_DIR/.tools/dotnet/dotnet"
else
  DOTNET_BIN="dotnet"
fi

export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
export DOTNET_CLI_HOME="$ROOT_DIR/.tools/dotnet-home"
export MSBUILDDISABLENODEREUSE=1

mkdir -p "$ROOT_DIR/.run/profiles"
OUTPUT_PATH="${WEBVIDEO_RTP_MOQ_OUTPUT:-$ROOT_DIR/.run/profiles/rtp-moq-benchmark-$(date +%s).json}"

"$DOTNET_BIN" run \
  --configuration Release \
  --project "$ROOT_DIR/backend/tools/WebVideo.Backend.RtpMoqBench/WebVideo.Backend.RtpMoqBench.csproj" \
  -- \
  --output "$OUTPUT_PATH" \
  "$@"

echo
echo "RTP to MoQ benchmark written to: $OUTPUT_PATH"
