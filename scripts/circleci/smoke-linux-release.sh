#!/usr/bin/env bash
set -euo pipefail

arch="${1:?Expected x64 or arm64}"
case "$arch" in x64|arm64) ;; *) echo "Unsupported Linux smoke architecture: $arch" >&2; exit 2 ;; esac
deb="release/NEURAFLOK-Linux-${arch}.deb"
appimage="release/NEURAFLOK-Linux-${arch}.AppImage"
expected_deb_arch=amd64
[ "$arch" = arm64 ] && expected_deb_arch=arm64

assert_equals() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "Linux $arch smoke failed: $label was '$actual', expected '$expected'." >&2
    exit 1
  fi
}

assert_file_contains() {
  local file="$1" marker="$2" label="$3"
  if ! grep -Fq "$marker" "$file"; then
    echo "Linux $arch smoke failed: $label did not report '$marker'. Captured output:" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_gui_stays_ready() {
  local label="$1" file="$2" status="$3"
  if [ "$status" -ne 124 ]; then
    echo "Linux $arch smoke failed: $label exited with status $status instead of staying open until timeout. Captured output:" >&2
    cat "$file" >&2
    exit 1
  fi
  assert_file_contains "$file" '[info] app started' "$label startup"
  assert_file_contains "$file" '[info] window loaded' "$label window load"
  assert_file_contains "$file" '[info] renderer state ready' "$label renderer readiness"
  if grep -Fq '[error] window failed to load' "$file" || grep -Fq '[error] renderer:' "$file"; then
    echo "Linux $arch smoke failed: $label reported an application error. Captured output:" >&2
    cat "$file" >&2
    exit 1
  fi
}

sudo apt-get update
sudo apt-get install -y --no-install-recommends xvfb xauth
assert_equals "$(dpkg-deb --field "$deb" Package)" neuraflok 'DEB package name'
assert_equals "$(dpkg-deb --field "$deb" Version)" "$(node -p "require('./package.json').version")" 'DEB version'
assert_equals "$(dpkg-deb --field "$deb" Architecture)" "$expected_deb_arch" 'DEB architecture'
sudo dpkg -i "$deb" || sudo apt-get install -f -y
desktop=/usr/share/applications/neuraflok.desktop
assert_file_contains "$desktop" 'Name=NEURAFLOK' 'desktop entry'
assert_file_contains "$desktop" 'Icon=neuraflok' 'desktop icon'
if [ ! -L /usr/bin/neuraflok ]; then
  echo "Linux $arch smoke failed: /usr/bin/neuraflok is not a symbolic link." >&2
  exit 1
fi
installed_executable="$(readlink -f /usr/bin/neuraflok)"
if [ ! -x "$installed_executable" ]; then
  echo "Linux $arch smoke failed: installed executable is missing or not executable: $installed_executable" >&2
  exit 1
fi
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
deb_status=$?
set -e
assert_gui_stays_ready 'DEB app launch' "$smoke_root/deb-gui.log" "$deb_status"

chmod +x "$appimage"
set +e
NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" > "$smoke_root/appimage-normal-gui.log" 2>&1
appimage_status=$?
set -e
assert_gui_stays_ready 'AppImage launch' "$smoke_root/appimage-normal-gui.log" "$appimage_status"

printf '#!/bin/sh\nexit 1\n' > "$fake_bin/unshare"
chmod +x "$fake_bin/unshare"
export PATH="$fake_bin:$PATH"
set +e
NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" > "$smoke_root/appimage-gui.log" 2>&1
fallback_status=$?
set -e
assert_gui_stays_ready 'AppImage no-sandbox fallback launch' "$smoke_root/appimage-gui.log" "$fallback_status"
echo "Linux $arch DEB installation and AppImage launch smoke passed."
