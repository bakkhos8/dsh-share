#!/usr/bin/env bash
# Package the approved PNG avatar as a multi-resolution macOS icon.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/apps/DSHShare/Resources/AppIcon.png"
BUILD="${DSH_BUILD_DIR:-$ROOT/build}"
OUTPUT="$BUILD/AppIcon.icns"
if [[ ! -f "$SOURCE" ]]; then
  echo "missing icon source: $SOURCE" >&2
  exit 1
fi
mkdir -p "$BUILD"
ICON_WORK="$(mktemp -d "$BUILD/.icons.XXXXXX")"
trap 'rm -rf "$ICON_WORK"' EXIT
ICONSET="$ICON_WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "$retina" "$retina" "$SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns "$ICONSET" --output "$ICON_WORK/AppIcon.icns"
mv "$ICON_WORK/AppIcon.icns" "$OUTPUT"
echo "icon: $OUTPUT"
