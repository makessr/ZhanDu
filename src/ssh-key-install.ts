function quoteShell(value: string) {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function sshKeyInstallCommand(publicKey: string) {
  const parts = publicKey.trim().match(/^([A-Za-z0-9@._+-]+) ([A-Za-z0-9+/]+={0,2})(?: zhandu)?$/);
  if (!parts) throw new Error("OpenSSH 公钥格式无效");
  const [, algorithm, keyBlob] = parts;
  const keyLine = `${algorithm} ${keyBlob} zhandu`;
  const script = [
    "set -eu",
    "umask 077",
    'test -n "${HOME:-}" && test -d "$HOME" || exit 1',
    'dir="$HOME/.ssh"',
    'file="$dir/authorized_keys"',
    'if [ -L "$dir" ] || [ -L "$file" ]; then printf "%s\\n" "Refusing a symbolic link" >&2; exit 1; fi',
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    'if [ ! -e "$file" ]; then : >> "$file"; fi',
    'test -f "$file"',
    'chmod 600 "$file"',
    `if awk -v blob=${quoteShell(keyBlob)} '$1 !~ /^#/ { for (i=1; i<=NF; i++) if ($i==blob) found=1 } END { exit !found }' "$file"; then`,
    "  printf '%s\\n' 'Public key already installed'",
    "else",
    '  result=$?; [ "$result" -eq 1 ] || exit "$result"',
    `  printf '\\n%s\\n' ${quoteShell(keyLine)} >> "$file"`,
    "  printf '%s\\n' 'Public key installed'",
    "fi",
  ].join("\n");
  return `sh -c ${quoteShell(script)}`;
}
