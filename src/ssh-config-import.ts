import type { HostRecord } from "./models";
import { withHostDefaults } from "./host-storage";

interface Section {
  patterns: string[];
  options: Map<string, string>;
}

type ImportedHost = Omit<HostRecord, "id" | "jumpHostId"> & { jumpAlias?: string };

function words(line: string) {
  const parts: string[] = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (!quote && char === "#") break;
    if (
      char === "\\" &&
      (next === quote || next === "\\" || (!quote && /[\s"#']/.test(next ?? "")))
    ) {
      token += next;
      index++;
    } else if (quote ? char === quote : char === '"' || char === "'") {
      quote = quote ? "" : char;
    } else if (!quote && /\s/.test(char)) {
      if (token) parts.push(token);
      token = "";
    } else {
      token += char;
    }
  }
  if (quote) throw new Error("SSH 配置包含未闭合的引号");
  if (token) parts.push(token);
  return parts;
}

const directiveLine = /^(\s*[a-z][\w-]*)\s*=\s*/i;

export async function expandSshConfig(
  root: string,
  read: (path: string) => Promise<string>,
  resolve: (pattern: string) => Promise<string[]>,
) {
  const active = new Set<string>();
  const maxBytes = 5 * 1024 * 1024;
  let bytes = 0;
  let files = 0;
  async function expand(path: string): Promise<string> {
    if (active.has(path)) throw new Error("OpenSSH Include 存在循环引用");
    if (active.size >= 16 || ++files > 128) throw new Error("OpenSSH Include 文件过多或嵌套过深");
    const contents = (await read(path)).replace(/^\uFEFF/, "");
    bytes += new TextEncoder().encode(contents).byteLength;
    if (bytes > maxBytes) throw new Error("OpenSSH 配置总大小超过 5 MB");
    active.add(path);
    try {
      const result: string[] = [];
      let inHost = false;
      for (const line of contents.split(/\r?\n/)) {
        const [keyword, ...values] = words(line.replace(directiveLine, "$1 "));
        const directive = keyword?.toLowerCase();
        if (directive === "match") throw new Error("当前只支持导入 Host 配置，不能导入 Match 条件");
        if (directive === "host") inHost = true;
        if (directive !== "include") {
          result.push(line);
          continue;
        }
        if (inHost) throw new Error("请将 Include 移到 Host 段落之前再导入");
        if (!values.length) throw new Error("Include 缺少文件路径");
        for (const pattern of values) {
          for (const child of await resolve(pattern)) {
            result.push(await expand(child), "Host *");
          }
        }
      }
      return result.join("\n");
    } finally {
      active.delete(path);
    }
  }
  return expand(root);
}

function matches(pattern: string, alias: string) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + regex + "$", "i").test(alias);
}

function applies({ patterns }: Section, alias: string) {
  return (
    patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern, alias)) &&
    !patterns.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1), alias))
  );
}

function sshPort(value: string | undefined) {
  const port = value === undefined ? 22 : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口无效");
  return port;
}

