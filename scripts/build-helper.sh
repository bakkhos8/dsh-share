#!/usr/bin/env bash
# Compile and sign the standalone native helper; no interpreter is required at runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_BUILD="${DSH_HELPER_BUILD_DIR:-$ROOT/build}"
OUTPUT="${1:-$HELPER_BUILD/dsh-share-helper}"
XCODE_SWIFTC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc
XCODE_SDK=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
if [[ -n "${SWIFTC:-}" ]]; then SWIFT="$SWIFTC"
elif [[ -x "$XCODE_SWIFTC" ]]; then SWIFT="$XCODE_SWIFTC"
else SWIFT="$(xcrun -f swiftc)"; fi
if [[ -n "${SDK:-}" ]]; then MACOS_SDK="$SDK"
elif [[ -d "$XCODE_SDK" ]]; then MACOS_SDK="$XCODE_SDK"
else MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path)"; fi
mkdir -p "$HELPER_BUILD/.module-cache" "$(dirname "$OUTPUT")"
"$SWIFT" -sdk "$MACOS_SDK" -target "${TARGET_ARCH:-$(uname -m)}-apple-macosx${DEPLOY:-13.0}" \
  -module-cache-path "$HELPER_BUILD/.module-cache" -O -framework Foundation \
  -file-prefix-map "$ROOT=." -debug-prefix-map "$ROOT=." \
  "$ROOT"/apps/DSHShare/Helper/*.swift -o "$OUTPUT"
codesign --force --sign "${SIGN_ID:--}" --timestamp=none "$OUTPUT"
codesign --verify --strict "$OUTPUT"
echo "helper: $OUTPUT"
