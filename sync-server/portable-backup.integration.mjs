import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSyncServer } from "./server.mjs";

const cli = fileURLToPath(new URL("./deploy/portable-backup.mjs", import.meta.url));
const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args]);
const bytes = (length) => randomBytes(length).toString("base64");

test("verifies a portable backup, restores into a fresh database, and resumes sync after login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fineshell-portable-"));
  const active = join(dir, "active.sqlite");
  const file = join(dir, "encrypted");
  const key = join(dir, "key");
  const wrongKey = join(dir, "wrong-key");
  const fresh = join(dir, "fresh");
  const verificationTemp = join(dir, "verification-temp");
  const restored = join(fresh, "vault.sqlite");
  const verify = (backup, keyFile) => promisify(execFile)(
    process.execPath, [cli, "verify", backup, keyFile], {
      env: { ...process.env, TMPDIR: verificationTemp, TMP: verificationTemp, TEMP: verificationTemp },
    },
  );
  let server;
  let origin;
  async function start(database, options) {
    server = createSyncServer(database, options);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}/v1/`;
  }
  async function call(path, { method = "GET", token, body } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  try {
    await mkdir(fresh);
    await mkdir(verificationTemp);
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    await writeFile(wrongKey, randomBytes(32), { mode: 0o600 });
    await start(active);
    const credentials = { email: "backup-fixture@example.test", password: "fixture-only-password" };
    const vault = { version: 1, wrappedKey: { algorithm: "XChaCha20-Poly1305", kdf: "Argon2id",
      salt: bytes(16), nonce: bytes(24), ciphertext: bytes(48) }, nonce: bytes(24), ciphertext: bytes(96) };
    const registered = await call("register", {
      method: "POST", body: { ...credentials, accountId: randomBytes(16).toString("hex"), vault },
    });
    assert.equal(registered.status, 200);
    await run("backup", active, file, key);
    const originalBackup = await readFile(file);
    assert(!originalBackup.includes(credentials.email));
    assert.match((await verify(file, key)).stdout, /Backup verification passed/);
    assert.deepEqual(await readFile(file), originalBackup);
    assert.deepEqual(await readdir(verificationTemp), []);
    await assert.rejects(verify(file, wrongKey), /authenticate/);
    assert.deepEqual(await readdir(verificationTemp), []);
    await assert.rejects(run("restore", file, restored, wrongKey), /authenticate/);
    const tampered = await readFile(file);
    tampered[tampered.length - 1] ^= 1;
    const damaged = join(dir, "damaged");
    await writeFile(damaged, tampered);
    await assert.rejects(verify(damaged, key), /authenticate/);
    assert.deepEqual(await readdir(verificationTemp), []);
    await assert.rejects(run("restore", damaged, restored, key), /authenticate/);
    await run("restore", file, restored, key);
    await assert.rejects(run("restore", file, restored, key), /EEXIST/);

    await new Promise((resolve) => server.close(resolve));
    await start(restored, { registration: "closed" });
    assert.equal((await call("vault", { token: registered.data.token })).status, 401);
    const login = await call("login", { method: "POST", body: credentials });
    assert.equal(login.status, 200);
    assert.equal(login.data.accountId, registered.data.accountId);
    assert.deepEqual((await call("vault", { token: login.data.token })).data, { revision: 1, vault });
    const next = { ...vault, ciphertext: bytes(96) };
    assert.equal((await call("vault", {
      method: "PUT", token: login.data.token, body: { revision: 1, vault: next },
    })).data.revision, 2);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
