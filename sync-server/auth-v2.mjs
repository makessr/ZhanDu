import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as opaque from "@serenity-kit/opaque";
import { normalizedEmail } from "./onboarding.mjs";

await opaque.ready;

const id = () => randomBytes(24).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest();
const exchangeLifetime = 5 * 60_000;
const resetLifetime = 15 * 60_000;
const capacity = 4096;

export function createOpaqueAuth({
  setup, db, onboarding, readAccount, verifyLegacy, issueSession, validateVault,
  revokeAccountSessions, sendRecovery, HttpError,
}) {
  const publicKey = opaque.server.getPublicKey(setup);
  const expectedSetup = digest(setup).toString("hex");
  const previous = db.prepare("SELECT value FROM sync_auth_metadata WHERE name = 'opaque_setup'").get();
  if (previous && previous.value !== expectedSetup) throw new Error("OPAQUE setup does not match this database");
  db.prepare("INSERT OR IGNORE INTO sync_auth_metadata VALUES ('opaque_setup', ?)").run(expectedSetup);

  const addAccount = db.prepare(`
    INSERT OR IGNORE INTO accounts (id,email,salt,password_hash,opaque_record,revision,vault)
    VALUES (?,?,'','',?,1,?)
  `);
  const replaceCredential = db.prepare(`
    UPDATE accounts SET opaque_record = ?, salt = '', password_hash = ''
    WHERE id = ? AND password_hash = ? AND opaque_record IS ?
  `);
  const pending = new Map();
  const recovery = new Map();
  const attempts = new Map();
  const probe = opaque.client.startLogin({ password: id() }).startLoginRequest;
  let pendingMail = 0;

  function emailOf(body) {
    const email = normalizedEmail(body.email);
    if (!email) throw new HttpError(400, "Enter a valid email");
    return email;
  }

  function message(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_+/-]{1,2048}={0,2}$/.test(value)) {
      throw new HttpError(400, "Invalid authentication message");
    }
    return value;
  }

  function parseProtocol(callback) {
    try { return callback(); } catch { throw new HttpError(400, "Invalid authentication message"); }
  }

  function limit(email, group) {
    const key = group + ":" + email;
    const now = Date.now();
    const count = attempts.get(key);
    if ((!count && attempts.size >= capacity) ||
        (count?.expires > now && count.value >= 8)) throw new HttpError(429, "Too many attempts");
    attempts.set(key, count?.expires > now
      ? { ...count, value: count.value + 1 }
      : { value: 1, expires: now + 60_000 });
  }

  function begin(data) {
    if (pending.size >= capacity) throw new HttpError(429, "Too many pending authentication exchanges");
    const exchange = id();
    pending.set(exchange, { ...data, expires: Date.now() + exchangeLifetime });
    return exchange;
  }

  function consume(exchange, flow) {
    const entry = typeof exchange === "string" && pending.get(exchange);
    if (!entry || entry.flow !== flow || entry.expires <= Date.now()) {
      throw new HttpError(401, "Authentication exchange expired. Try again");
    }
    pending.delete(exchange);
    return entry;
  }

  function startRegistration(flow, email, body, entry = {}) {
    const { registrationResponse } = parseProtocol(() => opaque.server.createRegistrationResponse({
      serverSetup: setup, userIdentifier: email, registrationRequest: message(body.registrationRequest),
    }));
    return { exchange: begin({ flow, email, ...entry }), registrationResponse };
  }

  function validRecord(record, email) {
    const registrationRecord = message(record);
    parseProtocol(() => opaque.server.startLogin({
      serverSetup: setup, userIdentifier: email, startLoginRequest: probe, registrationRecord,
    }));
    return registrationRecord;
  }

  function changeCredential(entry, record, deviceName, signIn = true) {
    const { account } = entry;
    if (!account) throw new HttpError(403, "Unable to change account credentials");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!replaceCredential.run(record, account.id, account.password_hash, account.opaque_record).changes) {
        throw new HttpError(409, "Account credentials changed. Try again");
      }
      revokeAccountSessions.run(account.id);
      const session = signIn ? issueSession(account.id, deviceName) : {};
      db.exec("COMMIT");
      return session;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function handle(path, body) {
    switch (path) {
      case "login/start": {
        const email = emailOf(body);
        limit(email, "login");
        const account = readAccount.get(email);
        const record = account?.opaque_record;
        const { serverLoginState, loginResponse } = parseProtocol(() => opaque.server.startLogin({
          serverSetup: setup, userIdentifier: email, registrationRecord: record,
          startLoginRequest: message(body.startLoginRequest),
        }));
        return { exchange: begin({ flow: "login", account: record ? account : null, email, serverLoginState }), loginResponse };
      }
      case "login/finish": {
        const entry = consume(body.exchange, "login");
        try {
          opaque.server.finishLogin({
            serverLoginState: entry.serverLoginState, finishLoginRequest: message(body.finishLoginRequest),
          });
        } catch {
          throw new HttpError(401, "Invalid account or password");
        }
        const current = readAccount.get(entry.email);
        if (!entry.account || current?.id !== entry.account.id ||
            current.opaque_record !== entry.account.opaque_record) throw new HttpError(401, "Invalid account or password");
        return issueSession(current.id, body.deviceName);
      }
      case "register/start": {
        const email = emailOf(body);
        limit(email, "register");
        if (!onboarding.authorized(email, body)) throw new HttpError(403, "Registration is unavailable or verification is invalid");
        return startRegistration("register", email, body, { proof: {
          inviteCode: body.inviteCode, verificationCode: body.verificationCode,
        } });
      }
      case "register/finish": {
        const entry = consume(body.exchange, "register");
        if (typeof body.accountId !== "string" || !/^[a-f0-9]{32}$/.test(body.accountId)) {
          throw new HttpError(400, "Invalid account identifier");
        }
        const vault = validateVault(body.vault);
        const record = validRecord(body.registrationRecord, entry.email);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!onboarding.consume(entry.email, entry.proof)) throw new HttpError(403, "Registration verification expired");
          if (!addAccount.run(body.accountId, entry.email, record, JSON.stringify(vault)).changes) {
            throw new HttpError(409, "This account already exists");
          }
          const session = issueSession(body.accountId, body.deviceName);
          db.exec("COMMIT");
          return session;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      case "upgrade/start": {
        const email = emailOf(body);
        limit(email, "upgrade");
        const account = await verifyLegacy(email, body.password);
        return startRegistration("upgrade", email, body, { account });
      }
      case "upgrade/finish": {
        const entry = consume(body.exchange, "upgrade");
        return changeCredential(entry, validRecord(body.registrationRecord, entry.email), body.deviceName);
      }
      case "recovery/request": {
        if (!sendRecovery) throw new HttpError(404, "Account recovery is not configured");
        const email = emailOf(body);
        limit(email, "recovery");
        const now = Date.now();
        const old = recovery.get(email);
        if (old?.sentAt > now - 60_000 || pendingMail >= 8 || recovery.size >= capacity) return {};
        const account = readAccount.get(email);
        const code = id();
        const entry = { hash: digest(code), account, sentAt: now, expires: now + resetLifetime };
        recovery.set(email, entry);
        if (account) {
          pendingMail++;
          void Promise.resolve().then(() => sendRecovery(email, code)).catch(() => {
            // Keep the same throttling window even if delivery fails.
            entry.account = null;
          }).finally(() => { pendingMail--; });
        }
        return {};
      }
      case "recovery/start": {
        if (!sendRecovery) throw new HttpError(404, "Account recovery is not configured");
        const email = emailOf(body);
        limit(email, "recovery");
        const entry = recovery.get(email);
        if (!entry?.account || entry.expires <= Date.now() || typeof body.code !== "string" ||
            !/^[A-Za-z0-9_-]{32}$/.test(body.code) || !timingSafeEqual(entry.hash, digest(body.code))) {
          throw new HttpError(403, "Invalid or expired recovery code");
        }
        const result = startRegistration("recovery", email, body, { account: entry.account });
        recovery.delete(email);
        return result;
      }
      case "recovery/finish": {
        const entry = consume(body.exchange, "recovery");
        return changeCredential(entry, validRecord(body.registrationRecord, entry.email), body.deviceName, false);
      }
      default: throw new HttpError(404, "Not found");
    }
  }

  return { publicKey, recoveryEnabled: Boolean(sendRecovery), handle, sweep(now) {
    for (const cache of [pending, recovery, attempts]) {
      for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
    }
  } };
}
