#!/usr/bin/env bash
# Build an ad-hoc-signed, unnotarized Universal 2 disk image.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/apps/DSHShare/App/Info.plist")"
NAME="DSHShare-$VERSION-universal2.dmg"
OUTPUT="${1:-$ROOT/dist/$NAME}"
if [[ -e "$OUTPUT" ]]; then echo "output already exists: $OUTPUT" >&2; exit 1; fi
WORK="$(mktemp -d "${DSH_DMG_WORK_ROOT:-${TMPDIR:-/tmp}}/dsh-share-dmg-build.XXXXXX")"
TEMP_IMAGE="$OUTPUT.building.dmg"
trap 'rm -rf "$WORK"; rm -f "$TEMP_IMAGE"' EXIT
mkdir -p "$(dirname "$OUTPUT")"
BUILD_ROOT="${DSH_DMG_BUILD_ROOT:-$WORK}"
ARM_APP="$BUILD_ROOT/arm64/DSHShare.app"
INTEL_APP="$BUILD_ROOT/x86_64/DSHShare.app"
DSH_BUILD_DIR="$BUILD_ROOT/arm64" TARGET_ARCH=arm64 SIGN_ID=- "$ROOT/scripts/build-app.sh"
# The publisher need not have Rosetta: packaging uses the host-native helper.
DSH_BUILD_DIR="$BUILD_ROOT/x86_64" TARGET_ARCH=x86_64 SIGN_ID=- \
  DSH_BUNDLE_HELPER="$ARM_APP/Contents/MacOS/dsh-share-helper" "$ROOT/scripts/build-app.sh"

PAYLOAD="$WORK/payload"
APP="$PAYLOAD/DSHShare.app"
mkdir -p "$PAYLOAD"
ditto "$ARM_APP" "$APP"
for binary in \
  Contents/MacOS/DSHShare \
  Contents/MacOS/dsh-share-helper \
  Contents/PlugIns/DSHShareExtension.appex/Contents/MacOS/DSHShareExtension; do
  lipo -create "$ARM_APP/$binary" "$INTEL_APP/$binary" -output "$APP/$binary.universal"
  mv "$APP/$binary.universal" "$APP/$binary"
  chmod 755 "$APP/$binary"
  lipo "$APP/$binary" -verify_arch arm64
  lipo "$APP/$binary" -verify_arch x86_64
done
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/dsh-share-helper"
codesign --force --sign - --timestamp=none --entitlements "$ROOT/apps/DSHShare/Extension/entitlements.plist" \
  "$APP/Contents/PlugIns/DSHShareExtension.appex"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --all-architectures "$APP"

ln -s /Applications "$PAYLOAD/Applications"
cp "$ROOT/docs/installation.zh-CN.txt" "$PAYLOAD/安装与使用说明.txt"
hdiutil create -quiet -format UDZO -fs HFS+ -volname "DSH Share $VERSION" -srcfolder "$PAYLOAD" "$TEMP_IMAGE"
hdiutil verify -quiet "$TEMP_IMAGE"
mv "$TEMP_IMAGE" "$OUTPUT"
(
  cd "$(dirname "$OUTPUT")"
  shasum -a 256 "$(basename "$OUTPUT")" > "$(basename "$OUTPUT").sha256"
)
echo "Disk image: $OUTPUT"
