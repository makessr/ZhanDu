import { rewriteStoredAiConversations } from "./ai-conversations";
import { rewriteStoredConfiguration } from "./config-database";
import {
  disableLocalDataEncryption,
  enableLocalDataEncryption,
  isLocalDataEncryptionEnabled,
  isLocalDataUnlocked,
} from "./local-encryption";
import { emitProtocolEventTo } from "./tauri-protocol";

async function notifyLocalEncryptionChanged() {
  try {
    await emitProtocolEventTo("main", "local-encryption:changed");
  } catch {
    // The main window is absent in browser-only development.
  }
}

export interface LocalDataProtectionStatus {
  enabled: boolean;
  unlocked: boolean;
}

export async function localDataProtectionStatus(): Promise<LocalDataProtectionStatus> {
  return {
    enabled: await isLocalDataEncryptionEnabled(),
    unlocked: isLocalDataUnlocked(),
  };
}

export async function enableLocalDataProtection(passphrase: string) {
  await enableLocalDataEncryption(passphrase);
  try {
    await rewriteStoredConfiguration();
    await rewriteStoredAiConversations();
  } finally {
    await notifyLocalEncryptionChanged();
  }
}

export async function retryLocalDataEncryption() {
  await rewriteStoredConfiguration();
  await rewriteStoredAiConversations();
}

export async function disableLocalDataProtection() {
  await rewriteStoredConfiguration({ plaintext: true });
  await rewriteStoredAiConversations({ plaintext: true });
  await disableLocalDataEncryption();
  await notifyLocalEncryptionChanged();
}
