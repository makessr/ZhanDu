import type { HostRecord, JumpHostConnection, ProxyRecord, SshKeyRecord } from "./models";
import { resolveManagedPrivateKey } from "./host-storage";

export type TerminalLayout = "single" | "columns" | "rows";
export interface TerminalWorkspace {
  id: string;
  name: string;
  hostIds: string[];
  active: number;
  layout: TerminalLayout;
  panes: number[];
}

const workspaceKey = "fineshell.terminal.workspaces";

export function readTerminalWorkspaces(): TerminalWorkspace[] {
  try {
    const saved = JSON.parse(localStorage.getItem(workspaceKey) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        Array.isArray(item.hostIds) &&
        item.hostIds.length > 0 &&
        item.hostIds.every((id: unknown) => typeof id === "string") &&
        Number.isInteger(item.active) &&
        item.active >= 0 &&
        item.active < item.hostIds.length &&
        ["single", "columns", "rows"].includes(item.layout) &&
        Array.isArray(item.panes) &&
        item.panes.every(
          (index: number) => Number.isInteger(index) && index >= 0 && index < item.hostIds.length,
        ),
    );
  } catch {
    return [];
  }
}

export function writeTerminalWorkspaces(items: TerminalWorkspace[]) {
  localStorage.setItem(workspaceKey, JSON.stringify(items));
}

export function resolveWorkspaceConnection(
  host: HostRecord,
  configuration: { hosts: HostRecord[]; proxies: ProxyRecord[]; sshKeys: SshKeyRecord[] },
): [HostRecord, ProxyRecord?, JumpHostConnection?] {
  function withKey(record: HostRecord) {
    const resolved = resolveManagedPrivateKey(record, configuration.sshKeys);
    if (!resolved) throw new Error(record.name + " 引用的私钥不存在");
    return resolved;
  }
  function proxyFor(record: HostRecord) {
    if (!record.proxyId) return undefined;
    const proxy = configuration.proxies.find(({ id }) => id === record.proxyId);
    if (!proxy) throw new Error(record.name + " 引用的代理不存在");
    return proxy;
  }
  const proxy = proxyFor(host);
  if (!host.jumpHostId) return [withKey(host), proxy];
  const jump = configuration.hosts.find(({ id }) => id === host.jumpHostId);
  if (!jump || jump.id === host.id || jump.jumpHostId)
    throw new Error(host.name + " 的跳板机配置无效");
  if (!jump.hostFingerprint) throw new Error("请先连接并信任跳板机 " + jump.name);
  return [withKey(host), proxy, { host: withKey(jump), proxy: proxyFor(jump) }];
}
