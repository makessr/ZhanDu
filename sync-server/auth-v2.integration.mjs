import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as opaque from "@serenity-kit/opaque";
import { createSyncServer } from "./server.mjs";

await opaque.ready;
const bytes = (n) => randomBytes(n).toString("base64");
const newVault = () => ({
  version: 1,
  wrappedKey: { algorithm: "XChaCha20-Poly1305", kdf: "Argon2id-sync-password-v1",
    salt: bytes(16), nonce: bytes(24), ciphertext: bytes(48) },
  nonce: bytes(24), ciphertext: bytes(96),
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhandu-opaque-"));
  const database = join(directory, "vault.sqlite");
  const setup = opaque.server.createSetup();
  let app, origin;
  const close = async () => {
    if (app?.listening) await new Promise((done) => app.close(done));
  };
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    database, setup, close,
    async start(options) {
      app = createSyncServer(database, options);
      app.listen(0, "127.0.0.1");
      await once(app, "listening");
      origin = "http://127.0.0.1:" + app.address().port + "/v1/";
    },
    async request(path, body, token) {
      const response = await fetch(origin + path, {
        method: body ? "POST" : "GET",
        headers: { ...(body && { "content-type": "application/json" }),
          ...(token && { authorization: "Bearer " + token }) },
        body: body && JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

async function enroll(f, phase, email, password, startFields = {}, finishFields = {}) {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const start = await f.request("auth/" + phase + "/start", { email, registrationRequest, ...startFields });
  assert.equal(start.status, 200);
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState, registrationResponse: start.data.registrationResponse, password,
  });
  const payload = { exchange: start.data.exchange, registrationRecord, ...finishFields };
  const finish = await f.request("auth/" + phase + "/finish", payload);
  assert.equal(finish.status, 200);
  return { ...finish.data, payload };
}

async function loginStart(f, email, password) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const start = await f.request("auth/login/start", { email, startLoginRequest });
  assert.equal(start.status, 200);
  const result = opaque.client.finishLogin({
    clientLoginState, loginResponse: start.data.loginResponse, password,
  });
  return result && { exchange: start.data.exchange, finishLoginRequest: result.finishLoginRequest };
}

test("OPAQUE recovery changes login credentials, revokes sessions, and preserves encrypted data", async (t) => {
  const f = await fixture(t);
  const delivered = new Map();
  await f.start({ opaqueSetup: f.setup, sendRecovery: (email, code) => delivered.set(email, code) });
  const capability = await f.request("registration");
  assert.equal(capability.data.opaquePublicKey, opaque.server.getPublicKey(f.setup));
  assert.equal(capability.data.passwordRecovery, true);
  const email = "recovery@example.test";
  const password = "fixture-signin-password";
  const accountId = randomBytes(16).toString("hex");
  const vault = newVault();
  const registered = await enroll(f, "register", email, password, {}, { accountId, vault });
  assert.equal(registered.accountId, accountId);
  assert.equal((await f.request("login", { email, password })).status, 401);
  assert.equal(await loginStart(f, email, "wrong-fixture-password"), undefined);
  assert.equal(await loginStart(f, "missing@example.test", password), undefined);
  const outdated = await loginStart(f, email, password);
  assert.ok(outdated);
  assert.deepEqual(await f.request("auth/recovery/request", { email: "missing@example.test" }),
    { status: 200, data: {} });
  assert.deepEqual(await f.request("auth/recovery/request", { email }), { status: 200, data: {} });
  assert.equal(delivered.has("missing@example.test"), false);
  const code = delivered.get(email);
  assert.ok(code);
  const wrongCode = randomBytes(24).toString("base64url");
  const { registrationRequest } = opaque.client.startRegistration({ password });
  assert.equal((await f.request("auth/recovery/start", { email, code: wrongCode, registrationRequest })).status, 403);
  const resetPassword = "another-fixture-password";
  const recovered = await enroll(f, "recovery", email, resetPassword, { code });
  assert.equal(recovered.token, undefined);
  assert.equal((await f.request("auth/recovery/finish", recovered.payload)).status, 401);
  assert.equal((await f.request("vault", null, registered.token)).status, 401);
  assert.equal((await f.request("auth/login/finish", outdated)).status, 401);
  const fresh = await f.request("auth/login/finish", await loginStart(f, email, resetPassword));
  assert.equal(fresh.status, 200);
  assert.deepEqual(await f.request("vault", null, fresh.data.token), { status: 200, data: { revision: 1, vault } });
  await f.close();
  assert.throws(() => createSyncServer(f.database), /OPAQUE setup file is required/);
  assert.throws(() => createSyncServer(f.database, { opaqueSetup: opaque.server.createSetup() }), /OPAQUE setup does not match/);
});

test("legacy account migrates using its old password and cannot use legacy authentication afterward", async (t) => {
  const f = await fixture(t);
  const email = "legacy@example.test";
  const password = "fixture-legacy-password";
  const accountId = randomBytes(16).toString("hex");
  const vault = newVault();
  await f.start();
  const registered = await f.request("register", { email, password, accountId, vault });
  assert.equal(registered.status, 200);
  await f.close();
  await f.start({ opaqueSetup: f.setup });
  const existingLegacy = await f.request("login", { email, password });
  assert.equal(existingLegacy.status, 200);
  const { registrationRequest } = opaque.client.startRegistration({ password });
  assert.equal((await f.request("auth/upgrade/start", {
    email, password: "wrong-fixture-password", registrationRequest,
  })).status, 401);
  const upgraded = await enroll(f, "upgrade", email, password, { password });
  assert.equal(upgraded.accountId, accountId);
  assert.equal((await f.request("login", { email, password })).status, 401);
  assert.equal((await f.request("vault", null, existingLegacy.data.token)).status, 401);
  const login = await f.request("auth/login/finish", await loginStart(f, email, password));
  assert.equal(login.status, 200);
  assert.deepEqual(await f.request("vault", null, login.data.token), { status: 200, data: { revision: 1, vault } });
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const row = db.prepare("SELECT salt, password_hash, opaque_record FROM accounts WHERE id=?").get(accountId);
    assert.equal(row.password_hash, "");
    assert.equal(row.salt, "");
    assert.ok(row.opaque_record);
  } finally { db.close(); }
});
