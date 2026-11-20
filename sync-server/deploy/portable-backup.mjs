import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, link, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { checkSnapshot, createSnapshot } from "./backup-snapshot.mjs";

const magic = Buffer.from("FineShellBackup1\0");
const headerLength = magic.length + 12;
const tagLength = 16;

async function encrypt(database, key, temporary) {
  const snapshot = join(temporary, "snapshot.sqlite");
  await createSnapshot(database, snapshot);

  const nonce = randomBytes(12);
  const header = Buffer.concat([magic, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const encrypted = join(temporary, "encrypted");
  await appendFile(encrypted, header, { flag: "wx", mode: 0o600 });
  await pipeline(createReadStream(snapshot), cipher, createWriteStream(encrypted, { flags: "a" }));
  await appendFile(encrypted, cipher.getAuthTag());
  return encrypted;
}

async function decrypt(encrypted, key, temporary) {
  const snapshot = join(temporary, "snapshot.sqlite");
  const input = await open(encrypted, "r");
  try {
    const { size } = await input.stat();
    const header = Buffer.alloc(headerLength);
    const tag = Buffer.alloc(tagLength);
    if (size <= headerLength + tagLength ||
        (await input.read(header, 0, header.length, 0)).bytesRead !== header.length ||
        (await input.read(tag, 0, tag.length, size - tag.length)).bytesRead !== tag.length ||
        !header.subarray(0, magic.length).equals(magic)) {
      throw new Error("Invalid FineShell backup format");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(input.createReadStream({ start: headerLength, end: size - tag.length - 1, autoClose: false }),
      decipher, createWriteStream(snapshot, { flags: "wx", mode: 0o600 }));
  } finally {
    await input.close();
  }
  checkSnapshot(snapshot);
  const db = new DatabaseSync(snapshot);
  try {
    db.exec("BEGIN; DELETE FROM sessions;");
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (hasTable.get("email_verifications")) db.exec("DELETE FROM email_verifications");
    if (hasTable.get("invites")) db.exec("DELETE FROM invites");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return snapshot;
}

const [operation, source, ...paths] = process.argv.slice(2);
const verifyOnly = operation === "verify";
if (!["backup", "restore", "verify"].includes(operation) || !source ||
    paths.length !== (verifyOnly ? 1 : 2) || paths.some((path) => !path)) {
  throw new Error([
    "Usage: node portable-backup.mjs <backup|restore> <source> <destination> <key-file>",
    "       node portable-backup.mjs verify <backup-file> <key-file>",
  ].join("\n"));
}
process.umask(0o077);
const target = verifyOnly ? undefined : resolve(paths[0]);
const temporary = await mkdtemp(join(target ? dirname(target) : tmpdir(), ".fineshell-portable-"));
try {
  const key = await readFile(paths.at(-1));
  try {
    if (key.length !== 32) throw new Error("Use a dedicated 32-byte random backup key file");
    const result = operation === "backup"
      ? await encrypt(source, key, temporary)
      : await decrypt(source, key, temporary);
    if (verifyOnly) {
      console.log("Backup verification passed");
    } else {
      // Publish only verified output and leave an existing destination intact.
      await link(result, target);
      console.log(target);
    }
  } finally {
    key.fill(0);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
