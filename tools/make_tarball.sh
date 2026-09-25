#!/usr/bin/env bash
# Build the release tarball for deskuptime CLI.
# Output: deskuptime-<version>.tar.gz containing exactly what an end user needs:
#   the whole src/ tree, package.json, README.md, LICENSE
# Verifies the result runs standalone before declaring success, and writes a
# sha256 sidecar next to the tarball.
#
# The whole src/ tree is copied, never a hand-maintained file list: cli.js and
# watch.js import files dynamically, so a missing entry produces a tarball that
# dies with ERR_MODULE_NOT_FOUND on the user's machine instead of in CI.
# test/tarball.test.js locks this down.
#
# Env:
#   DESKUPTIME_TARBALL_DIR     output directory (default: repo root)
#   DESKUPTIME_SELFCHECK_URL   URL the self-check runs against (default: example.com)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
SELFCHECK_URL="${DESKUPTIME_SELFCHECK_URL:-https://example.com}"
OUT_DIR="${DESKUPTIME_TARBALL_DIR:-$PWD}"
OUT="$OUT_DIR/deskuptime-${VERSION}.tar.gz"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

[ -f src/cli.js ] || { echo "MISSING: src/cli.js" >&2; exit 1; }
mkdir -p "$OUT_DIR"
cp -R src "$STAGE/src"
cp package.json README.md LICENSE "$STAGE/"
# cli.js resolves package.json at ../package.json relative to its own location,
# so inside the tarball src/ stays next to package.json at the root.

# Deterministic build (fixed mtimes, sorted entries, gzip -n)
touch -t 197001010000 $(find "$STAGE" -type f)
(cd "$STAGE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tar -cf - --no-recursion -T -) | gzip -n -9 > "$OUT"

# Self-check: extract somewhere fresh and run it against a real URL
CHECK=$(mktemp -d)
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
tar -xzf "$OUT" -C "$CHECK"
GV=$(node -p "require('$CHECK/package.json').version")
[ "$GV" = "$VERSION" ] || { echo "SELF-CHECK FAILED: version mismatch $GV != $VERSION" >&2; exit 1; }
node "$CHECK/src/cli.js" --version | grep -q "$VERSION" || {
  echo "SELF-CHECK FAILED: --version output wrong" >&2; exit 1; }
# headers and watch import their checkers lazily, so a truncated tarball only
# shows up when those code paths actually run.
node "$CHECK/src/cli.js" headers "$SELFCHECK_URL" --json >/dev/null || {
  echo "SELF-CHECK FAILED: headers --json failed" >&2; exit 1; }
HOME="$CHECK/home" node "$CHECK/src/cli.js" watch "$SELFCHECK_URL" --once >/dev/null || {
  echo "SELF-CHECK FAILED: watch --once failed" >&2; exit 1; }
RESULT=$(node "$CHECK/src/cli.js" check "$SELFCHECK_URL")
echo "$RESULT" | grep -qi '200\|Status' || {
  echo "SELF-CHECK FAILED: real check output was:" >&2; echo "$RESULT" >&2; exit 1; }

SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
printf '%s  %s\n' "$SHA" "$(basename "$OUT")" > "$OUT.sha256"
echo "OK: $OUT ($SHA)"
echo "OK: $OUT.sha256"
