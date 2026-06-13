#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOTNET_BIN="$ROOT_DIR/.tools/dotnet/dotnet"

export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
export DOTNET_CLI_HOME="$ROOT_DIR/.tools/dotnet-home"

"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.Contracts.Tests/WebVideo.Backend.Contracts.Tests.csproj"
"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.Specifications.Tests/WebVideo.Backend.Specifications.Tests.csproj"
"$DOTNET_BIN" test "$ROOT_DIR/backend/tests/WebVideo.Backend.DemoHost.Tests/WebVideo.Backend.DemoHost.Tests.csproj"
