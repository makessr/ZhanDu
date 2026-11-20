import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import nodemailer from "nodemailer";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(18).toString("base64url");
const tokenPattern = /^[A-Za-z0-9_-]{24}$/;
const verificationLifetime = 15 * 60_000;
const inviteLifetime = 7 * 24 * 60 * 60_000;

export function normalizedEmail(input) {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  return /^[^@\s<>,;:"\\]+@[^@\s<>,;:"\\]+\.[^@\s<>,;:"\\]+$/.test(email) &&
    email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(email) ? email : "";
}

export function initializeOnboarding(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      invite_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS email_verifications (
      invite_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL
    ) STRICT;
  `);
}

export function createInvite(db, email) {
  email = normalizedEmail(email);
  if (!email) throw new Error("Enter a valid email address");
  const now = Date.now();
  db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM email_verifications WHERE expires_at <= ?").run(now);
  const invite = token();
  db.prepare("INSERT INTO invites VALUES (?, ?, ?)").run(hash(invite), email, now + inviteLifetime);
  return invite;
}

export function createOnboarding(db, { registration = "open", sendVerification } = {}) {
  if (!["open", "invite", "closed"].includes(registration)) throw new Error("Invalid registration mode");
  if (registration === "invite" && !sendVerification) throw new Error("Invite registration requires a mail sender");
  initializeOnboarding(db);
  const readInvite = db.prepare("SELECT 1 FROM invites WHERE invite_hash = ? AND email = ? AND expires_at > ?");
  const writeCode = db.prepare(`
    INSERT INTO email_verifications VALUES (?, ?, ?, ?)
    ON CONFLICT(invite_hash) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at
    WHERE email_verifications.sent_at <= excluded.sent_at - 60_000
  `);
  const readCode = db.prepare(
    "SELECT 1 FROM email_verifications WHERE invite_hash = ? AND code_hash = ? AND expires_at > ?",
  );
  const deleteCode = db.prepare("DELETE FROM email_verifications WHERE invite_hash = ?");
  const deleteSentCode = db.prepare("DELETE FROM email_verifications WHERE invite_hash = ? AND code_hash = ?");
  const deleteInvite = db.prepare("DELETE FROM invites WHERE invite_hash = ?");

  function inviteFor(email, value, now) {
    if (typeof value !== "string" || !tokenPattern.test(value)) return null;
    const invite = hash(value);
    return readInvite.get(invite, email, now) ? invite : null;
  }
  function authorized(email, body, now = Date.now()) {
    if (registration === "open") return true;
    if (registration === "closed") return false;
    const invite = inviteFor(email, body.inviteCode, now);
    return Boolean(invite && typeof body.verificationCode === "string" &&
      tokenPattern.test(body.verificationCode) && readCode.get(invite, hash(body.verificationCode), now));
  }
  return {
    registration,
    authorized,
    consume(email, body) {
      if (!authorized(email, body)) return false;
      if (registration === "invite") {
        const invite = hash(body.inviteCode);
        deleteCode.run(invite);
        deleteInvite.run(invite);
      }
      return true;
    },
    async sendCode(body) {
      if (registration !== "invite") return 405;
      const now = Date.now();
      const email = normalizedEmail(body.email);
      const invite = email && inviteFor(email, body.inviteCode, now);
      if (!invite) return 403;
      const code = token();
      const codeHash = hash(code);
      if (!writeCode.run(invite, codeHash, now + verificationLifetime, now).changes) return 429;
      try {
        await sendVerification(email, code);
        return 200;
      } catch {
        deleteSentCode.run(invite, codeHash);
        return 503;
      }
    },
  };
}

function verificationText(code) {
  return "请在栈渡注册窗口输入以下验证码，15 分钟内有效。\n\n" + code;
}

const verificationSubject = "栈渡邮箱验证";

export function createVerificationMailer(env, createTransport = nodemailer.createTransport) {
  const provider = env.FINESHELL_SYNC_MAIL_PROVIDER || "resend";
  const from = env.FINESHELL_SYNC_MAIL_FROM;
  if (provider === "resend") return createMailSender(from, env.FINESHELL_SYNC_RESEND_API_KEY);
  if (provider !== "smtp") throw new Error("Invalid mail provider");
  const host = env.FINESHELL_SYNC_SMTP_HOST;
  const port = Number(env.FINESHELL_SYNC_SMTP_PORT || 465);
  const user = env.FINESHELL_SYNC_SMTP_USER;
  const pass = env.FINESHELL_SYNC_SMTP_PASSWORD;
  if (!normalizedEmail(from) || !host || !user || !pass || ![465, 587].includes(port)) {
    throw new Error("Set the SMTP host, port (465 or 587), sender, username and password");
  }
  const transport = createTransport({
    host, port, secure: port === 465, requireTLS: port === 587,
    auth: { user, pass },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 8_000,
    tls: { minVersion: "TLSv1.2" },
  });
  return async (email, code) => {
    const result = await transport.sendMail({
      from: { name: "栈渡", address: from }, to: { address: email, name: "" },
      subject: verificationSubject, text: verificationText(code),
    });
    if (!result.accepted.length) throw new Error("No accepted recipient");
  };
}

function createMailSender(from, apiKey) {
  if (!from || !apiKey) throw new Error("Set FINESHELL_SYNC_MAIL_FROM and FINESHELL_SYNC_RESEND_API_KEY");
  const sender = normalizedEmail(from) ? `栈渡 <${from}>` : from;
  return async (email, code) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        "user-agent": "ZhanDu Sync",
      },
      body: JSON.stringify({
        from: sender, to: [email], subject: verificationSubject,
        text: verificationText(code),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Email delivery failed");
    await response.body?.cancel();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, email] = process.argv.slice(2);
  const databasePath = process.env.FINESHELL_SYNC_DATABASE;
  if (command !== "invite" || !databasePath) throw new Error("Set FINESHELL_SYNC_DATABASE and run onboarding.mjs invite EMAIL");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    initializeOnboarding(db);
    console.log(createInvite(db, email));
  } finally {
    db.close();
  }
}
