#!/usr/bin/env bash
# Shared discovery for installation and maintenance commands.
dsh_native_helper() {
  local candidate
  if [[ -n "${DSH_SHARE_HELPER:-}" ]]; then
    if [[ ! -x "$DSH_SHARE_HELPER" ]]; then
      echo "native helper is not executable: $DSH_SHARE_HELPER" >&2
      return 1
    fi
    printf '%s\n' "$DSH_SHARE_HELPER"
    return
  fi
  for candidate in \
    "$HOME/Applications/DSHShare.app/Contents/MacOS/dsh-share-helper" \
    "/Applications/DSHShare.app/Contents/MacOS/dsh-share-helper" \
    "$ROOT/build/DSHShare.app/Contents/MacOS/dsh-share-helper" \
    "$ROOT/build/dsh-share-helper"; do
    if [[ -x "$candidate" ]]; then printf '%s\n' "$candidate"; return; fi
  done
  echo "native helper not found; run ./scripts/build-app.sh --install first" >&2
  return 1
}
