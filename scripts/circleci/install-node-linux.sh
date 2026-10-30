#!/usr/bin/env bash
set -euo pipefail

major="$(tr -d '[:space:]' < .nvmrc)"
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported CircleCI machine architecture: $(uname -m)" >&2; exit 1 ;;
esac
node_version="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; major=sys.argv[1]; rows=json.load(sys.stdin); print(next(row["version"] for row in rows if row["version"].startswith("v"+major+".")))' "$major")"
install_root="$HOME/.local/neuraflok-node"
archive="node-${node_version}-linux-${node_arch}.tar.xz"
mkdir -p "$install_root"
curl -fsSL "https://nodejs.org/dist/${node_version}/${archive}" | tar -xJ --strip-components=1 -C "$install_root"
echo "export PATH=\"$install_root/bin:\$PATH\"" >> "$BASH_ENV"
export PATH="$install_root/bin:$PATH"
node --version
npm --version
