#!/usr/bin/env bash
set -Eeuo pipefail

package_name="$1"
arch="$2"
binary=/usr/bin/fineshell
export XDG_DATA_HOME="$RUNNER_TEMP/fineshell-ota-data"
export XDG_CONFIG_HOME="$RUNNER_TEMP/fineshell-ota-config"
export GDK_BACKEND=x11
export NO_AT_BRIDGE=0

profile="$XDG_DATA_HOME/com.fineshell.app"
mkdir -p "$profile"
marker="$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$marker" > "$profile/ota-smoke-marker"

package_field() {
    dpkg-query -W -f="$1" "$package_name"
}

window_for() {
    local windows
    windows="$(xdotool search --onlyvisible --all --pid "$1" --name '^(FineShell|栈渡)$')" || return
    printf '%s\n' "${windows%%$'\n'*}"
}

test "$(package_field '${Version}')" = 0.5.1
test -x "$binary"
log="$RUNNER_TEMP/fineshell-ota.log"
"$binary" > "$log" 2>&1 &
app_pid=$!
cleanup() {
    local result=$?
    if ((result != 0)); then tail -n 80 "$log" >&2; fi
    kill "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT

for target in 0.6.1 0.6.2; do
    echo "Requesting update to $target from PID $app_pid."
    timeout 85s /usr/bin/python3 scripts/linux-smoke/press-update.py "$app_pid"
    restarted_pid=''
    for ((attempt=0; attempt<120; attempt++)); do
        if [[ "$(package_field '${Version}')" == "$target" ]]; then
            for candidate in $(pgrep -u "$UID" -x fineshell || true); do
                if [[ "$candidate" != "$app_pid" && "/proc/$candidate/exe" -ef "$binary" ]] &&
                    window="$(window_for "$candidate")"; then
                    restarted_pid="$candidate"
                    break 2
                fi
            done
        fi
        sleep 1
    done

    test "$(package_field '${Version}')" = "$target"
    test "$(package_field '${Architecture}')" = "$arch"
    test "$(package_field '${Status}')" = 'install ok installed'
    test -n "$restarted_pid"
    app_pid="$restarted_pid"
    xwininfo -id "$window" | grep -F 'Map State: IsViewable'
    test "$(cat "$profile/ota-smoke-marker")" = "$marker"
    printf 'Installed %s, opened a visible window, and preserved the profile marker.\n' "$target"
done