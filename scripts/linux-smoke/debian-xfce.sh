#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != '--session' ]]; then
    expected_version="$1"
    expected_arch="$2"
    baseline="$3"
    target="$4"
    . /etc/os-release
    test "$ID" = debian
    test "$VERSION_ID" = "$expected_version"
    test "$(dpkg --print-architecture)" = "$expected_arch"

    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=3 update -qq
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends /tmp/zhandu.deb
    package="$(dpkg-deb -f /tmp/zhandu.deb Package)"
    test "$(dpkg-query -W -f='${Version}' "$package")" = "$baseline"
    test "$(dpkg-query -W -f='${Architecture}' "$package")" = "$expected_arch"
    test "$(dpkg-query -W -f='${Status}' "$package")" = 'install ok installed'
    desktop_file="$(dpkg -L "$package" | grep -E '^/usr/share/applications/[^/]+\.desktop$')"
    test -f "$desktop_file"

    apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
        at-spi2-core ca-certificates curl dbus-x11 desktop-file-utils fonts-dejavu-core libgtk-3-bin python3-pyatspi sudo thunar \
        xfce4-panel xfce4-session xfce4-settings xfdesktop4 xfwm4 \
        x11-utils xauth xdotool xvfb
    desktop-file-validate "$desktop_file"
    if ldd /usr/bin/fineshell | grep -F 'not found'; then
        echo 'FineShell has an unresolved shared library.' >&2
        exit 1
    fi
    dpkg-query -W "$package" xfce4-session libwebkit2gtk-4.1-0
    useradd -m desktop
    install -m 0440 /dev/null /etc/sudoers.d/desktop-updater
    printf 'desktop ALL=(root) NOPASSWD: /usr/bin/dpkg -i *\n' > /etc/sudoers.d/desktop-updater
    visudo -cf /etc/sudoers.d/desktop-updater
    install -d -m 0700 -o desktop -g desktop /tmp/xfce-runtime
    desktop_id="${desktop_file##*/}"
    exec runuser -u desktop -- env XDG_RUNTIME_DIR=/tmp/xfce-runtime \
        LC_ALL=C.UTF-8 NO_AT_BRIDGE=0 XDG_CURRENT_DESKTOP=XFCE XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 \
        dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' \
        bash "$0" --session "${desktop_id%.desktop}" "$package" "$expected_arch" "$baseline" "$target"
fi

test "$(id -u)" -ne 0
desktop_id="$2"
package="$3"
expected_arch="$4"
baseline="$5"
target="$6"
profile="$HOME/.local/share/com.fineshell.app"
session_log="$HOME/xfce.log"
startxfce4 >"$session_log" 2>&1 &
session_pid=$!
cleanup() {
    local status=$?
    if ((status != 0)); then
        tail -n 70 "$session_log" >&2
        xwininfo -root -tree >&2 || true
    fi
    kill "$session_pid" 2>/dev/null || true
}
trap cleanup EXIT

for ((attempt=0; attempt<30; attempt++)); do
    if pgrep -u "$UID" -x xfce4-session >/dev/null &&
       pgrep -u "$UID" -x xfce4-panel >/dev/null &&
       pgrep -u "$UID" -x xfwm4 >/dev/null; then
        break
    fi
    sleep 1
done
pgrep -a -u "$UID" -x xfce4-session
pgrep -a -u "$UID" -x xfce4-panel
pgrep -a -u "$UID" -x xfwm4
test ! -d "$profile"

window_pid() {
    local previous="$1" pid windows window
    for ((attempt=0; attempt<120; attempt++)); do
        for pid in $(pgrep -u "$UID" -x fineshell || true); do
            if [[ "$pid" != "$previous" && "/proc/$pid/exe" -ef /usr/bin/fineshell ]] &&
               windows="$(xdotool search --onlyvisible --all --pid "$pid" --name '^(栈渡|FineShell)$')"; then
                window="${windows%%$'\n'*}"
                if xwininfo -id "$window" | grep -F 'Map State: IsViewable' >&2; then
                    printf '%s\n' "$pid"
                    return
                fi
            fi
        done
        sleep 1
    done
    return 1
}

curl -fsSL --retry 2 --max-time 20 \
    "https://github.com/makessr/ZhanDu/releases/latest/download/latest.json" >/dev/null
gtk-launch "$desktop_id"
app_pid="$(window_pid '')"
mkdir -p "$profile"
marker="$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$marker" > "$profile/ota-smoke-marker"
test "$(dpkg-query -W -f='${Version}' "$package")" = "$baseline"

printf 'Requesting application update to %s using XFCE, PID %s.\n' "$target" "$app_pid"
timeout 85s /usr/bin/python3 /tmp/press-update.py "$app_pid"
previous="$app_pid"
app_pid="$(window_pid "$previous")"
test "$(dpkg-query -W -f='${Version}' "$package")" = "$target"
test "$(dpkg-query -W -f='${Architecture}' "$package")" = "$expected_arch"
test "$(dpkg-query -W -f='${Status}' "$package")" = 'install ok installed'
dpkg-query -W -f='${Depends}' "$package" | tr ',' '\n' | grep -E '^ *ca-certificates$'
test "$(cat "$profile/ota-smoke-marker")" = "$marker"
printf 'Installed %s, restarted into a visible XFCE window and retained the profile marker.\n' "$target"
