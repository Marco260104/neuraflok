#!/usr/bin/env bash
set -euo pipefail

arch="${1:?Expected x64 or arm64}"
case "$arch" in x64|arm64) ;; *) echo "Unsupported macOS smoke architecture: $arch" >&2; exit 2 ;; esac
dmg="release/NEURAFLOK-macOS-${arch}.dmg"
zip="release/NEURAFLOK-macOS-${arch}.zip"
mount_dir="$(mktemp -d)"
zip_dir="$(mktemp -d)"
codesign_log="$(mktemp)"
cleanup() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rm -rf "$mount_dir" "$zip_dir" "$codesign_log"
}
trap cleanup EXIT

hdiutil verify "$dmg"
set +e
codesign --display --verbose=4 "$dmg" > "$codesign_log" 2>&1
codesign_status=$?
set -e
if [ "$codesign_status" -eq 0 ]; then
  cat "$codesign_log"
  echo "Expected the DMG to be unsigned." >&2
  exit 1
fi
grep -Eqi 'code object is not signed( at all)?' "$codesign_log"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir"
test -L "$mount_dir/Applications"
test "$(readlink "$mount_dir/Applications")" = /Applications
ditto -x -k "$zip" "$zip_dir"
node scripts/smoke-macos-bundle.mjs "$arch" "$mount_dir/NEURAFLOK.app"
node scripts/smoke-macos-bundle.mjs "$arch" "$zip_dir/NEURAFLOK.app"
node scripts/smoke-macos-bundle.mjs "$arch"
host_arch="$(uname -m)"
if [[ "$arch" == "x64" && "$host_arch" == "arm64" ]]; then
  echo "macOS x64 GUI launch smoke skipped on Apple Silicon CI; DMG, ZIP, bundle metadata, executable modes, and Intel Mach-O payloads were verified."
else
  node scripts/smoke-macos-gui.mjs "$arch"
  echo "macOS $arch app launch smoke passed."
fi
echo "macOS $arch DMG, ZIP, bundle metadata, executable modes, and architecture checks passed."
