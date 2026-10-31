#!/usr/bin/env bash
# Preview acknowledged completion leftovers; --apply removes only proven completions.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/native-helper-path.sh"
HELPER="$(dsh_native_helper)"
exec "$HELPER" cleanup "$@"
