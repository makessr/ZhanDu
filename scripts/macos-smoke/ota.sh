#!/usr/bin/env bash
set -Eeuo pipefail

image="$1"
arch="$2"
test "$(uname -m)" = "$arch"

work="$(mktemp -d "$RUNNER_TEMP/fineshell-ota.XXXXXX")"
mount="$work/mount"
app="$work/FineShell.app"
mkdir "$mount"
hdiutil attach "$image" -mountpoint "$mount" -nobrowse -readonly
app_pid=''
cleanup() {
    if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; fi
    hdiutil detach "$mount" || printf '%s\n' 'Could not detach the test disk image.' >&2
}
trap cleanup EXIT
ditto "$mount/FineShell.app" "$app"

bundle_meta() {
    /usr/libexec/PlistBuddy -c "Print :$1" "$app/Contents/Info.plist"
}

verify_bundle() {
    test "$(bundle_meta CFBundleShortVersionString)" = "$1"
    test "$(bundle_meta CFBundleIdentifier)" = com.fineshell.app
    test "$(lipo -archs "$app/Contents/MacOS/$(bundle_meta CFBundleExecutable)")" = "$arch"
    codesign --verify --deep --strict "$app"
}

verify_bundle 0.6.2
swiftc scripts/macos-smoke/verify-window.swift -o "$work/verify-window"
open -n "$app"
app_pid="$("$work/verify-window" "$app" 0)"

profile="$HOME/Library/WebKit/$(bundle_meta CFBundleIdentifier)"
for ((attempt=0; attempt<20; attempt++)); do
    if [[ -d "$profile" ]]; then break; fi
    sleep 1
done
test -d "$profile"
marker="$(uuidgen)"
printf '%s\n' "$marker" > "$profile/fineshell-ota-test-marker"

for target in 0.6.3; do
    echo "Requesting update to $target from PID $app_pid."
    osascript scripts/macos-smoke/press-update.applescript "$app_pid"
    for ((attempt=0; attempt<120; attempt++)); do
        if [[ "$(bundle_meta CFBundleShortVersionString 2>/dev/null || true)" == "$target" ]] &&
           ! kill -0 "$app_pid" 2>/dev/null; then
            break
        fi
        sleep 1
    done
    verify_bundle "$target"
    if kill -0 "$app_pid" 2>/dev/null; then
        printf 'Previous process %s did not exit.\n' "$app_pid" >&2
        exit 1
    fi
    app_pid="$("$work/verify-window" "$app" "$app_pid")"
    test "$(cat "$profile/fineshell-ota-test-marker")" = "$marker"
    printf 'Installed %s, opened a visible window, and preserved the WebKit profile marker.\n' "$target"
done