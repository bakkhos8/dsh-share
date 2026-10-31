#!/usr/bin/env bash
# 把 dsh-share 插件装进指定的 dsh profile（默认 desktop），支持热挂载。
#
# 用法：
#   ./scripts/install-plugin.sh              # 复制插件到 ~/Library/Application Support/DSHShare/plugin
#   ./scripts/install-plugin.sh --dev        # 不复制，profile 直接软链到仓库里的 plugin/dsh-share
#   DSH_PROFILE_DIR=/path/to/profile ./scripts/install-plugin.sh
#
# 做三件事：
#   1. 把插件放到稳定位置（默认复制，--dev 则软链到仓库）；
#   2. 在 $HOME/.dsh/profiles/<profile>/node_modules 下建 dsh-share 软链；
#   3. 在 profile 的 package.json 里声明依赖并追加到 dsh.profile.bundles。
#      dsh-hmr 监听 bundles 列表变化 → 运行中的 dsh 会热重组，通常不用重启。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/plugin/dsh-share"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
DEST="${DSH_PLUGIN_DIR:-$HOME/Library/Application Support/DSHShare/plugin/dsh-share}"
MODE="copy"

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="link" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  echo "profile 不存在：$PROFILE_DIR" >&2
  exit 1
fi

source "$ROOT/scripts/native-helper-path.sh"
HELPER="$(dsh_native_helper)"

if [[ "$MODE" == "copy" ]]; then
  "$HELPER" install-plugin --profile-dir "$PROFILE_DIR" --source "$SRC" --destination "$DEST"
else
  TARGET="$SRC"
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$TARGET" "$PROFILE_DIR/node_modules/dsh-share"
  "$HELPER" configure-profile --profile "$PROFILE_DIR/package.json" --plugin "$TARGET"
fi

echo "plugin -> $PROFILE_DIR/node_modules/dsh-share"
echo "done. dsh 应热挂载 dsh-share；若插件列表里没出现，重启 dsh。"
