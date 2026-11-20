import { expect, test } from "bun:test";
import { sshKeyInstallCommand } from "./ssh-key-install";

test("builds a local-account installer from an OpenSSH public key", () => {
  const command = sshKeyInstallCommand("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 zhandu");
  expect(command.startsWith("sh -c ")).toBe(true);
  expect(command).toContain('file="$dir/authorized_keys"');
  expect(command).toContain('chmod 600 "$file"');
  expect(command).toContain('>> "$file"');
});

test("rejects unexpected public-key text before constructing a shell command", () => {
  for (const text of [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "ssh-ed25519 AAAA zhandu; echo changed",
    "ssh-ed25519 AAAA zhandu\nssh-ed25519 BBBB zhandu",
    "ssh-ed25519 AA$(echo x) zhandu",
  ]) {
    expect(() => sshKeyInstallCommand(text)).toThrow("OpenSSH 公钥格式无效");
  }
});