export function parseSshConfig(contents: string, defaultUser: string) {
  const sections: Section[] = [{ patterns: ["*"], options: new Map() }];
  const aliases = new Map<string, string>();
  for (const line of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const [keyword, ...values] = words(line.replace(/^(\s*[a-z][\w-]*)\s*=\s*/i, "$1 "));
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (key === "include" || key === "match") {
      throw new Error("此配置包含 Include 或 Match。请先展开为只包含 Host 的配置文件");
    }
    if (key === "host") {
      if (!values.length) throw new Error("Host 缺少主机别名");
      sections.push({ patterns: values, options: new Map() });
      for (const alias of values) {
        if (!/[!*?%\s]/.test(alias) && !aliases.has(alias.toLowerCase())) {
          aliases.set(alias.toLowerCase(), alias);
        }
      }
    } else if (values.length) {
      const options = sections[sections.length - 1].options;
      if (!options.has(key)) options.set(key, values.join(" "));
    }
  }

  const hosts: ImportedHost[] = [];
  const skipped: string[] = [];
  for (const alias of aliases.values()) {
    try {
      const options = new Map<string, string>();
      for (const section of sections.filter((section) => applies(section, alias))) {
        for (const [key, value] of section.options) {
          if (!options.has(key)) options.set(key, value);
        }
      }
      const username = options.get("user") ?? defaultUser.trim();
      const address = (options.get("hostname") ?? alias).replace(/%h/g, alias);
      const identity = options.get("identityfile");
      const proxyCommand = options.get("proxycommand");
      if (proxyCommand && proxyCommand.toLowerCase() !== "none")
        throw new Error("使用 ProxyCommand");
      const jump = options.get("proxyjump");
      const jumpAlias = jump?.toLowerCase() === "none" ? undefined : jump?.toLowerCase();
      if (jumpAlias && !aliases.has(jumpAlias))
        throw new Error("跳板机需为文件中定义的单一 Host 别名");
      if (!username || /[%\s]/.test(username)) throw new Error("缺少可用的 SSH 用户名");
      if (!address || /[%\s]/.test(address)) throw new Error("主机地址包含未支持的占位符");
      const privateKeyPath = identity?.toLowerCase() === "none" ? undefined : identity;
      if (
        privateKeyPath &&
        (privateKeyPath.includes("%") || !/^(?:~[\\/]|[\\/]|[a-z]:[\\/])/i.test(privateKeyPath))
      ) {
        throw new Error("私钥路径必须为绝对路径或以 ~/ 开头");
      }
      const { id: _id, ...host } = withHostDefaults({
        id: "",
        name: alias,
        address,
        username,
        port: sshPort(options.get("port")),
        authMethod: privateKeyPath ? "privateKey" : "agent",
        privateKeyPath,
        group: "OpenSSH",
      });
      hosts.push({ ...host, jumpAlias });
    } catch (error) {
      skipped.push(alias + " · " + (error as Error).message);
    }
  }
  const eligible = new Map(hosts.map((host) => [host.name.toLowerCase(), host]));
  return {
    hosts: hosts.filter((host) => {
      if (!host.jumpAlias) return true;
      const jump = eligible.get(host.jumpAlias);
      if (!jump || jump.jumpAlias) {
        skipped.push(host.name + " · 无法导入多级或缺失的跳板机");
        return false;
      }
      return true;
    }),
    skipped,
  };
}

function sameTarget(
  a: Pick<HostRecord, "address" | "port" | "username">,
  b: Pick<HostRecord, "address" | "port" | "username">,
) {
  return (
    a.address.toLowerCase() === b.address.toLowerCase() &&
    a.port === b.port &&
    a.username === b.username
  );
}

export function mergeSshConfig(
  existing: HostRecord[],
  incoming: ImportedHost[],
  createId: () => string,
) {
  const result = [...existing];
  const byAlias = new Map<string, HostRecord>();
  let skipped = 0;
  for (const host of [
    ...incoming.filter((item) => !item.jumpAlias),
    ...incoming.filter((item) => item.jumpAlias),
  ]) {
    const { jumpAlias, ...fields } = host;
    const jumpHostId = jumpAlias ? byAlias.get(jumpAlias)?.id : undefined;
    const duplicate = result.find((item) => item.name.toLowerCase() === host.name.toLowerCase());
    if (duplicate || (jumpAlias && !jumpHostId)) {
      if (
        duplicate &&
        sameTarget(duplicate, host) &&
        duplicate.jumpHostId === jumpHostId &&
        !duplicate.proxyId
      ) {
        byAlias.set(host.name.toLowerCase(), duplicate);
      }
      skipped++;
    } else {
      const entry = { ...fields, id: createId(), jumpHostId };
      byAlias.set(entry.name.toLowerCase(), entry);
      result.push(entry);
    }
  }
  return { hosts: result, skipped, added: result.length - existing.length };
}
