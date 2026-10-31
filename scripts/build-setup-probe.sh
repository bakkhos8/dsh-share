#!/usr/bin/env bash
# Compile the disposable native Trash probe used only by automated tests.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:?expected output path}"
CACHE="${DSH_SETUP_PROBE_BUILD_DIR:-$(dirname "$OUTPUT")}/.module-cache"
XCODE_SWIFTC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc
XCODE_SDK=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
if [[ -n "${SWIFTC:-}" ]]; then SWIFT="$SWIFTC"
elif [[ -x "$XCODE_SWIFTC" ]]; then SWIFT="$XCODE_SWIFTC"
else SWIFT="$(xcrun -f swiftc)"; fi
if [[ -n "${SDK:-}" ]]; then MACOS_SDK="$SDK"
elif [[ -d "$XCODE_SDK" ]]; then MACOS_SDK="$XCODE_SDK"
else MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path)"; fi
mkdir -p "$CACHE" "$(dirname "$OUTPUT")"
"$SWIFT" -sdk "$MACOS_SDK" -module-cache-path "$CACHE" -O -parse-as-library -framework Foundation -framework AppKit "$ROOT/apps/DSHShare/App/SetupInstaller.swift" "$ROOT/tests/fixtures/trash.swift" -o "$OUTPUT"
