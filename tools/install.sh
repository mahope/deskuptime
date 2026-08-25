#!/bin/sh
# deskuptime CLI installer — installs to ~/.local/bin
# Usage: curl -fsSL https://raw.githubusercontent.com/mahope/deskuptime/main/tools/install.sh | bash
set -e

VERSION="0.1.2"
PREFIX="${HOME}/.local"
BIN_DIR="$PREFIX/bin"

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js 16+ is required (https://nodejs.org)" >&2
  exit 1
}

mkdir -p "$BIN_DIR" "$PREFIX/lib/deskuptime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/mahope/deskuptime/releases/download/v${VERSION}-cli/deskuptime-${VERSION}.tar.gz"
echo "Downloading deskuptime ${VERSION}..."
curl -fsSL "$URL" | tar -xz -C "$TMP"

cp -R "$TMP/src" "$PREFIX/lib/deskuptime/"
cp "$TMP/package.json" "$TMP/README.md" "$TMP/LICENSE" "$PREFIX/lib/deskuptime/"
ln -sf "$PREFIX/lib/deskuptime/src/cli.js" "$BIN_DIR/deskuptime"
chmod 0755 "$PREFIX/lib/deskuptime/src/cli.js"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to your PATH (e.g. add 'export PATH=\"$HOME/.local/bin:\$PATH\"' to your shell profile)";;
esac

"$BIN_DIR/deskuptime" --version || true
echo "Installed. Try it:"
echo "  $BIN_DIR/deskuptime check https://yoursite.com"
