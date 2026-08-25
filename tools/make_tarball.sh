#!/usr/bin/env bash
# Build the release tarball for deskuptime CLI.
# Output: deskuptime-<version>.tar.gz containing exactly what an end user needs:
#   cli.js, engine.js, watch.js, license.js, checkers/, package.json, README.md, LICENSE
# Verifies the result runs standalone before declaring success.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="deskuptime-${VERSION}.tar.gz"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

for f in src/cli.js src/engine.js src/watch.js src/license.js src/checkers/ping.js src/checkers/ssl.js src/checkers/content.js package.json README.md LICENSE; do
  [ -f "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done
# cli.js resolves package.json at ../package.json relative to its own location,
# so inside the tarball it must sit in src/ with package.json at the root.
mv "$STAGE/src/package.json" "$STAGE/package.json" 2>/dev/null || true
mv "$STAGE/src/README.md" "$STAGE/README.md" 2>/dev/null || true
mv "$STAGE/src/LICENSE" "$STAGE/LICENSE" 2>/dev/null || true

# Deterministic build (fixed mtimes, sorted entries, gzip -n)
touch -t 197001010000 $(find "$STAGE" -type f)
(cd "$STAGE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tar -cf - --no-recursion -T -) | gzip -n -9 > "$OUT"

# Self-check: extract somewhere fresh and run it against a data URL-ish local file
CHECK=$(mktemp -d)
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
tar -xzf "$OUT" -C "$CHECK"
GV=$(node -p "require('$CHECK/package.json').version")
[ "$GV" = "$VERSION" ] || { echo "SELF-CHECK FAILED: version mismatch $GV != $VERSION" >&2; exit 1; }
node "$CHECK/src/cli.js" --version | grep -q "$VERSION" || {
  echo "SELF-CHECK FAILED: --version output wrong" >&2; exit 1; }
RESULT=$(node "$CHECK/src/cli.js" check https://example.com)
echo "$RESULT" | grep -qi '200\|Status' || {
  echo "SELF-CHECK FAILED: real check output was:" >&2; echo "$RESULT" >&2; exit 1; }

SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
echo "OK: $OUT ($SHA)"
