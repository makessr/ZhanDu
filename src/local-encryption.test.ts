import { describe, expect, test } from "bun:test";
import {
  ENCRYPTED_LOCAL_RECORD_FORMAT,
  LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH,
  assertLocalPassphrase,
  base64ToBytes,
  bytesToBase64,
  createLocalDataVerifier,
  decryptLocalJsonWithKey,
  deriveLocalDataKey,
  encryptLocalJsonWithKey,
  isEncryptedLocalRecord,
  verifyLocalDataKey,
} from "./local-encryption";

const TEST_ITERATIONS = 1_000;

async function testKey(passphrase = "correct horse battery") {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return deriveLocalDataKey(passphrase, salt, TEST_ITERATIONS);
}

describe("local encryption encoding", () => {
  test("base64 round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("local encryption key derivation", () => {
  test("verifies the passphrase that created the verifier", async () => {
    const key = await testKey();
    const verifier = await createLocalDataVerifier(key);
    expect(await verifyLocalDataKey(key, verifier)).toBe(true);
  });

  test("rejects a different passphrase without throwing", async () => {
    const verifier = await createLocalDataVerifier(await testKey());
    const other = await testKey("correct horse battery staple");
    expect(await verifyLocalDataKey(other, verifier)).toBe(false);
  });

  test("rejects a corrupted verifier", async () => {
    const key = await testKey();
    const verifier = await createLocalDataVerifier(key);
    const tampered = base64ToBytes(verifier.ciphertext);
    tampered[0] ^= 0xff;
    expect(
      await verifyLocalDataKey(key, {
        ...verifier,
        ciphertext: bytesToBase64(tampered),
      }),
    ).toBe(false);
  });
});

describe("local encryption records", () => {
  test("round-trips JSON with a fresh IV per write", async () => {
    const key = await testKey();
    const value = { hosts: [{ id: "host-1", name: "生产服务器" }], enabled: true };
    const first = await encryptLocalJsonWithKey(key, value);
    const second = await encryptLocalJsonWithKey(key, value);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptLocalJsonWithKey<typeof value>(key, first.iv, first.ciphertext)).toEqual(
      value,
    );
  });

  test("fails to decrypt with the wrong key", async () => {
    const encrypted = await encryptLocalJsonWithKey(await testKey(), { secret: "value" });
    const other = await testKey("another sufficiently long passphrase");
    await expect(
      decryptLocalJsonWithKey(other, encrypted.iv, encrypted.ciphertext),
    ).rejects.toThrow();
  });

  test("fails to decrypt tampered ciphertext", async () => {
    const key = await testKey();
    const encrypted = await encryptLocalJsonWithKey(key, { secret: "value" });
    const bytes = base64ToBytes(encrypted.ciphertext);
    bytes[bytes.length - 1] ^= 0xff;
    await expect(
      decryptLocalJsonWithKey(key, encrypted.iv, bytesToBase64(bytes)),
    ).rejects.toThrow();
  });
});

describe("encrypted record detection", () => {
  test("recognizes the current envelope format", () => {
    expect(
      isEncryptedLocalRecord({
        ciphertext: "ciphertext",
        format: ENCRYPTED_LOCAL_RECORD_FORMAT,
        id: "primary",
        iv: "iv",
        version: 1,
      }),
    ).toBe(true);
  });

  test("rejects plaintext configuration and incomplete envelopes", () => {
    expect(isEncryptedLocalRecord({ id: "primary", hosts: [] })).toBe(false);
    expect(
      isEncryptedLocalRecord({
        ciphertext: "ciphertext",
        format: ENCRYPTED_LOCAL_RECORD_FORMAT,
        iv: "iv",
        version: 2,
      }),
    ).toBe(false);
    expect(isEncryptedLocalRecord(null)).toBe(false);
  });
});

describe("passphrase policy", () => {
  test("enforces the minimum length", () => {
    expect(() =>
      assertLocalPassphrase("a".repeat(LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH - 1)),
    ).toThrow();
    expect(() =>
      assertLocalPassphrase("a".repeat(LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH)),
    ).not.toThrow();
  });
});
