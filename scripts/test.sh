#!/usr/bin/env bash
# Build one isolated native helper, then run every regression against that executable.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-share-native-tests.XXXXXX")"
trap 'rm -rf "$TEST_WORK"' EXIT
if [[ -z "${DSH_SHARE_HELPER:-}" ]]; then
  DSH_HELPER_BUILD_DIR="$TEST_WORK/build" "$ROOT/scripts/build-helper.sh" "$TEST_WORK/dsh-share-helper"
  export DSH_SHARE_HELPER="$TEST_WORK/dsh-share-helper"
fi
if [[ -z "${DSH_SETUP_PROBE:-}" ]]; then
  "$ROOT/scripts/build-setup-probe.sh" "$TEST_WORK/dsh-share-setup-probe"
  export DSH_SETUP_PROBE="$TEST_WORK/dsh-share-setup-probe"
fi
if [[ -z "${DSH_ENABLEMENT_PROBE:-}" ]]; then
  "$ROOT/scripts/build-setup-checks.sh" "$TEST_WORK/dsh-share-setup-checks"
  export DSH_ENABLEMENT_PROBE="$TEST_WORK/dsh-share-setup-checks"
fi
"${DSH_TEST_NODE:-node}" --test "$@" "$ROOT"/tests/*.test.mjs
