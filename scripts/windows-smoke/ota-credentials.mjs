import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startSshFixture } from "./ssh-fixture.mjs";
import { evaluate, findWindow, invoke, until } from "./webview.mjs";

const [port, baseline, target, marker, ssh2Path] = process.argv.slice(2);
const { default: ssh2 } = await import(pathToFileURL(resolve(ssh2Path)).href);
const run = promisify(execFile);
const otaScript = fileURLToPath(new URL("./ota.mjs", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "fineshell-ota-credentials-"));
const suffix = randomUUID();
const passwordId = "ota-password-" + suffix;
const keyHostId = "ota-key-host-" + suffix;
const keyId = "ota-key-" + suffix;

function storedConfiguration(seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fineshell.config");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("configuration")) {
        db.close();
        reject(new Error("Configuration database is not ready"));
        return;
      }
      const tx = db.transaction("configuration", seed ? "readwrite" : "readonly");
      const store = tx.objectStore("configuration");
      const item = store.get("primary");
      let result;
      item.onsuccess = () => {
        const current = item.result ?? { id: "primary" };
        result = { hosts: current.hosts ?? [], sshKeys: current.sshKeys ?? [] };
        if (seed) store.put({ ...current, ...seed });
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

async function runOta(phase) {
  const { stdout } = await run(process.execPath, [
    otaScript,
    phase,
    port,
    baseline,
    target,
    marker,
  ]);
  process.stdout.write(stdout);
}

async function beginSignedUpdate(view, request, expectedRoute, currentVersion, nextVersion) {
  const update = await invoke(view, "application_update_check", { request });
  assert.equal(update?.currentVersion, currentVersion);
  assert.equal(update?.version, nextVersion);
  assert.equal(update?.route, expectedRoute);
  await evaluate(
    view,
    (updateId) => {
      const api = window.__TAURI_INTERNALS__;
      delete window.__otaInstallError;
      const channelId = api.transformCallback(() => {});
      void api
        .invoke("application_update_download_and_install", {
          updateId,
          onEvent: "__CHANNEL__:" + channelId,
        })
        .catch((error) => {
          window.__otaInstallError = error?.message ?? String(error);
        });
    },
    update.updateId,
  );
}

function waitForVersion(version, checkError = false) {
  return until(
    "Restart into " + version,
    async () => {
      const view = await findWindow(port, "main");
      if (checkError) {
        const error = await evaluate(view, () => window.__otaInstallError);
        if (error) throw new Error(error);
      }
      return (await invoke(view, "plugin:app|version")) === version ? view : false;
    },
    150_000,
  );
}

async function connectSavedHost(view, host, method, fixture) {
  await evaluate(view, () => document.querySelector(".terminal-home-tab")?.click());
  await until("Connect to saved " + method + " host", () =>
    evaluate(
      view,
      (name) => {
        const row = [...document.querySelectorAll("tr")].find((item) =>
          item.textContent.includes(name),
        );
        const button = [...(row?.querySelectorAll("button") ?? [])].find(
          (item) => item.textContent.trim() === "连接",
        );
        if (!button) return false;
        button.click();
        return true;
      },
      host.name,
    ),
  );
  await until("Authenticate using saved " + method, async () => {
    const connected = await evaluate(
      view,
      (fingerprint) => {
        const modal = document.querySelector(".fingerprint-confirm-modal");
        if (modal) {
          if (!modal.textContent.includes(fingerprint))
            throw new Error("Loopback fixture fingerprint mismatched");
          [...modal.querySelectorAll("button")]
            .find((button) => button.textContent.trim() === "信任并连接")
            ?.click();
        }
        return (
          !!document.querySelector(".terminal-status-connected") &&
          !!document.querySelector(".xterm")
        );
      },
      fixture.fingerprint,
    );
    return connected && fixture.counts[method] > 0;
  });
  console.log("Upgraded FineShell opened a terminal using saved " + method + " authentication.");
}

let fixture;
try {
  fixture = await startSshFixture(ssh2, directory);
  const oldView = await findWindow(port, "main");
  assert.equal(await invoke(oldView, "plugin:app|version"), baseline);
  const initial = await until("Initialize baseline profile", () =>
    evaluate(oldView, storedConfiguration),
  );
  assert.equal(initial.hosts.length, 0);
  assert.equal(initial.sshKeys.length, 0);
  const common = {
    address: "127.0.0.1",
    port: fixture.port,
    group: "OTA test",
    connectTimeoutSeconds: 8,
    keepAliveIntervalSeconds: 15,
    autoReconnect: false,
    maxReconnectAttempts: 0,
  };
  const hosts = [
    {
      ...common,
      id: passwordId,
      name: "OTA password host",
      username: "fineshell-password",
      authMethod: "password",
    },
    {
      ...common,
      id: keyHostId,
      name: "OTA key host",
      username: "fineshell-key",
      authMethod: "privateKey",
      sshKeyId: keyId,
    },
  ];
  const imported = await invoke(oldView, "managed_ssh_key_import", {
    keyId,
    privateKey: await readFile(fixture.deviceKeyFile, "utf8"),
  });
  assert.equal(imported.reference, "managed://" + keyId);
  await rm(fixture.deviceKeyFile);
  await invoke(oldView, "store_host_password", { hostId: passwordId, password: fixture.password });
  await invoke(oldView, "store_private_key_passphrase", {
    hostId: keyId,
    passphrase: fixture.keyPassphrase,
  });
  await evaluate(oldView, storedConfiguration, {
    hosts,
    sshKeys: [
      {
        id: keyId,
        name: "OTA managed key",
        privateKeyPath: imported.reference,
        source: "managed",
      },
    ],
  });
  console.log(
    "Baseline saved two hosts, a managed encrypted key, and credentials in the Windows credential store.",
  );
  await evaluate(
    oldView,
    (marker) => localStorage.setItem("fineshell-ota-smoke-marker", marker),
    marker,
  );
  await beginSignedUpdate(oldView, { route: "direct" }, "GitHub 直连", baseline, target);
  const newView = await waitForVersion(target, true);
  await runOta("verify");
  console.log("GitHub Direct installed v" + baseline + " -> v" + target + ".");
  const after = await evaluate(newView, storedConfiguration);
  assert.deepEqual(after.hosts.map(({ id }) => id).sort(), [passwordId, keyHostId].sort());
  assert.equal(after.sshKeys.find(({ id }) => id === keyId)?.privateKeyPath, imported.reference);
  assert.deepEqual(fixture.counts, { password: 0, publickey: 0 });
  await connectSavedHost(newView, hosts[0], "password", fixture);
  await connectSavedHost(newView, hosts[1], "publickey", fixture);

  await invoke(newView, "delete_host_password", { hostId: passwordId });
  await invoke(newView, "delete_private_key_passphrase", { hostId: keyId });
  await invoke(newView, "managed_ssh_key_delete", { keyId });
} finally {
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
