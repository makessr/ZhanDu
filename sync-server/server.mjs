import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createOpaqueAuth } from "./auth-v2.mjs";
import { createVerificationMailer, createOnboarding, normalizedEmail } from "./onboarding.mjs";

const derive = promisify(scrypt);
const maxVaultBytes = 8 * 1024 * 1024;
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request, limit) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "Expected application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "Request too large");
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Invalid JSON object");
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function credentials(body) {
  const email = normalizedEmail(body.email);
  const password = body.password;
  if (!email ||
      typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new HttpError(400, "Enter a valid email and a password of at least 12 characters");
  }
  return { email, password };
}

const masterPasswordKdf = "Argon2id-sync-password-v1";

function validateVault(vault) {
  const key = vault?.wrappedKey;
  const base64 = (value, bytes) => typeof value === "string" &&
    Buffer.from(value, "base64").length === bytes &&
    Buffer.from(value, "base64").toString("base64") === value;
  if (vault?.version !== 1 || key?.algorithm !== "XChaCha20-Poly1305" ||
      !["Argon2id", masterPasswordKdf].includes(key.kdf) || !base64(key.salt, 16) || !base64(key.nonce, 24) ||
      !base64(key.ciphertext, 48) || !base64(vault.nonce, 24) ||
      typeof vault.ciphertext !== "string" || vault.ciphertext.length < 24 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(vault.ciphertext)) {
    throw new HttpError(400, "Invalid encrypted vault");
  }
  return {
    version: 1,
    wrappedKey: {
      algorithm: key.algorithm, kdf: key.kdf, salt: key.salt,
      nonce: key.nonce, ciphertext: key.ciphertext,
    },
    nonce: vault.nonce,
    ciphertext: vault.ciphertext,
  };
}

function vaultKdf(storedVault) {
  return storedVault && JSON.parse(storedVault).wrappedKey.kdf;
}

function authSource(request, trustLoopbackProxy) {
  const peer = request.socket.remoteAddress ?? "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  const forwarded = request.headers["x-real-ip"];
  return trustLoopbackProxy && loopback && typeof forwarded === "string" && isIP(forwarded)
    ? forwarded : peer;
}

