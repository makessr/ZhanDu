import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as opaque from "@serenity-kit/opaque";
import { createSyncServer } from "../../sync-server/server.mjs";
import { devTools, evaluate, findWindow, invoke, until } from "./webview.mjs";
import { startSshFixture } from "./ssh-fixture.mjs";

const [portA, portB, ssh2Path] = process.argv.slice(2);
if (!portA || !portB || !ssh2Path || portA === portB) {
  throw new Error("Usage: node sync.mjs <device-a-port> <device-b-port> <ssh2-module-entry>");
}
const { default: ssh2 } = await import(pathToFileURL(resolve(ssh2Path)).href);
const directory = await mkdtemp(join(tmpdir(), "fineshell-desktop-smoke-"));
let fixture;
let server;

async function screenshot(view, filename) {
  const destination = process.env.ZHANDU_SCREENSHOTS_DIRECTORY;
  if (!destination) return;
  await until("Dismiss transient notifications before capture", () => evaluate(view, () =>
    !document.querySelector(".arco-message")));
  const zoom = filename === "zhandu-sync-registration.png" ? "0.82" : "";
  await evaluate(view, (value) => { document.documentElement.style.zoom = value; }, zoom);
  try {
    await evaluate(view, () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const { data } = await devTools(view, "Page.captureScreenshot", { format: "png" });
    await writeFile(join(destination, filename), Buffer.from(data, "base64"));
  } finally {
    await evaluate(view, () => { document.documentElement.style.zoom = ""; });
  }
}

async function sampleDesktop(label) {
  if (!process.env.ZHANDU_PERFORMANCE_SMOKE) return;
  const pid = Number(process.env.ZHANDU_SMOKE_DEVICE_B_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const sample = () => {
    const result = execFileSync("pwsh.exe", ["-NoProfile", "-Command", `
      $processes = Get-CimInstance Win32_Process
      $processIds = [Collections.Generic.HashSet[int]]::new()
      [void]$processIds.Add(${pid})
      do {
        $previous = $processIds.Count
        foreach ($process in $processes) {
          if ($processIds.Contains([int]$process.ParentProcessId)) {
            [void]$processIds.Add([int]$process.ProcessId)
          }
        }
      } until ($processIds.Count -eq $previous)
      $active = Get-Process -Id @($processIds) -ErrorAction SilentlyContinue
      @{cpu = ($active | Measure-Object CPU -Sum).Sum
        privateBytes = ($active | Measure-Object PrivateMemorySize64 -Sum).Sum} | ConvertTo-Json -Compress
    `], { encoding: "utf8", windowsHide: true });
    return JSON.parse(result);
  };
  const started = performance.now();
  const before = sample();
  await delay(5000);
  const after = sample();
  console.log(label, { cpuPercentOfOneCore: Math.max(0, 100000 * (after.cpu - before.cpu) / (performance.now() - started)),
    privateMiB: Math.round(after.privateBytes / 1024 ** 2) });
}

function configuration(seed, includeBase = false) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fineshell.config");
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("configuration")) {
        db.close();
        reject(new Error("Waiting for FineShell to initialize its test configuration"));
        return;
      }
      const tx = db.transaction("configuration", seed ? "readwrite" : "readonly");
      const store = tx.objectStore("configuration");
      const item = store.get("primary");
      let result;
      item.onsuccess = () => {
        const current = item.result ?? { id: "primary" };
        if (seed) {
          store.put({ ...current, ...seed });
        } else {
          result = { hosts: current.hosts ?? [], keys: current.sshKeys ?? [], synced: !!current.hostSyncBase,
            ...(includeBase && { base: JSON.parse(current.hostSyncBase) }) };
        }
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function click(view, text, selector = "button, [role=menuitem], .arco-menu-item") {
  return until(text, () => evaluate(view, (text, selector) => {
    const button = [...document.querySelectorAll(selector)]
      .find((item) => item.textContent.trim() === text && item.getClientRects().length);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, text, selector));
}

async function settings(view, port) {
  await invoke(view, "open_settings_window");
  const panel = await findWindow(port, "settings");
  await click(panel, "主机同步");
  return panel;
}

function fill(view, values) {
  return until("Sync settings input", () => evaluate(view, (values) => {
    const fields = Object.entries(values).map(([name, value]) => {
      const label = [...document.querySelectorAll("label")].find((element) => element.textContent.trim() === name);
      return [label?.querySelector("input"), value];
    });
    if (fields.some(([input]) => !input)) return false;
    for (const [input, value] of fields) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }, values));
}

try {
  const a = await findWindow(portA, "main");
  const b = await findWindow(portB, "main");
  await until("ZhanDu desktop branding", () => evaluate(a, () =>
    document.title === "栈渡" &&
    document.querySelector(".application-titlebar-brand")?.innerText.trim() === "栈渡"));
  console.log("桌面标题栏已显示栈渡。");
  for (const view of [a, b]) {
    assert.equal(await invoke(view, "host_sync_account"), null, "Use two fresh isolated test profiles");
    const initial = await until("Initialized desktop configuration", () => evaluate(view, configuration));
    assert.deepEqual(initial, { hosts: [], keys: [], synced: false });
  }
  await sampleDesktop("空闲窗口");
  fixture = await startSshFixture(ssh2, directory);
  await opaque.ready;
  let recoveryCode;
  server = createSyncServer(join(directory, "sync.sqlite"), {
    opaqueSetup: opaque.server.createSetup(),
    sendRecovery: (_email, code) => { recoveryCode = code; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = "http://127.0.0.1:" + server.address().port;
  const email = "windows-fixture@example.test";
  const password = randomBytes(24).toString("base64url");
  const common = { address: "127.0.0.1", port: fixture.port, group: "Smoke group",
    connectTimeoutSeconds: 8, keepAliveIntervalSeconds: 15, autoReconnect: false, maxReconnectAttempts: 0 };
  const generatedKeyId = "smoke-generated-key";
  const generated = await invoke(a, "managed_ssh_key_generate", { keyId: generatedKeyId });
  const standaloneKeyId = "smoke-standalone-key";
  const standalone = await invoke(a, "managed_ssh_key_generate", { keyId: standaloneKeyId });
  assert.match(generated.publicKey, /^ssh-ed25519 /);
  fixture.allowPublicKey("fineshell-generated", generated.publicKey);
  const hosts = [
    { ...common, id: "smoke-password", name: "Smoke password host", username: "fineshell-password", authMethod: "password" },
    { ...common, id: "smoke-key", name: "Smoke key host", username: "fineshell-key", authMethod: "privateKey", sshKeyId: "smoke-key-file" },
    { ...common, id: "smoke-generated", name: "Smoke generated key host", username: "fineshell-generated",
      authMethod: "privateKey", sshKeyId: generatedKeyId },
  ];
  await invoke(a, "store_host_password", { hostId: "smoke-password", password: fixture.password });
  await invoke(a, "store_private_key_passphrase", { hostId: "smoke-key-file", passphrase: fixture.keyPassphrase });
  await evaluate(a, configuration, { hosts, sshKeys: [
    { id: "smoke-key-file", name: "Smoke identity", privateKeyPath: fixture.deviceKeyFile, source: "file" },
    { id: generatedKeyId, name: "Generated identity", privateKeyPath: generated.reference, source: "managed" },
    { id: standaloneKeyId, name: "Standalone identity", privateKeyPath: standalone.reference, source: "managed" },
  ] });

  const setupA = await settings(a, portA);
  const setupB = await settings(b, portB);
  const form = { "同步服务地址": address, "邮箱": email, "账号密码": password };
  await fill(setupA, form);
  await click(setupA, "创建账号");
  const original = randomBytes(24).toString("base64url");
  await until("Show master password registration", () => evaluate(setupA, () => document.body.innerText.includes("再次输入主密码")));
  await screenshot(setupA, "zhandu-sync-registration.png");
  await fill(setupA, { "主密码": original, "再次输入主密码": original });
  await click(setupA, "创建账号并同步");
  await until("Device A uploads host credentials", async () => (await evaluate(a, configuration)).synced);
  await screenshot(setupB, "zhandu-host-sync.png");
  await fill(setupB, { ...form, "主密码或旧恢复密钥": original });
  await click(setupB, "登录并同步");
  const received = await until("Device B automatically receives all three hosts and their keys", async () => {
    const state = await evaluate(b, configuration);
    return state.synced && state.hosts.length === hosts.length &&
      state.keys.some((key) => key.privateKeyPath === "managed://smoke-key-file") &&
      state.keys.some((key) => key.id === generatedKeyId) && state;
  });
  assert.ok(!received.keys.some((key) => key.id === standaloneKeyId), "Unlinked keys stay on device A");
  const receivedKey = received.keys.find((key) => key.id === generatedKeyId);
  assert.equal(await invoke(b, "managed_ssh_key_public", { reference: receivedKey.privateKeyPath }), generated.publicKey);
  const check = { ...common, hostId: generatedKeyId, username: "fineshell-generated", authMethod: "privateKey",
    privateKeyPath: receivedKey.privateKeyPath };
  const initialPublicKeyCount = fixture.counts.publickey;
  const untrusted = await invoke(b, "ssh_verify_private_key", { request: check });
  assert.equal(untrusted.status, "hostKeyVerificationRequired");
  assert.equal(untrusted.fingerprint, fixture.fingerprint);
  assert.equal(fixture.counts.publickey, initialPublicKeyCount);
  const trusted = { ...check, expectedFingerprint: fixture.fingerprint };
  const rejected = { ...trusted, hostId: "smoke-key-file", privateKeyPath: "managed://smoke-key-file" };
  await assert.rejects(invoke(b, "ssh_verify_private_key", { request: rejected }), /私钥认证失败/);
  assert.equal((await invoke(b, "ssh_verify_private_key", { request: trusted })).status, "connected");
  assert.equal(fixture.counts.publickey, initialPublicKeyCount + 1);

  for (const host of hosts) {
    const method = host.authMethod === "password" ? "password" : "publickey";
    const initialAuthCount = fixture.counts[method];
    await evaluate(b, () => document.querySelector(".terminal-home-tab")?.click());
    await until("Connect to " + host.name, () => evaluate(b, (name) => {
      const row = [...document.querySelectorAll("tr")].find((item) => item.textContent.includes(name));
      const button = [...(row?.querySelectorAll("button") ?? [])].find((item) => item.textContent.trim() === "连接");
      if (!button) return false;
      button.click();
      return true;
    }, host.name));
    await until("Authenticate and show a read-only directory preview", async () => {
      const state = await evaluate(b, (fingerprint) => {
        const modal = document.querySelector(".fingerprint-confirm-modal");
        if (modal) {
          if (!modal.textContent.includes(fingerprint)) throw new Error("Test SSH host key mismatch");
          [...modal.querySelectorAll("button")].find((button) => button.textContent.trim() === "信任并连接")?.click();
        }
        return !!document.querySelector(".terminal-status-connected") && !!document.querySelector(".xterm") &&
          !!document.querySelector(".sftp-directory-preview-status") &&
          !document.querySelector(".sftp-table input[type=checkbox]") &&
          document.body.innerText.includes("fineshell-smoke.txt");
      }, fixture.fingerprint);
      return fixture.counts[method] > initialAuthCount && state;
    });
    await until("Show the completed SFTP directory", () => evaluate(b, () =>
      !document.querySelector(".sftp-directory-preview-status") &&
      !!document.querySelector(".sftp-table input[type=checkbox]") &&
      document.body.innerText.includes("after-preview.txt")));
    console.log("设备 B 使用同步凭据登录 " + host.name + "，并读取了 SFTP 测试目录。");
  }
  if (process.env.ZHANDU_PERFORMANCE_SMOKE) {
    await sampleDesktop("三条 SSH 会话");
    const chartsMs = await evaluate(b, async () => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "显示图表");
      if (!button || !document.body.innerText.includes("smoke-fixture")) throw new Error("Monitoring data unavailable");
      const start = performance.now();
      button.click();
      while (!document.querySelector(".monitor-chart canvas")) {
        if (performance.now() - start > 5000) throw new Error("Chart canvas did not render");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return Math.round(performance.now() - start);
    });
    console.log("监控首次绘制毫秒", chartsMs);
    await sampleDesktop("图表展开");
  }

  const peer = await invoke(b, "host_sync_account");
  assert.equal(peer.opaque, true);
  await click(setupA, "设置或更换主密码");
  const replacement = randomBytes(24).toString("base64url");
  await fill(setupA, { "账号密码": password, "新主密码": replacement, "再次输入新主密码": replacement });
  await click(setupA, "更换并撤销其他设备");
  await until("Device A completed key rotation", () => evaluate(setupA, () =>
    ![...document.querySelectorAll("label")].some((label) => label.textContent.trim() === "新主密码")));
  await assert.rejects(invoke(b, "host_sync_devices", { accountId: peer.accountId }), /请重新登录/);
  await evaluate(setupB, () => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "立即同步")?.click());
  const storedKeyLabel = "主密码或旧恢复密钥（留空使用本机保存的密钥）";
  await fill(setupB, { "账号密码": password, [storedKeyLabel]: replacement });
  await click(setupB, "登录并同步");
  await until("Device B logs in with the rotated master password", async () =>
    (await invoke(b, "host_sync_devices", { accountId: peer.accountId })).length === 2);
  console.log("两台设备通过 OPAQUE 登录，主密码更换后旧会话已撤销。");

  await click(setupB, "忘记账号密码");
  await until("Show account password recovery form", () => evaluate(setupB, () => document.body.innerText.includes("邮箱验证码")));
  await screenshot(setupB, "zhandu-sync-recovery.png");
  await click(setupB, "发送验证码");
  const code = await until("Wait for password recovery email fixture", () => recoveryCode);
  const newPassword = randomBytes(24).toString("base64url");
  await fill(setupB, { "邮箱验证码": code, "新账号密码": newPassword, "再次输入账号密码": newPassword });
  await click(setupB, "重设账号密码");
  await fill(setupB, { "账号密码": newPassword, [storedKeyLabel]: "" });
  await click(setupB, "登录并同步");
  await until("Device B unlocks with its saved key after email recovery", async () =>
    (await invoke(b, "host_sync_devices", { accountId: peer.accountId })).length === 1);
  await assert.rejects(invoke(a, "host_sync_devices", { accountId: peer.accountId }), /请重新登录/);
  const { hosts: syncedHosts, keys, base } = await evaluate(b, configuration, null, true);
  const resumed = await invoke(b, "host_sync_exchange", {
    accountId: peer.accountId, base, configuration: { hosts: syncedHosts, keys, proxies: [] },
  });
  assert.equal(resumed.conflicts?.length ?? 0, 0);
  assert.ok(resumed.inspection?.revision, "Recovered device received a verified sync revision");
  assert.equal(resumed.base.wrappedKey.kdf, "Argon2id-sync-password-v1");
  console.log("邮箱找回撤销旧会话并保留数据，设备 B 使用本机密钥恢复同步。");
  await evaluate(setupB, () => {
    if ([...document.querySelectorAll(".arco-menu-item")]
      .some((item) => item.textContent.trim() === "密钥" && item.getClientRects().length)) return;
    [...document.querySelectorAll(".arco-menu-inline-header")]
      .find((item) => item.textContent.trim() === "连接与安全")?.click();
  });
  await click(setupB, "密钥");
  await click(setupB, "生成密钥");
  await until("Show SSH key generation form", () => evaluate(setupB, () =>
    !!document.querySelector(".arco-modal input")));
  await screenshot(setupB, "zhandu-ssh-key-generate.png");
  await evaluate(setupB, () => {
    const input = document.querySelector(".arco-modal input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Rotated fixture identity");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(setupB, "生成密钥", ".arco-modal button");
  const replacementPublicKey = await until("Generated replacement key", () => evaluate(setupB, () =>
    document.querySelector(".arco-modal textarea")?.value));
  await evaluate(setupB, () => document.querySelector(".arco-modal .arco-select-view").click());
  await click(setupB, "Smoke generated key host（fineshell-generated@127.0.0.1）", ".arco-select-option");
  await click(setupB, "已安装，验证并启用", ".arco-modal button");
  await until("Reject uninstalled public key", () => evaluate(setupB, () => document.body.innerText.includes("私钥认证失败")));
  assert.equal((await evaluate(b, configuration)).hosts.find(({ id }) => id === hosts[2].id).sshKeyId, generatedKeyId);
  fixture.allowPublicKey(hosts[2].username, replacementPublicKey);
  await click(setupB, "已安装，验证并启用", ".arco-modal button");
  await until("Show manual old key removal guidance", () => evaluate(setupB, () =>
    document.body.innerText.includes("新密钥已验证并启用")));
  assert.notEqual((await evaluate(b, configuration)).hosts.find(({ id }) => id === hosts[2].id).sshKeyId, generatedKeyId);
  console.log("未安装的新密钥未替换原配置，授权后验证成功并提示手动撤销旧公钥。");
} finally {
  if (server?.listening) await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
