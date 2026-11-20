import { isTauri } from "@tauri-apps/api/core";
import {
  loadConfiguration,
  updateConfiguration,
  type FineShellConfiguration,
} from "./config-database";
import { createDeletedHostRecord } from "./configuration-mutations";
import {
  connectionTargetKey,
  createCredentialReference,
  credentialReferenceId,
  type CredentialProbeResult,
} from "./credential-registry";
import type { HostRecord, ProxyRecord, SshKeyRecord } from "./models";
import {
  commandErrorMessage,
  emitProtocolEventTo,
  invokeProtocolCommand as invoke,
  listenProtocolEvent,
} from "./tauri-protocol";

export interface HostSyncAccount {
  accountId: string;
  email: string;
  server: string;
}

interface HostSyncConfiguration {
  hosts: HostRecord[];
  keys: SshKeyRecord[];
  proxies: ProxyRecord[];
}

interface AppliedConfiguration extends HostSyncConfiguration {
  credentials: CredentialProbeResult[];
}

export interface HostSyncConflict {
  id: string;
  local: Record<string, unknown> | null;
  cloud: Record<string, unknown> | null;
  credentialChanged: boolean;
}

export interface BlockedSyncRecord {
  kind: "hosts" | "keys";
  id: string;
  name: string;
  preserve: boolean;
  relink: boolean;
}

export interface HostSyncDevice {
  id: string;
  name: string;
  current: boolean;
  lastSyncAt: number | null;
}

export interface SyncOptions {
  resolution?: { snapshot: string; choices: Record<string, boolean> };
  recover?: boolean;
  manual?: boolean;
}

interface SyncInspection {
  revision: number;
  fingerprint: string;
  credentialGeneration: number;
}

interface SyncResult {
  base: object;
  inspection?: SyncInspection;
  expectedLocal?: object | null;
  conflicts?: HostSyncConflict[];
  conflictSnapshot?: string | null;
  blocked?: BlockedSyncRecord[];
}

export function hostSyncDevices(accountId: string, revoke?: string, rename?: string) {
  return invoke<HostSyncDevice[]>("host_sync_devices", { accountId, revoke, rename });
}

export async function rotateHostSyncKey(accountId: string, recoveryKey: string, accountPassword: string) {
  const { hostSyncBase } = await loadConfiguration();
  if (!hostSyncBase) throw new Error("请先完成一次同步，再更换主密码");
  const replacement = await invoke<object>("host_sync_rotate_key", {
    accountId, base: JSON.parse(hostSyncBase), recoveryKey, accountPassword,
  });
  await updateConfiguration((current) => current.hostSyncBase === hostSyncBase
    ? { ...current, hostSyncBase: JSON.stringify(replacement) }
    : current);
  void requestHostSync({ manual: true }).catch(() => undefined);
}

export function hostSyncRegistration(server: string) {
  return invoke<{ mode: "open" | "invite" | "closed"; masterPassword?: boolean }>("host_sync_registration", { server });
}

export function sendHostSyncVerification(server: string, email: string, inviteCode: string) {
  return invoke("host_sync_registration", { server, verification: { email, inviteCode } });
}

export async function relinkHostSyncKey(issue: BlockedSyncRecord, path: string) {
  await updateConfiguration((current) => issue.kind === "keys"
    ? { ...current, sshKeys: current.sshKeys.map((item) => item.id === issue.id
      ? { ...item, privateKeyPath: path, source: "file" } : item) }
    : { ...current, hosts: current.hosts.map((item) => item.id === issue.id
      ? { ...item, privateKeyPath: path } : item) });
  await Promise.allSettled([
    emitProtocolEventTo("main", "configuration:changed"),
    emitProtocolEventTo("settings", "configuration:changed"),
  ]);
  await requestHostSync({ manual: true });
}

export interface HostSyncStatus {
  state: "working" | "success" | "failed";
  time?: string;
  message?: string;
  conflicts?: HostSyncConflict[];
  snapshot?: string;
  blocked?: BlockedSyncRecord[];
  recoverable?: boolean;
  signInRequired?: boolean;
}

const bindingKey = "fineshell.hostSync.account";
const statusKey = "fineshell.hostSync.status";

export function hostSyncAccount() {
  return invoke<HostSyncAccount | null>("host_sync_account");
}

export function hostSyncRecoveryKey() {
  return invoke<string>("host_sync_recovery_key");
}

export async function signInToHostSync(values: {
  server: string;
  email: string;
  password: string;
  recoveryKey: string;
  useMasterPassword?: boolean;
  registrationId?: string;
  register: boolean;
  deviceName: string;
  proof?: { inviteCode: string; verificationCode: string };
}) {
  const boundAccount = localStorage.getItem(bindingKey);
  const account = await invoke<HostSyncAccount>("host_sync_login", {
    ...values,
    boundAccount,
  });
  localStorage.setItem(bindingKey, account.accountId);
  void requestHostSync({ manual: true }).catch(() => undefined);
  return account;
}