export function createSyncServer(databasePath, options = {}) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, vault TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at);
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map(({ name }) => name));
    const accountColumns = db.prepare("PRAGMA table_info(accounts)").all();
    if (!accountColumns.some(({ name }) => name === "opaque_record")) {
      db.exec("ALTER TABLE accounts ADD COLUMN opaque_record TEXT");
    }
    if (!columns.has("device_id")) db.exec("ALTER TABLE sessions ADD COLUMN device_id TEXT");
    if (!columns.has("device_name")) db.exec("ALTER TABLE sessions ADD COLUMN device_name TEXT");
    if (!columns.has("last_sync_at")) db.exec("ALTER TABLE sessions ADD COLUMN last_sync_at INTEGER");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_auth_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      UPDATE sessions SET device_id = lower(hex(randomblob(16))) WHERE device_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_device_id ON sessions(device_id);
      CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id);
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const onboarding = createOnboarding(db, options);
  const readAccount = db.prepare("SELECT id, salt, password_hash, opaque_record FROM accounts WHERE email = ?");
  const createAccount = db.prepare(
    "INSERT OR IGNORE INTO accounts (id, email, salt, password_hash, revision, vault) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const readVault = db.prepare("SELECT revision, vault FROM accounts WHERE id = ?");
  const writeVault = db.prepare("UPDATE accounts SET revision = ?, vault = ? WHERE id = ? AND revision = ?");
  const readSession = db.prepare("SELECT account_id, device_id, device_name FROM sessions WHERE token_hash = ? AND expires_at > ?");
  const createSession = db.prepare(
    "INSERT INTO sessions (token_hash,account_id,expires_at,device_id,device_name) VALUES (?,?,?,?,?)",
  );
  const listDevices = db.prepare(
    "SELECT device_id, device_name, last_sync_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_sync_at DESC, expires_at DESC",
  );
  const revokeDevice = db.prepare("DELETE FROM sessions WHERE account_id = ? AND device_id = ?");
  const recordDeviceSync = db.prepare(
    "UPDATE sessions SET last_sync_at = ? WHERE token_hash = ? AND (last_sync_at IS NULL OR last_sync_at < ?)",
  );
  const renameDevice = db.prepare("UPDATE sessions SET device_name = ? WHERE token_hash = ? AND expires_at > ?");
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const revokeAccountSessions = db.prepare("DELETE FROM sessions WHERE account_id = ?");
  const pruneSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  const dummySalt = randomBytes(16);
  const attempts = new Map();
  const sourceAttempts = new Map();
  let deriving = 0;
  let registrations = 0;
  let throttled = 0;

  function enforceSourceLimit(request, route) {
    const now = Date.now();
    const key = route + "/" + authSource(request, options.trustLoopbackProxy === true);
    let bucket = sourceAttempts.get(key);
    if (!bucket || bucket.expires <= now) {
      if (!bucket && sourceAttempts.size >= 10_000) {
        throw new HttpError(429, "Too many attempts. Try again later");
      }
      bucket = { count: 0, expires: now + 60_000 };
      sourceAttempts.set(key, bucket);
    }
    const limit = route === "/v1/login" ? 30 : 10;
    if (++bucket.count > limit) throw new HttpError(429, "Too many attempts. Try again later");
  }

  function deviceLabel(input) {
    return typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  }

  function issueSession(accountId, deviceName) {
    const now = Date.now();
    pruneSessions.run(now);
    const token = randomBytes(32).toString("base64url");
    createSession.run(hashToken(token), accountId, now + sessionLifetime,
      randomBytes(16).toString("hex"), deviceLabel(deviceName) || "栈渡");
    return { accountId, token };
  }

  async function verifyLegacy(email, password) {
    credentials({ email, password });
    if (deriving >= 4) throw new HttpError(429, "Too many attempts. Try again later");
    const existing = readAccount.get(email);
    deriving++;
    let derived;
    try {
      derived = await derive(password, existing?.opaque_record || !existing ? dummySalt : Buffer.from(existing.salt, "hex"), 32);
    } finally {
      deriving--;
    }
    const current = readAccount.get(email);
    if (!existing || existing.opaque_record || current?.opaque_record || current?.id !== existing.id ||
        current.password_hash !== existing.password_hash || !/^[a-f0-9]{64}$/.test(existing.password_hash) ||
        !timingSafeEqual(derived, Buffer.from(existing.password_hash, "hex"))) {
      throw new HttpError(401, "Invalid account or password");
    }
    return existing;
  }

  let opaqueAuth;
  try {
    if (options.opaqueSetup) {
      opaqueAuth = createOpaqueAuth({
        setup: options.opaqueSetup, db, onboarding, readAccount, verifyLegacy, issueSession,
        validateVault, revokeAccountSessions, sendRecovery: options.sendRecovery, HttpError,
      });
    } else if (db.prepare("SELECT 1 FROM sync_auth_metadata WHERE name = 'opaque_setup'").get()) {
      throw new Error("OPAQUE setup file is required for this database");
    }
  } catch (error) {
    db.close();
    throw error;
  }

  async function authenticate(request, register) {
    const body = await readJson(request, 4096);
    const { email, password } = credentials(body);
    const deviceName = deviceLabel(body.deviceName);
    const now = Date.now();
    const recent = (attempts.get(email) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 8 || deriving >= 4 || (attempts.size >= 10_000 && !attempts.has(email))) {
      throw new HttpError(429, "Too many attempts. Try again later");
    }
    attempts.set(email, [...recent, now]);
    if (register && opaqueAuth) throw new HttpError(400, "Update the client to register an account");
    if (register && onboarding.registration === "closed") {
      throw new HttpError(403, "Registration is closed");
    }
    const existing = readAccount.get(email);
    let initialVault = null;
    let proposedId = null;
    if (register && (Object.hasOwn(body, "accountId") || Object.hasOwn(body, "vault"))) {
      if (typeof body.accountId !== "string" || !/^[a-f0-9]{32}$/.test(body.accountId)) {
        throw new HttpError(400, "Invalid account identifier");
      }
      proposedId = body.accountId;
      initialVault = JSON.stringify(validateVault(body.vault));
    }
    const retry = proposedId !== null && existing?.id === proposedId;
    const creating = register && !retry;
    if (creating && !onboarding.authorized(email, body, now)) {
      throw new HttpError(403, "Invitation or email verification is invalid");
    }
    const salt = creating ? randomBytes(16) : existing && !existing.opaque_record ? Buffer.from(existing.salt, "hex") : dummySalt;
    deriving++;
    let derived;
    try {
      derived = await derive(password, salt, 32);
    } finally {
      deriving--;
    }
    let accountId;
    if (creating) {
      accountId = proposedId ?? randomBytes(16).toString("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!onboarding.consume(email, body)) throw new HttpError(403, "Invitation or email verification is invalid");
        if (!createAccount.run(accountId, email, salt.toString("hex"), derived.toString("hex"),
          initialVault ? 1 : 0, initialVault).changes) {
          throw new HttpError(409, "This account already exists");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      const current = readAccount.get(email);
      if (!existing || existing.opaque_record || current?.opaque_record || current?.id !== existing.id ||
          current.password_hash !== existing.password_hash || !/^[a-f0-9]{64}$/.test(existing.password_hash) ||
          !timingSafeEqual(derived, Buffer.from(existing.password_hash, "hex"))) {
        throw new HttpError(401, "Invalid account or password");
      }
      accountId = existing.id;
    }
    return issueSession(accountId, deviceName);
  }

  const server = createServer(async (request, response) => {
    try {
      const { method, url } = request;
      if (method === "POST" && ["/v1/login", "/v1/register", "/v1/registration/verify"].includes(url)) {
        enforceSourceLimit(request, url);
      }
      if (method === "GET" && url === "/healthz") {
        db.prepare("SELECT 1 FROM accounts LIMIT 1").get();
        send(response, 200, { service: "zhandu", status: "ok" });
        return;
      }
      if (url === "/v1/registration" && method === "GET") {
        send(response, 200, { mode: onboarding.registration, masterPassword: true,
          ...(opaqueAuth ? { opaquePublicKey: opaqueAuth.publicKey, passwordRecovery: opaqueAuth.recoveryEnabled } : {}) });
        return;
      }
      if (method === "POST" && url?.startsWith("/v1/auth/")) {
        if (!opaqueAuth) throw new HttpError(404, "Authentication upgrade is not enabled");
        const path = url.slice("/v1/auth/".length);
        enforceSourceLimit(request, "/v1/auth/" + (path.startsWith("recovery/") ? "recovery" : "exchange"));
        const result = await opaqueAuth.handle(path, await readJson(request, 8192));
        if (path === "register/finish") registrations++;
        send(response, 200, result);
        return;
      }
      if (url === "/v1/registration/verify" && method === "POST") {
        const status = await onboarding.sendCode(await readJson(request, 4096));
        if (status !== 200) throw new HttpError(status, "Could not send verification");
        send(response, 200, {});
        return;
      }
      if (method === "POST" && (url === "/v1/register" || url === "/v1/login")) {
        const registered = url === "/v1/register";
        const result = await authenticate(request, registered);
        if (registered) registrations++;
        send(response, 200, result);
        return;
      }
      const isRecovery = url === "/v1/vault/recover" && method === "POST";
      const isRotation = url === "/v1/vault/rotate-key" && method === "POST";
      const isVaultStatus = url === "/v1/vault/status" && method === "GET";
      const deviceRoute = /^\/v1\/devices\/([a-f0-9]{32})$/.exec(url ?? "");
      if (url !== "/v1/vault" && url !== "/v1/logout" && url !== "/v1/devices" && url !== "/v1/session" &&
          url !== "/v1/devices/synced" && url !== "/v1/devices/name" && !deviceRoute && !isRecovery && !isRotation && !isVaultStatus) {
        throw new HttpError(404, "Not found");
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "");
      const tokenHash = match && hashToken(match[1]);
      const session = tokenHash && readSession.get(tokenHash, Date.now());
      if (!session) throw new HttpError(401, "Sign in again");
      if (url === "/v1/session" && method === "GET") {
        send(response, 200, { accountId: session.account_id });
      } else if (url === "/v1/logout" && method === "POST") {
        deleteSession.run(tokenHash);
        send(response, 200, {});
      } else if (url === "/v1/devices" && method === "GET") {
        send(response, 200, listDevices.all(session.account_id, Date.now()).map((item) => ({
          id: item.device_id, name: item.device_name || "栈渡",
          current: item.device_id === session.device_id,
          lastSyncAt: item.last_sync_at, expiresAt: item.expires_at,
        })));
      } else if (url === "/v1/devices/name" && method === "POST") {
        const name = deviceLabel((await readJson(request, 4096)).name);
        if (!name) throw new HttpError(400, "Enter a device name");
        if (!renameDevice.run(name, tokenHash, Date.now()).changes) throw new HttpError(401, "Sign in again");
        send(response, 200, {});
      } else if (url === "/v1/devices/synced" && method === "POST") {
        const now = Date.now();
        recordDeviceSync.run(now, tokenHash, now - 60_000);
        send(response, 200, {});
      } else if (deviceRoute && method === "DELETE") {
        if (deviceRoute[1] === session.device_id) throw new HttpError(400, "Use logout for this device");
        if (!revokeDevice.run(session.account_id, deviceRoute[1]).changes) {
          throw new HttpError(404, "Device not found");
        }
        send(response, 200, {});
      } else if (isVaultStatus) {
        const { revision, vault } = readVault.get(session.account_id);
        send(response, 200, { revision, fingerprint: vault ? hashToken(vault) : null });
      } else if (url === "/v1/vault" && method === "GET") {
        const { revision, vault } = readVault.get(session.account_id);
        send(response, 200, { revision, vault: vault && JSON.parse(vault) });
      } else if (isRotation) {
        const { revision, vault } = await readJson(request, maxVaultBytes);
        if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(revision + 1)) {
          throw new HttpError(400, "Invalid vault revision");
        }
        const encrypted = validateVault(vault);
        const token = randomBytes(32).toString("base64url");
        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!readSession.get(tokenHash, now)) throw new HttpError(401, "Sign in again");
          if (vaultKdf(readVault.get(session.account_id).vault) === masterPasswordKdf &&
              encrypted.wrappedKey.kdf !== masterPasswordKdf) {
            throw new HttpError(409, "Master password protection cannot be downgraded");
          }
          if (!writeVault.run(revision + 1, JSON.stringify(encrypted), session.account_id, revision).changes) {
            throw new HttpError(409, "Vault changed. Read the current revision and try again");
          }
          revokeAccountSessions.run(session.account_id);
          createSession.run(hashToken(token), session.account_id, now + sessionLifetime,
            session.device_id, session.device_name);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        send(response, 200, { revision: revision + 1, token });
      } else if ((url === "/v1/vault" && method === "PUT") || isRecovery) {
        const { revision, vault, nextRevision } = await readJson(request, maxVaultBytes);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new HttpError(400, "Invalid vault revision");
        }
        const next = isRecovery ? nextRevision : revision + 1;
        if (!Number.isSafeInteger(next) || next <= revision || (isRecovery && next === revision + 1)) {
          throw new HttpError(400, "Invalid next vault revision");
        }
        const encrypted = validateVault(vault);
        if (!readSession.get(tokenHash, Date.now())) {
          throw new HttpError(401, "Sign in again");
        }
        const protection = vaultKdf(readVault.get(session.account_id).vault);
        if (protection && protection !== encrypted.wrappedKey.kdf &&
            !(isRecovery && encrypted.wrappedKey.kdf === masterPasswordKdf)) {
          throw new HttpError(409, "Use key rotation to change vault protection");
        }
        if (!writeVault.run(next, JSON.stringify(encrypted), session.account_id, revision).changes) {
          throw new HttpError(409, "Vault changed. Read the current revision and try again");
        }
        send(response, 200, { revision: next });
      } else {
        throw new HttpError(405, "Method not allowed");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) {
          throttled++;
          request.resume();
        }
        send(response, error.status, { error: error.message });
      } else {
        console.error("Sync request failed", error.code ?? error.name);
        send(response, 500, { error: "Sync server error" });
      }
    }
  });
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [email, times] of attempts) {
      if (times.at(-1) < cutoff) attempts.delete(email);
    }
    const now = Date.now();
    for (const [source, bucket] of sourceAttempts) {
      if (bucket.expires <= now) sourceAttempts.delete(source);
    }
    opaqueAuth?.sweep(now);
    if (registrations >= 10 || throttled >= 20) {
      console.warn("ZhanDu authentication activity", JSON.stringify({ registrations, throttled, windowSeconds: 60 }));
    }
    registrations = 0;
    throttled = 0;
  }, 60_000).unref();
  server.on("close", () => {
    clearInterval(sweep);
    db.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databasePath = process.env.FINESHELL_SYNC_DATABASE;
  if (!databasePath) throw new Error("Set FINESHELL_SYNC_DATABASE to a persistent SQLite file");
  const port = Number(process.env.FINESHELL_SYNC_PORT ?? 8787);
  const host = process.env.FINESHELL_SYNC_HOST || "127.0.0.1";
  const registration = process.env.FINESHELL_SYNC_REGISTRATION || "open";
  const setupPath = process.env.FINESHELL_SYNC_OPAQUE_SETUP_FILE;
  if (setupPath && process.env.FINESHELL_SYNC_OPAQUE_SETUP) throw new Error("Use one OPAQUE setup source");
  const opaqueSetup = setupPath ? readFileSync(setupPath, "utf8").trim() : process.env.FINESHELL_SYNC_OPAQUE_SETUP?.trim();
  if (setupPath && !opaqueSetup) throw new Error("OPAQUE setup file is empty");
  const recoveryEnabled = Boolean(opaqueSetup && process.env.FINESHELL_SYNC_MAIL_FROM);
  const mailer = registration === "invite" || recoveryEnabled ? createVerificationMailer(process.env) : undefined;
  const server = createSyncServer(databasePath, {
    registration,
    sendVerification: mailer,
    sendRecovery: recoveryEnabled ? (email, code) => mailer(email, code, "recovery") : undefined,
    opaqueSetup,
    trustLoopbackProxy: process.env.FINESHELL_SYNC_TRUST_LOOPBACK_PROXY === "1",
  });
  server.listen(port, host, () => {
    console.log(`ZhanDu sync listening on ${host}:${port}`);
  });
  process.once("SIGTERM", () => server.close());
  process.once("SIGINT", () => server.close());
}
