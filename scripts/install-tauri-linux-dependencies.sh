#!/usr/bin/env bash
set -Eeuo pipefail

. /etc/os-release
case "$ID:$VERSION_CODENAME" in
    ubuntu:jammy|ubuntu:noble) ;;
    *)
        printf 'Unsupported Linux build image: %s %s\n' "$ID" "$VERSION_CODENAME" >&2
        exit 1
        ;;
esac

architecture="$(dpkg --print-architecture)"
case "$architecture" in
    amd64)
        archive=https://archive.ubuntu.com/ubuntu/
        security=https://security.ubuntu.com/ubuntu/
        ;;
    arm64)
        archive=https://ports.ubuntu.com/ubuntu-ports/
        security=https://security.ports.ubuntu.com/ubuntu-ports/
        ;;
    *)
        printf 'Unsupported Linux build architecture: %s\n' "$architecture" >&2
        exit 1
        ;;
esac

sources="$(mktemp --suffix=.sources "$RUNNER_TEMP/tauri-ubuntu.XXXXXX")"
trap 'rm -f -- "$sources"' EXIT
cat > "$sources" <<EOF
Types: deb
URIs: $archive
Suites: $VERSION_CODENAME $VERSION_CODENAME-updates $VERSION_CODENAME-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: $security
Suites: $VERSION_CODENAME-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
chmod 0644 "$sources"

printf 'Installing Linux build packages for Ubuntu %s / %s from %s\n' "$VERSION_CODENAME" "$architecture" "$archive"
apt_options=(
    -o "Dir::Etc::sourcelist=$sources"
    -o Dir::Etc::sourceparts=-
    -o Acquire::Retries=2
    -o Acquire::https::Timeout=20
    -o APT::Update::Error-Mode=any
)
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install -y "$@"