export async function signOutOfHostSync() {
  await invoke("host_sync_logout");
  localStorage.removeItem(statusKey);
}

export function readHostSyncStatus(): HostSyncStatus | null {
  const raw = localStorage.getItem(statusKey);
  return raw ? JSON.parse(raw) as HostSyncStatus : null;
}

export function isHostSyncStorageEvent(event: StorageEvent) {
  return event.key === statusKey;
}

export function hostSyncIsBound() {
  return localStorage.getItem(bindingKey) !== null;
}

export function requestHostSync(options: SyncOptions = {}) {
  return emitProtocolEventTo("main", "host-sync:request", options);
}

function project(config: FineShellConfiguration): HostSyncConfiguration {
  const keys = new Set(config.hosts.map((host) => host.sshKeyId));
  const proxies = new Set(config.hosts.map((host) => host.proxyId));
  return {
    hosts: config.hosts.map(({ lastConnectedAt, hostFingerprint, ...host }) => host),
    keys: config.sshKeys.filter((key) => keys.has(key.id)),
    proxies: config.proxies.filter((proxy) => proxies.has(proxy.id)),
  };
}

function restoreLocalFields(incoming: HostRecord, local?: HostRecord) {
  if (!local || connectionTargetKey(incoming) !== connectionTargetKey(local)) return incoming;
  return {
    ...incoming,
    lastConnectedAt: local.lastConnectedAt,
    hostFingerprint: local.hostFingerprint,
  };
}

function mergeOrder<T extends { id: string }>(existing: T[], incoming: T[], keepUnmatched: boolean) {
  const byId = new Map(incoming.map((record) => [record.id, record]));
  const merged: T[] = [];
  for (const record of existing) {
    const replacement = byId.get(record.id);
    if (replacement) {
      merged.push(replacement);
      byId.delete(record.id);
    } else if (keepUnmatched) {
      merged.push(record);
    }
  }
  return [...merged, ...byId.values()];
}

function writeStatus(status: HostSyncStatus) {
  localStorage.setItem(statusKey, JSON.stringify(status));
}

interface SyncCache {
  account: HostSyncAccount;
  configuration: string;
  base: string | undefined;
  inspection: SyncInspection;
  checkedAt: number;
  blocked?: BlockedSyncRecord[];
}

