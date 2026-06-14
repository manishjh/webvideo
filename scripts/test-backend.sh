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

"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.Contracts.Tests/WebVideo.Backend.Contracts.Tests.csproj" -nodeReuse:false -maxcpucount:1
"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.Specifications.Tests/WebVideo.Backend.Specifications.Tests.csproj" -nodeReuse:false -maxcpucount:1
"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.DemoHost.Tests/WebVideo.Backend.DemoHost.Tests.csproj" -nodeReuse:false -maxcpucount:1
