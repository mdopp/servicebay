#!/bin/sh
# install-sb-tui.sh — fetch the latest sb-tui binary for this OS/arch from the
# ServiceBay GitHub releases (#1279). For the operator who doesn't clone the
# repo:
#
#   curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install-sb-tui.sh | sh
#
# Overridable via environment:
#   SB_TUI_INSTALL_DIR  install location          (default: $HOME/.local/bin)
#   SB_TUI_VERSION      release tag to install     (default: latest)
#                       e.g. servicebay-v4.51.1
set -eu

REPO="mdopp/servicebay"
BIN="sb-tui"
INSTALL_DIR="${SB_TUI_INSTALL_DIR:-$HOME/.local/bin}"

die() {
  echo "install-sb-tui: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

need curl
need uname

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) os=windows ;;
  *) die "unsupported OS: $os" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

asset="${BIN}-${os}-${arch}"
if [ "$os" = windows ]; then
  asset="${asset}.exe"
fi

# Resolve the release tag. Default to the latest published release.
tag="${SB_TUI_VERSION:-}"
if [ -z "$tag" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
fi
[ -n "$tag" ] || die "could not determine the latest release tag"

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

dest="${INSTALL_DIR}/${BIN}"
if [ "$os" = windows ]; then
  dest="${dest}.exe"
fi

echo "Installing ${asset} (${tag}) → ${dest}"
mkdir -p "$INSTALL_DIR"

# Download to a temp file first so a failed fetch never leaves a half-written
# binary on PATH.
tmp=$(mktemp "${INSTALL_DIR}/.${BIN}.XXXXXX")
trap 'rm -f "$tmp"' EXIT INT TERM
curl -fSL --progress-bar "$url" -o "$tmp" \
  || die "download failed: $url (does release ${tag} have a ${asset} asset?)"
chmod +x "$tmp"
mv -f "$tmp" "$dest"
trap - EXIT INT TERM

echo "Installed ${BIN} to ${dest}"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Note: ${INSTALL_DIR} is not on your PATH — add it:" >&2
     echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" >&2 ;;
esac
echo "Run '${BIN}' to open the ServiceBay lifecycle launcher."
