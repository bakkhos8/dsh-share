#!/usr/bin/env bash
# Build DSHShare.app (the host app) + DSHShareExtension.appex (the macOS Share Extension).
#
# Usage:
#   ./scripts/build-app.sh                                  # build into ./build with ad-hoc signing
#   SIGN_ID="Apple Development: Your Name (TEAMID)" \
#     ./scripts/build-app.sh --install                      # build, sign, install, register, enable
#   ./scripts/build-app.sh --uninstall                      # open the app's uninstall assistant
#   ./scripts/build-app.sh --install-only                  # install the exact existing build
#
# The script packages the native bundles using swiftc and system tools.
# Two bundle details matter:
#   * the extension binary must be MH_EXECUTE whose entry point is Foundation's _NSExtensionMain
#     (not MH_BUNDLE, no main.swift);
#   * do NOT ship Contents/PkgInfo — APPL???? would override the extension's XPC! package type.
#
# Local builds use one explicit signing mode for the app and extension. Registration and
# codesign verification alone do not prove a successful share. See docs/signing.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${DSH_BUILD_DIR:-$ROOT/build}"
APP="$BUILD/DSHShare.app"
APPEX="$APP/Contents/PlugIns/DSHShareExtension.appex"
ENTITLEMENTS="$ROOT/apps/DSHShare/Extension/entitlements.plist"

SIGN_ID="${SIGN_ID:--}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"
DEPLOY="${DEPLOY:-13.0}"

INSTALL=0
UNINSTALL=0
INSTALL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --install-only) INSTALL=1; INSTALL_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
INSTALLED_APP="$HOME/Applications/DSHShare.app"
EXTENSION_ID=com.movy.dshshare.host.share

if [[ "$UNINSTALL" == "1" ]]; then
  for installed_candidate in "$HOME/Applications/DSHShare.app" "/Applications/DSHShare.app"; do
    [[ -d "$installed_candidate" ]] || continue
    installed_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$installed_candidate/Contents/Info.plist" 2>/dev/null || true)"
    [[ "$installed_identifier" == "com.movy.dshshare.host" ]] || continue
    installed_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$installed_candidate/Contents/Info.plist" 2>/dev/null || true)"
    if [[ "$installed_build" =~ ^[0-9]+$ ]] && (( installed_build >= 11 )); then
      /usr/bin/open "$installed_candidate" --args --uninstall
      echo "请在 DSH Share 中确认卸载；若窗口已打开，点击“开始安装”旁的“卸载”，或从顶部 DSH Share 菜单进入卸载。会话和分享数据会保留。"
      exit 0
    fi
  done
  echo "请打开新版 DSHShare.app 并选择“卸载”；需要 0.1.5 或更新版本。" >&2
  exit 1
fi

if [[ "$INSTALL_ONLY" == "0" ]]; then
# ---- toolchain ---------------------------------------------------------------
# Prefer Xcode's toolchain (its SDK matches its compiler). Fall back to xcrun, then to CLT.
XCODE_SWIFTC=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc
XCODE_SDK=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk

if [[ -n "${SWIFTC:-}" ]]; then
  SWIFT="$SWIFTC"
elif [[ -x "$XCODE_SWIFTC" ]]; then
  SWIFT="$XCODE_SWIFTC"
else
  SWIFT="$(xcrun -f swiftc)"
fi

if [[ -n "${SDK:-}" ]]; then
  MACOS_SDK="$SDK"
elif [[ -d "$XCODE_SDK" ]]; then
  MACOS_SDK="$XCODE_SDK"
else
  MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path)"
fi

MODCACHE="$BUILD/.module-cache"
mkdir -p "$MODCACHE"

echo "==> swiftc: $SWIFT"
echo "==> sdk:    $MACOS_SDK"

COMMON=(
  -sdk "$MACOS_SDK"
  -target "${TARGET_ARCH}-apple-macosx${DEPLOY}"
  -module-cache-path "$MODCACHE"
  -Xcc "-fmodules-cache-path=$MODCACHE"
  -O
  -file-prefix-map "$ROOT=."
  -debug-prefix-map "$ROOT=."
)

# ---- assemble bundles --------------------------------------------------------
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mkdir -p "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources"

cp "$ROOT/apps/DSHShare/App/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/apps/DSHShare/Extension/Info.plist" "$APPEX/Contents/Info.plist"

# The containing app and share target use the same approved avatar.
DSH_BUILD_DIR="$BUILD" "$ROOT/scripts/build-icons.sh"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/icon.icns"
cp "$BUILD/AppIcon.icns" "$APPEX/Contents/Resources/icon.icns"
cp "$ROOT/LICENSE" "$APP/Contents/Resources/LICENSE.txt"
cp "$ROOT/apps/DSHShare/Resources/README.md" "$APP/Contents/Resources/AvatarNotice.txt"
cp "$ROOT/apps/DSHShare/Resources/分享测试.txt" "$APP/Contents/Resources/分享测试.txt"

