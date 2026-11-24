import "fake-indexeddb/auto";
import { afterAll, expect, test } from "bun:test";
import { loadAiConversations, saveAiConversation } from "./ai-conversations";
import { loadConfiguration, updateConfiguration } from "./config-database";
import {
  LocalDataLockedError,
  LocalDataPassphraseError,
  isLocalDataUnlocked,
  lockLocalData,
  unlockLocalData,
} from "./local-encryption";
import {
  disableLocalDataProtection,
  enableLocalDataProtection,
  localDataProtectionStatus,
  retryLocalDataEncryption,
} from "./local-data-protection";

const PASSPHRASE = "correct horse battery";
const SECRET_GROUP = "秘密分组";
const SECRET_MESSAGE = "机密对话内容";

async function readStore(databaseName: string, storeName: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    return await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function seedPlaintextData() {
  await updateConfiguration((current) => ({
    ...current,
    quickCommandGroups: [SECRET_GROUP],
  }));
  await saveAiConversation({
    id: "conversation-1",
    hostId: "host-1",
    hostName: "生产服务器",
    title: "检查磁盘",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:05:00.000Z",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: SECRET_MESSAGE,
      },
    ],
  });
}

afterAll(async () => {
  lockLocalData();
  const status = await localDataProtectionStatus();
  if (status.enabled) await disableLocalDataProtection();
});

test("encrypts configuration and AI history, requires unlock, and restores plaintext when disabled", async () => {
  await seedPlaintextData();
  expect((await localDataProtectionStatus()).enabled).toBe(false);

  await enableLocalDataProtection(PASSPHRASE);
  expect(await localDataProtectionStatus()).toEqual({ enabled: true, unlocked: true });

  const configRecords = await readStore("fineshell.config", "configuration");
  expect(configRecords).toHaveLength(1);
  const encryptedConfig = JSON.stringify(configRecords[0]);
  expect(configRecords[0]).toMatchObject({ format: "zhandu-local-encrypted", version: 1 });
  expect(encryptedConfig).not.toContain(SECRET_GROUP);
  expect(encryptedConfig).not.toContain("quickCommandGroups");

  const aiRecords = await readStore("fineshell.ai", "conversations");
  expect(aiRecords).toHaveLength(1);
  const encryptedAi = JSON.stringify(aiRecords[0]);
  expect(aiRecords[0]).toMatchObject({ id: "conversation-1", format: "zhandu-local-encrypted" });
  expect(encryptedAi).not.toContain(SECRET_MESSAGE);
  expect(encryptedAi).not.toContain("hostId");

  expect((await loadConfiguration()).quickCommandGroups).toEqual([SECRET_GROUP]);
  const conversations = await loadAiConversations("host-1");
  expect(conversations).toHaveLength(1);
  expect(conversations[0].messages[0].content).toBe(SECRET_MESSAGE);

  await retryLocalDataEncryption();
  expect((await loadConfiguration()).quickCommandGroups).toEqual([SECRET_GROUP]);

  lockLocalData();
  expect(isLocalDataUnlocked()).toBe(false);
  await expect(loadConfiguration()).rejects.toBeInstanceOf(LocalDataLockedError);
  await expect(loadAiConversations("host-1")).rejects.toBeInstanceOf(LocalDataLockedError);
  await expect(unlockLocalData("wrong horse battery")).rejects.toBeInstanceOf(
    LocalDataPassphraseError,
  );
  expect(isLocalDataUnlocked()).toBe(false);

  await unlockLocalData(PASSPHRASE);
  expect(isLocalDataUnlocked()).toBe(true);
  expect((await loadConfiguration()).quickCommandGroups).toEqual([SECRET_GROUP]);

  await disableLocalDataProtection();
  expect(await localDataProtectionStatus()).toEqual({ enabled: false, unlocked: false });
  const plainConfig = await readStore("fineshell.config", "configuration");
  expect(JSON.stringify(plainConfig)).toContain(SECRET_GROUP);
  const plainAi = await readStore("fineshell.ai", "conversations");
  expect(JSON.stringify(plainAi)).toContain(SECRET_MESSAGE);
  expect((await loadConfiguration()).quickCommandGroups).toEqual([SECRET_GROUP]);
}, 120_000);
