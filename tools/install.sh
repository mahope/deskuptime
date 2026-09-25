#!/bin/sh
# deskuptime CLI installer — installs to ~/.local/bin
# Usage: curl -fsSL https://raw.githubusercontent.com/mahope/deskuptime/main/tools/install.sh | bash
#
# Installs the newest published v<ver>-cli tarball and verifies its published
# sha256 BEFORE unpacking. Endpoints and version are overridable so
# test/install.test.js exercises this exact script against a local server
# without touching the network.
set -e

# Used only when the release feed cannot be read. Keep in sync with
# package.json — test/install.test.js fails if the two drift.
FALLBACK_VERSION="0.2.8"

# Single source for the Node major this CLI runs on. Must match "engines.node"
# in package.json; test/install.test.js asserts the two agree. Every Node
# version error below is printed through require_node(), so there is exactly
# one message.
REQUIRED_NODE_MAJOR=24

API_URL="${DESKUPTIME_API_URL:-https://api.github.com/repos/mahope/deskuptime/releases?per_page=100}"
RELEASE_BASE="${DESKUPTIME_RELEASE_BASE:-https://github.com/mahope/deskuptime/releases/download}"
REQUIRE_CHECKSUM="${DESKUPTIME_REQUIRE_CHECKSUM:-0}"

PREFIX="${HOME}/.local"
BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/lib/deskuptime"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

node_too_old() {
  die "Node.js ${REQUIRED_NODE_MAJOR}+ is required (https://nodejs.org)"
}

require_node() {
  command -v node >/dev/null 2>&1 || node_too_old
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) < Number(process.argv[1]) ? 1 : 0)' \
    "$REQUIRED_NODE_MAJOR" || node_too_old
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    node -e 'const c=require("crypto"),fs=require("fs");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
  fi
}

# Prints the highest published version that has a CLI tarball asset, ignoring
# drafts, prereleases, desktop and alpha tags. Fails when the feed is
# unreadable, so the caller can fall back.
resolve_version() {
  curl -fsSL --max-time 20 "$API_URL" 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", c => (raw += c));
    process.stdin.on("end", () => {
      let releases = [];
      try {
        releases = JSON.parse(raw);
      } catch {
        process.exit(1);
      }
      if (!Array.isArray(releases)) process.exit(1);
      let best = null;
      for (const release of releases) {
        if (!release || release.draft || release.prerelease) continue;
        if (typeof release.tag_name !== "string") continue;
        const tag = /^v(\d+)\.(\d+)\.(\d+)-cli$/.exec(release.tag_name);
        if (!tag) continue;
        const version = tag[1] + "." + tag[2] + "." + tag[3];
        const tarball = "deskuptime-" + version + ".tar.gz";
        const assets = Array.isArray(release.assets) ? release.assets : [];
        if (!assets.some(asset => asset && asset.name === tarball)) continue;
        const parts = [tag[1], tag[2], tag[3]].map(Number);
        if (!best || parts.some((n, i) => n !== best.parts[i] ? n > best.parts[i] : false)) {
          best = { version, parts };
        }
      }
      if (!best) process.exit(1);
      process.stdout.write(best.version);
    });
  '
}

require_node

VERSION=""
if [ -n "${DESKUPTIME_VERSION:-}" ]; then
  VERSION="$DESKUPTIME_VERSION"
  note "Installing pinned deskuptime ${VERSION} (DESKUPTIME_VERSION)."
elif [ "${DESKUPTIME_NO_RESOLVE:-0}" = "1" ]; then
  VERSION="$FALLBACK_VERSION"
  note "Resolving disabled — using built-in version ${VERSION}."
else
  if VERSION="$(resolve_version)"; then
    note "Resolved newest published CLI release: v${VERSION}-cli."
  else
    VERSION="$FALLBACK_VERSION"
    note "warning: could not read the release feed — falling back to ${VERSION}."
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BASE_URL="$RELEASE_BASE/v${VERSION}-cli"
TARBALL="deskuptime-${VERSION}.tar.gz"
URL="$BASE_URL/$TARBALL"

note "Downloading deskuptime ${VERSION}..."
curl -fsSL --max-time 120 -o "$TMP/$TARBALL" "$URL" ||
  die "download failed: $URL (is the v${VERSION}-cli release published?)"

# Verify before unpacking: a truncated or swapped download must never reach
# the user's PATH.
if curl -fsSL --max-time 30 -o "$TMP/$TARBALL.sha256" "$BASE_URL/$TARBALL.sha256" 2>/dev/null; then
  EXPECTED=$(awk 'NR==1{print $1}' "$TMP/$TARBALL.sha256")
  ACTUAL=$(sha256_of "$TMP/$TARBALL")
  [ -n "$EXPECTED" ] || die "published checksum for $TARBALL is empty or malformed"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    printf 'error: checksum mismatch for %s\n  expected %s\n  actual   %s\n' \
      "$TARBALL" "$EXPECTED" "$ACTUAL" >&2
    printf 'Nothing was installed. Refusing to unpack an unverified download.\n' >&2
    exit 1
  fi
  note "Checksum verified (sha256 ${ACTUAL})."
else
  if [ "$REQUIRE_CHECKSUM" = "1" ]; then
    die "no published .sha256 for $TARBALL, and DESKUPTIME_REQUIRE_CHECKSUM=1"
  fi
  note "warning: $TARBALL has no published .sha256 — this download is unverified."
fi

tar -xzf "$TMP/$TARBALL" -C "$TMP" || die "could not unpack $TARBALL"
[ -f "$TMP/src/cli.js" ] || die "$TARBALL contains no src/cli.js — refusing to install"

# Replace instead of merge: a stale file from a previous version would keep
# shadowing the new install.
rm -rf "$LIB_DIR"
mkdir -p "$BIN_DIR" "$LIB_DIR"
cp -R "$TMP/src" "$LIB_DIR/src"
cp "$TMP/package.json" "$TMP/README.md" "$TMP/LICENSE" "$LIB_DIR/"
ln -sf "$LIB_DIR/src/cli.js" "$BIN_DIR/deskuptime"
chmod 0755 "$LIB_DIR/src/cli.js"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) note "note: add $BIN_DIR to your PATH (e.g. add 'export PATH=\"$HOME/.local/bin:\$PATH\"' to your shell profile)";;
esac

note "Installed deskuptime ${VERSION}:"
"$BIN_DIR/deskuptime" --version 2>/dev/null || note "(version check skipped)"
note "Try it:"
note "  $BIN_DIR/deskuptime check https://yoursite.com"
