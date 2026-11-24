export interface EncryptedLocalRecord {
  ciphertext: string;
  format: "zhandu-local-encrypted";
  iv: string;
  version: 1;
}

const DATABASE_NAME = "fineshell.security";
const DATABASE_VERSION = 1;
const METADATA_STORE = "encryption";
const METADATA_ID = "local-data";

export const LOCAL_ENCRYPTION_KDF_ITERATIONS = 600_000;
export const LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH = 10;
export const ENCRYPTED_LOCAL_RECORD_FORMAT = "zhandu-local-encrypted";
const KEY_CHECK_PLAINTEXT = "zhandu-local-data-key-check-v1";
const ADDITIONAL_DATA = new TextEncoder().encode("zhandu.local-data.v1");

export interface LocalEncryptionMetadata {
  algorithm: "AES-GCM";
  createdAt: string;
  id: string;
  iterations: number;
  kdf: "PBKDF2-SHA-256";
  salt: string;
  verifier: {
    ciphertext: string;
    iv: string;
  };
  version: 1;
}

export class LocalDataLockedError extends Error {
  readonly code = "local_data_locked";

  constructor() {
    super("本地数据已加密，请先输入解锁密码");
    this.name = "LocalDataLockedError";
  }
}

export class LocalDataPassphraseError extends Error {
  readonly code = "local_data_passphrase_invalid";

  constructor() {
    super("解锁密码错误");
    this.name = "LocalDataPassphraseError";
  }
}

let databasePromise: Promise<IDBDatabase> | undefined;
let unlockedKey: CryptoKey | undefined;

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("数据库请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("数据库事务已取消"));
    transaction.onerror = () => reject(transaction.error ?? new Error("数据库事务失败"));
  });
}

function openDatabase() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地安全数据库"));
    request.onblocked = () => reject(new Error("本地安全数据库升级被阻止"));
  });
  return databasePromise;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前运行环境不支持 WebCrypto，无法启用本地数据加密");
  }
  return globalThis.crypto;
}

export async function deriveLocalDataKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = LOCAL_ENCRYPTION_KDF_ITERATIONS,
) {
  const material = await requireCrypto().subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return requireCrypto().subtle.deriveKey(
    { hash: "SHA-256", iterations, name: "PBKDF2", salt },
    material,
    { length: 256, name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  requireCrypto().getRandomValues(bytes);
  return bytes;
}

async function encryptText(key: CryptoKey, text: string) {
  const iv = randomBytes(12);
  const ciphertext = await requireCrypto().subtle.encrypt(
    { additionalData: ADDITIONAL_DATA, iv, name: "AES-GCM" },
    key,
    new TextEncoder().encode(text),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

async function decryptText(key: CryptoKey, iv: string, ciphertext: string) {
  const plaintext = await requireCrypto().subtle.decrypt(
    { additionalData: ADDITIONAL_DATA, iv: base64ToBytes(iv), name: "AES-GCM" },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function createLocalDataVerifier(key: CryptoKey) {
  return encryptText(key, KEY_CHECK_PLAINTEXT);
}

export async function verifyLocalDataKey(
  key: CryptoKey,
  verifier: LocalEncryptionMetadata["verifier"],
) {
  try {
    return (await decryptText(key, verifier.iv, verifier.ciphertext)) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export async function encryptLocalJsonWithKey(key: CryptoKey, value: unknown) {
  return encryptText(key, JSON.stringify(value));
}

export async function decryptLocalJsonWithKey<T>(key: CryptoKey, iv: string, ciphertext: string) {
  return JSON.parse(await decryptText(key, iv, ciphertext)) as T;
}

export function isEncryptedLocalRecord(value: unknown): value is EncryptedLocalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === ENCRYPTED_LOCAL_RECORD_FORMAT &&
    record.version === 1 &&
    typeof record.iv === "string" &&
    typeof record.ciphertext === "string"
  );
}

async function readMetadataRecord() {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readonly");
  const completed = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore(METADATA_STORE).get(METADATA_ID));
  await completed;
  return (value as LocalEncryptionMetadata | undefined) ?? null;
}

async function writeMetadataRecord(metadata: LocalEncryptionMetadata | null) {
  const database = await openDatabase();
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(METADATA_STORE);
  if (metadata) store.put(metadata);
  else store.delete(METADATA_ID);
  await completed;
}

export async function loadLocalEncryptionMetadata() {
  return readMetadataRecord();
}

export async function isLocalDataEncryptionEnabled() {
  return Boolean(await loadLocalEncryptionMetadata());
}

export function isLocalDataUnlocked() {
  return Boolean(unlockedKey);
}

export async function assertLocalDataAccessible() {
  if ((await isLocalDataEncryptionEnabled()) && !unlockedKey) {
    throw new LocalDataLockedError();
  }
}

export function assertLocalPassphrase(passphrase: string) {
  if (passphrase.length < LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`解锁密码至少需要 ${LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH} 个字符`);
  }
}

export async function enableLocalDataEncryption(passphrase: string) {
  assertLocalPassphrase(passphrase);
  if (await isLocalDataEncryptionEnabled()) {
    throw new Error("本地数据加密已经启用");
  }
  const salt = randomBytes(16);
  const key = await deriveLocalDataKey(passphrase, salt);
  const verifier = await createLocalDataVerifier(key);
  const metadata: LocalEncryptionMetadata = {
    algorithm: "AES-GCM",
    createdAt: new Date().toISOString(),
    id: METADATA_ID,
    iterations: LOCAL_ENCRYPTION_KDF_ITERATIONS,
    kdf: "PBKDF2-SHA-256",
    salt: bytesToBase64(salt),
    verifier,
    version: 1,
  };
  await writeMetadataRecord(metadata);
  unlockedKey = key;
}

export async function unlockLocalData(passphrase: string) {
  const metadata = await loadLocalEncryptionMetadata();
  if (!metadata) throw new Error("本地数据尚未启用加密");
  const key = await deriveLocalDataKey(
    passphrase,
    base64ToBytes(metadata.salt),
    metadata.iterations,
  );
  if (!(await verifyLocalDataKey(key, metadata.verifier))) {
    throw new LocalDataPassphraseError();
  }
  unlockedKey = key;
}

export function lockLocalData() {
  unlockedKey = undefined;
}

export async function disableLocalDataEncryption() {
  await writeMetadataRecord(null);
  unlockedKey = undefined;
}

function requireUnlockedKey() {
  if (!unlockedKey) throw new LocalDataLockedError();
  return unlockedKey;
}

export async function encryptLocalValue(value: unknown): Promise<EncryptedLocalRecord> {
  const { ciphertext, iv } = await encryptLocalJsonWithKey(requireUnlockedKey(), value);
  return { ciphertext, format: ENCRYPTED_LOCAL_RECORD_FORMAT, iv, version: 1 };
}

export async function decryptLocalValue<T>(record: EncryptedLocalRecord) {
  return decryptLocalJsonWithKey<T>(requireUnlockedKey(), record.iv, record.ciphertext);
}