async function synchronize(
  account: HostSyncAccount, options: SyncOptions, cache?: SyncCache,
): Promise<{ status: HostSyncStatus; cache?: SyncCache }> {
  const current = await loadConfiguration();
  const configuration = project(current);
  const expected = JSON.stringify(configuration);
  if (!options.manual && cache && cache.account.accountId === account.accountId &&
      cache.account.server === account.server && cache.configuration === expected &&
      cache.base === current.hostSyncBase && Date.now() - cache.checkedAt < 120_000) {
    const unchanged = await invoke<boolean | null>("host_sync_probe", {
      accountId: account.accountId, known: cache.inspection,
    });
    if (unchanged) {
      return { status: { state: "success", time: new Date().toISOString(), blocked: cache.blocked }, cache };
    }
  }
  const { base, inspection, expectedLocal, conflicts, conflictSnapshot, blocked } = await invoke<SyncResult>("host_sync_exchange", {
    accountId: account.accountId,
    configuration,
    base: current.hostSyncBase ? JSON.parse(current.hostSyncBase) : null,
    resolution: options.resolution,
    recover: options.recover,
  });
  if (conflicts?.length && conflictSnapshot) {
    return { status: { state: "failed", conflicts, snapshot: conflictSnapshot, blocked } };
  }
  const status: HostSyncStatus = { state: "success", time: new Date().toISOString(), blocked };
  const encoded = JSON.stringify(base);
  const nextCache = inspection ? {
    account, configuration: expected, base: encoded, inspection, checkedAt: Date.now(), blocked,
  } satisfies SyncCache : undefined;
  if (encoded === current.hostSyncBase && !expectedLocal) return { status, cache: nextCache };

  let received: AppliedConfiguration | undefined;
  if (expectedLocal) {
    if (JSON.stringify(project(await loadConfiguration())) !== expected) {
      throw new Error("本机连接配置刚发生变化，将在下一次同步时重试");
    }
    received = await invoke<AppliedConfiguration>("host_sync_apply", {
      accountId: account.accountId,
      vault: base,
      expectedLocal,
      configuration,
      preserveHosts: blocked?.filter((issue) => issue.kind === "hosts" && issue.preserve).map((issue) => issue.id) ?? [],
      preserveKeys: blocked?.filter((issue) => issue.kind === "keys" && issue.preserve).map((issue) => issue.id) ?? [],
    });
  }
  let changed = false;
  let committed = false;
  await updateConfiguration((latest) => {
    if (JSON.stringify(project(latest)) !== expected) return latest;
    committed = true;
    if (!received) return { ...latest, hostSyncBase: encoded };
    const local = new Map(latest.hosts.map((host) => [host.id, host]));
    const retained = new Set(blocked?.filter((issue) => issue.kind === "hosts" && issue.preserve)
      .map((issue) => issue.id));
    const incomingHosts = [...received.hosts, ...latest.hosts.filter((host) => retained.has(host.id))];
    const receivedIds = new Set(incomingHosts.map((host) => host.id));
    const deleted = latest.hosts
      .filter((host) => !receivedIds.has(host.id))
      .map((host) => createDeletedHostRecord(host));
    const deletedIds = new Set(deleted.map(({ host }) => host.id));
    const labels = new Map(
      [...received.hosts, ...received.proxies, ...received.keys].map(({ id, name }) => [id, name]),
    );
    const references = new Map(latest.credentialReferences.map((entry) => [entry.id, entry]));
    for (const { kind, ownerId, exists } of received.credentials) {
      const id = credentialReferenceId(kind, ownerId);
      if (!exists) references.delete(id);
      else if (!references.has(id)) {
        references.set(id, createCredentialReference(kind, ownerId, labels.get(ownerId) ?? ownerId));
      }
    }
    changed = true;
    return {
      ...latest,
      hosts: mergeOrder(latest.hosts, incomingHosts, false)
        .map((host) => restoreLocalFields(host, local.get(host.id))),
      sshKeys: mergeOrder(latest.sshKeys, received.keys, true),
      proxies: mergeOrder(latest.proxies, received.proxies, true),
      credentialReferences: [...references.values()],
      trash: [
        ...deleted,
        ...latest.trash.filter(({ host }) => !receivedIds.has(host.id) && !deletedIds.has(host.id)),
      ],
      hostSyncBase: encoded,
    };
  });
  if (!committed) throw new Error("本机连接配置刚发生变化，将在下一次同步时重试");
  if (changed) {
    await Promise.allSettled([
      emitProtocolEventTo("main", "configuration:changed"),
      emitProtocolEventTo("settings", "configuration:changed"),
    ]);
  }
  return { status, cache: nextCache };
}

export function startHostSync() {
  if (!isTauri()) return;
  let running = false;
  let queued: SyncOptions | undefined;
  let lastDeviceUpdate = 0;
  let deviceAccount: string | undefined;
  let retries = 0;
  let retryAfter = 0;
  let cache: SyncCache | undefined;
  let changeTimer: number | undefined;

  async function run(options: SyncOptions = {}, fromChange = false) {
    if (!hostSyncIsBound() || (!options.manual && Date.now() < retryAfter)) return;
    if (running) {
      if (options.manual) queued = options;
      else if (fromChange) queued ??= options;
      return;
    }
    running = true;
    try {
      const account = await hostSyncAccount();
      if (!account) return;
      const status = readHostSyncStatus();
      if (!options.manual && status?.conflicts?.length) return;
      if (options.manual) writeStatus({ state: "working" });
      const { status: result, cache: nextCache } = await synchronize(account, options, cache);
      cache = nextCache;
      writeStatus(result);
      retries = 0;
      retryAfter = 0;
      if (result.state === "success" && (deviceAccount !== account.accountId || Date.now() - lastDeviceUpdate >= 60_000)) {
        deviceAccount = account.accountId;
        lastDeviceUpdate = Date.now();
        void invoke("host_sync_devices", { accountId: account.accountId, markSynced: true }).catch(() => undefined);
      }
      if (options.recover && result.state === "success") queued ??= { manual: true };
    } catch (error) {
      cache = undefined;
      const message = commandErrorMessage(error);
      retries = Math.min(retries + 1, 5);
      retryAfter = Date.now() + 15_000 * 2 ** retries;
      writeStatus({
        state: "failed",
        message,
        recoverable: message.startsWith("云端快照落后"),
        signInRequired: message.includes("重新登录"),
      });
    } finally {
      running = false;
      if (queued) {
        const next = queued;
        queued = undefined;
        void run(next);
      }
    }
  }

  void listenProtocolEvent("host-sync:request", ({ payload }) => {
    void run(payload);
  }).catch((error) => writeStatus({ state: "failed", message: commandErrorMessage(error) }));
  void listenProtocolEvent("configuration:changed", () => {
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => void run({}, true), 350);
  }).catch((error) => writeStatus({ state: "failed", message: commandErrorMessage(error) }));
  window.addEventListener("online", () => { retryAfter = 0; void run(); });
  window.setInterval(() => void run(), 15_000);
  void run();
}