# ---- compile the extension ---------------------------------------------------
echo "==> compiling extension"
"$SWIFT" "${COMMON[@]}" \
  -module-name DSHShareExtension \
  -parse-as-library \
  -emit-executable \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -framework AppKit -framework Foundation -framework UniformTypeIdentifiers \
  -o "$APPEX/Contents/MacOS/DSHShareExtension" \
  "$ROOT/apps/DSHShare/Extension/ShareViewController.swift" \
  "$ROOT/apps/DSHShare/Extension/InboxWriter.swift" \
  "$ROOT/apps/DSHShare/Extension/HarnessActivation.swift"

# ---- compile the host app ----------------------------------------------------
echo "==> compiling host app"
"$SWIFT" "${COMMON[@]}" \
  -module-name DSHShare \
  -parse-as-library \
  -framework AppKit -framework Foundation \
  -o "$APP/Contents/MacOS/DSHShare" \
  "$ROOT"/apps/DSHShare/App/*.swift

# Compile the inbox lock, cleanup and profile installer as a bundled executable.
SWIFTC="$SWIFT" SDK="$MACOS_SDK" TARGET_ARCH="$TARGET_ARCH" DEPLOY="$DEPLOY" \
  SIGN_ID="$SIGN_ID" DSH_HELPER_BUILD_DIR="$BUILD" \
  "$ROOT/scripts/build-helper.sh" "$APP/Contents/MacOS/dsh-share-helper"

# Only declared package files enter the distributable app, never local configuration.
"${DSH_BUNDLE_HELPER:-$APP/Contents/MacOS/dsh-share-helper}" bundle-plugin --source "$ROOT/plugin/dsh-share" \
  --destination "$APP/Contents/Resources/plugin/dsh-share"
chmod -R a+rX "$APP"

# ---- sign (extension first, then host) ---------------------------------------
echo "==> signing (identity: $SIGN_ID)"
codesign --force --sign "$SIGN_ID" --timestamp=none \
  --entitlements "$ENTITLEMENTS" \
  "$APPEX"
codesign --force --sign "$SIGN_ID" --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ "$SIGN_ID" == "-" ]]; then
  cat <<'NOTE'

  Local ad-hoc build: verify an actual share on this Mac after installation.
  Source distribution: each user builds and signs the app locally on their own Mac.

NOTE
fi
fi # build/sign; --install-only installs this exact existing artifact

# ---- install (optional) ------------------------------------------------------
if [[ "$INSTALL" == "1" ]]; then
  if [[ ! -x "$APP/Contents/MacOS/dsh-share-helper" ]]; then
    echo "native helper missing; rebuild with ./scripts/build-app.sh --install" >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "==> installing to $INSTALLED_APP"
  if [[ -d "$INSTALLED_APP" ]]; then
    # An unpacked .app backup can be discovered as another installed host with
    # the same bundle identifier. Keep a restorable archive instead.
    BACKUP="$ROOT/backups/$(date +%Y%m%d-%H%M%S)/DSHShare.app.zip"
    mkdir -p "$(dirname "$BACKUP")"
    ditto -c -k --sequesterRsrc --keepParent "$INSTALLED_APP" "$BACKUP"
    echo "previous installation saved: $BACKUP"
    pluginkit -r "$INSTALLED_APP/Contents/PlugIns/DSHShareExtension.appex" 2>/dev/null || true
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALLED_APP"
  ditto "$APP" "$INSTALLED_APP"

  pluginkit -r "$INSTALLED_APP/Contents/PlugIns/DSHShareExtension.appex" >/dev/null 2>&1 || true
  "$LSREG" -u "$APP" >/dev/null 2>&1 || true
  "$LSREG" -f "$INSTALLED_APP"
  pluginkit -a "$INSTALLED_APP/Contents/PlugIns/DSHShareExtension.appex"
  pluginkit -e use -i "$EXTENSION_ID"
  codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP"

  echo
  echo "installed:  $INSTALLED_APP"
  echo "extension:  $EXTENSION_ID"
  pluginkit -m -p com.apple.share-services -v 2>/dev/null | grep -i "$EXTENSION_ID" || true
  cat <<'NOTE'

  Next steps:
    1. Enable the extension if needed:
         System Settings → General → Login Items & Extensions → Sharing → "DeepSeek Harness"
       (or: pluginkit -e use -i com.movy.dshshare.host.share)
    2. Install the DSH plugin:  ./scripts/install-plugin.sh
    3. Right-click any file → Share → DeepSeek Harness.
NOTE
fi
