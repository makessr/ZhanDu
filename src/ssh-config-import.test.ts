import { describe, expect, test } from "bun:test";
import { expandSshConfig, mergeSshConfig, parseSshConfig } from "./ssh-config-import";

describe("OpenSSH configuration import", () => {
  test("applies first matching values and preserves quoted Windows identity paths", () => {
    const { hosts, skipped } = parseSshConfig(
      `
Host bastion
  HostName jump.example
  User deploy
Host prod
  HostName prod.example
  Port=2222
  ProxyJump bastion
  IdentityFile "C:\\Users\\Admin\\.ssh\\production key"
Host * !bastion
  User ops
  Port 2200
`,
      "fallback",
    );
    expect(skipped).toEqual([]);
    expect(hosts.map(({ name, username, port }) => [name, username, port])).toEqual([
      ["bastion", "deploy", 22],
      ["prod", "ops", 2222],
    ]);
    expect(hosts[1].privateKeyPath).toBe("C:\\Users\\Admin\\.ssh\\production key");
    const ids = ["jump-id", "prod-id"];
    expect(mergeSshConfig([], hosts, () => ids.shift()!).hosts[1].jumpHostId).toBe("jump-id");
  });

  test("does not silently bypass an unsupported proxy or overwrite a same-name host", () => {
    const { hosts, skipped } = parseSshConfig(
      `
Host direct
  HostName direct.example
Host unsafe
  ProxyCommand ssh gateway -W %h:%p
Host chain
  ProxyJump unsafe
`,
      "test-user",
    );
    expect(hosts.map(({ name }) => name)).toEqual(["direct"]);
    expect(skipped).toHaveLength(2);
    const existing = [{ ...hosts[0], id: "old", address: "keep.example" }];
    const result = mergeSshConfig(existing, hosts, () => "new");
    expect(result.hosts).toEqual(existing);
    expect(result.added).toBe(0);
  });

  test("expands nested includes in order without leaking the last Host block", async () => {
    const files: Record<string, string> = {
      config: "Include conf/*.ssh\nUser common\nHost root\n  HostName root.example",
      first: "Include layers/*\nHost test\n  Port 2200",
      layer: "Host jump\n  User gateway",
      second: "Host test\n  Port 2222",
    };
    const resolve = async (pattern: string) =>
      pattern === "conf/*.ssh" ? ["first", "second"] : ["layer"];
    const expanded = await expandSshConfig("config", async (path) => files[path], resolve);
    const { hosts } = parseSshConfig(expanded, "fallback");
    expect(hosts.map(({ name, username, port }) => [name, username, port])).toEqual([
      ["jump", "gateway", 22],
      ["test", "common", 2200],
      ["root", "common", 22],
    ]);
  });

  test("rejects include cycles and conditional imports", async () => {
    const resolve = async () => ["config"];
    await expect(expandSshConfig("config", async () => "Include loop", resolve)).rejects.toThrow(
      "循环",
    );
    await expect(
      expandSshConfig("config", async () => "Host scoped\n Include config.d/*", resolve),
    ).rejects.toThrow("Host");
  });

  test("the text parser rejects unresolved Include and Match directives", () => {
    expect(() => parseSshConfig("Include ~/.ssh/config.d/*", "test")).toThrow("Include");
    expect(() => parseSshConfig('Match exec "true"', "test")).toThrow("Match");
  });
});
