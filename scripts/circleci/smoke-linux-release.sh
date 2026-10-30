#!/usr/bin/env bash
set -euo pipefail

arch="${1:?Expected x64 or arm64}"
case "$arch" in x64|arm64) ;; *) echo "Unsupported Linux smoke architecture: $arch" >&2; exit 2 ;; esac
deb="release/NEURAFLOK-Linux-${arch}.deb"
appimage="release/NEURAFLOK-Linux-${arch}.AppImage"
expected_deb_arch=amd64
[ "$arch" = arm64 ] && expected_deb_arch=arm64

sudo apt-get update
sudo apt-get install -y --no-install-recommends xvfb xauth
test "$(dpkg-deb --field "$deb" Package)" = neuraflok
test "$(dpkg-deb --field "$deb" Version)" = "$(node -p "require('./package.json').version")"
test "$(dpkg-deb --field "$deb" Architecture)" = "$expected_deb_arch"
sudo dpkg -i "$deb" || sudo apt-get install -f -y
desktop=/usr/share/applications/neuraflok.desktop
grep -Fxq 'Name=NEURAFLOK' "$desktop"
grep -Fxq 'Icon=neuraflok' "$desktop"
test -L /usr/bin/neuraflok
installed_executable="$(readlink -f /usr/bin/neuraflok)"
test -x "$installed_executable"
dpkg-query -S "$installed_executable"
node scripts/smoke-packaged-runtime.mjs --platform linux --arch "$arch" --root "$(dirname "$installed_executable")"

smoke_root="$(mktemp -d)"
fake_bin="$(mktemp -d)"
trap 'rm -rf "$smoke_root" "$fake_bin"' EXIT
mkdir -p "$smoke_root/home" "$smoke_root/config" "$smoke_root/cache" "$smoke_root/data" "$smoke_root/state"
export HOME="$smoke_root/home"
export XDG_CONFIG_HOME="$smoke_root/config"
export XDG_CACHE_HOME="$smoke_root/cache"
export XDG_DATA_HOME="$smoke_root/data"
export XDG_STATE_HOME="$smoke_root/state"
set +e
NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/neuraflok > "$smoke_root/deb-gui.log" 2>&1
set -e
grep -Fq '[info] app started' "$smoke_root/deb-gui.log"
grep -Fq '[info] window loaded' "$smoke_root/deb-gui.log"
grep -Fq '[info] renderer state ready' "$smoke_root/deb-gui.log"
if grep -Fq '[error] window failed to load' "$smoke_root/deb-gui.log" || grep -Fq '[error] renderer:' "$smoke_root/deb-gui.log"; then
  cat "$smoke_root/deb-gui.log"
  exit 1
fi

chmod +x "$appimage"
set +e
NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" > "$smoke_root/appimage-normal-gui.log" 2>&1
set -e
grep -Fq '[info] app started' "$smoke_root/appimage-normal-gui.log"
grep -Fq '[info] window loaded' "$smoke_root/appimage-normal-gui.log"
grep -Fq '[info] renderer state ready' "$smoke_root/appimage-normal-gui.log"
if grep -Fq '[error] window failed to load' "$smoke_root/appimage-normal-gui.log" || grep -Fq '[error] renderer:' "$smoke_root/appimage-normal-gui.log"; then
  cat "$smoke_root/appimage-normal-gui.log"
  exit 1
fi

printf '#!/bin/sh\nexit 1\n' > "$fake_bin/unshare"
chmod +x "$fake_bin/unshare"
export PATH="$fake_bin:$PATH"
set +e
NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" > "$smoke_root/appimage-gui.log" 2>&1
set -e
grep -Fq '[info] app started' "$smoke_root/appimage-gui.log"
grep -Fq '[info] window loaded' "$smoke_root/appimage-gui.log"
grep -Fq '[info] renderer state ready' "$smoke_root/appimage-gui.log"
if grep -Fq '[error] window failed to load' "$smoke_root/appimage-gui.log" || grep -Fq '[error] renderer:' "$smoke_root/appimage-gui.log"; then
  cat "$smoke_root/appimage-gui.log"
  exit 1
fi
echo "Linux $arch DEB installation and AppImage launch smoke passed."
