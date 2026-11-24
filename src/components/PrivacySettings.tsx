import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconDelete, IconRefresh } from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import type { AppSettings } from "../app-settings";
import { diagnosticInvoke as invoke } from "../diagnostics";
import { loadConfiguration } from "../config-database";
import {
  clearConnectionHistory,
  clearTerminalCommandHistory,
  removeCredentialReference,
  replaceCredentialReferences,
} from "../configuration-mutations";
import {
  buildCredentialCandidates,
  credentialKindLabel,
  orphanedCredentialReferences,
  reconcileCredentialReferences,
  type CredentialProbeResult,
  type CredentialReferenceRecord,
} from "../credential-registry";
import { emitProtocolEventTo } from "../tauri-protocol";
import { LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH } from "../local-encryption";
import {
  disableLocalDataProtection,
  enableLocalDataProtection,
  localDataProtectionStatus,
  retryLocalDataEncryption,
} from "../local-data-protection";

interface PrivacySettingsProps {
  savedSettings: AppSettings;
  settings: AppSettings;
  updateSetting: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function deleteNativeCredential(reference: CredentialReferenceRecord) {
  if (!isTauri()) return;
  switch (reference.kind) {
    case "hostPassword":
      await invoke("delete_host_password", { hostId: reference.ownerId });
      return;
    case "privateKeyPassphrase":
      await invoke("delete_private_key_passphrase", {
        hostId: reference.ownerId,
      });
      return;
    case "proxyPassword":
      await invoke("delete_proxy_password", { proxyId: reference.ownerId });
  }
}

function PrivacySettings({ savedSettings, settings, updateSetting }: PrivacySettingsProps) {
  const [historyCount, setHistoryCount] = useState(0);
  const [terminalHistoryCount, setTerminalHistoryCount] = useState(0);
  const [orphaned, setOrphaned] = useState<CredentialReferenceRecord[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [encryptionKnown, setEncryptionKnown] = useState(false);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptionUnlocked, setEncryptionUnlocked] = useState(false);
  const [encryptionBusy, setEncryptionBusy] = useState(false);
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirmation, setPassphraseConfirmation] = useState("");
  const [passphraseError, setPassphraseError] = useState<string>();

  const refreshEncryptionStatus = useCallback(async () => {
    try {
      const status = await localDataProtectionStatus();
      setEncryptionEnabled(status.enabled);
      setEncryptionUnlocked(status.unlocked);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setEncryptionKnown(true);
    }
  }, []);

  useEffect(() => {
    void refreshEncryptionStatus();
  }, [refreshEncryptionStatus]);

  const scanCredentials = useCallback(async () => {
    const configuration = await loadConfiguration();
    setHistoryCount(configuration.history.length);
    setTerminalHistoryCount(configuration.terminalCommandHistory.length);
    if (!isTauri()) {
      setOrphaned([]);
      return;
    }

    setScanning(true);
    try {
      const candidates = buildCredentialCandidates(configuration);
      const probes = [
        ...new Map(
          [...configuration.credentialReferences, ...candidates].map((item) => [
            item.id,
            { kind: item.kind, ownerId: item.ownerId },
          ]),
        ).values(),
      ];
      const results = await invoke<CredentialProbeResult[]>("inspect_credentials", { probes });
      const reconciled = reconcileCredentialReferences(
        configuration.credentialReferences,
        candidates,
        results,
      );
      await replaceCredentialReferences(reconciled);
      setOrphaned(orphanedCredentialReferences(reconciled, candidates));
      setHasScanned(true);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void loadConfiguration()
      .then((configuration) => {
        setHistoryCount(configuration.history.length);
        setTerminalHistoryCount(configuration.terminalCommandHistory.length);
      })
      .catch((error) => Message.error(String(error)));
  }, [savedSettings.connectionHistoryLimit, savedSettings.connectionHistoryRetentionDays]);

  const clearHistory = async () => {
    try {
      await clearConnectionHistory();
      setHistoryCount(0);
      if (isTauri()) {
        await emitProtocolEventTo("main", "configuration:changed").catch(() => undefined);
      }
      Message.success("连接历史已清空");
      setHasScanned(false);
      setOrphaned([]);
    } catch (error) {
      Message.error(String(error));
      throw error;
    }
  };

  const clearTerminalHistory = async () => {
    try {
      await clearTerminalCommandHistory();
      setTerminalHistoryCount(0);
      if (isTauri()) {
        await emitProtocolEventTo("main", "configuration:changed").catch(() => undefined);
      }
      Message.success("终端命令历史已清空");
    } catch (error) {
      Message.error(String(error));
      throw error;
    }
  };

  const cleanCredential = async (reference: CredentialReferenceRecord) => {
    setCleaning(true);
    try {
      await deleteNativeCredential(reference);
      await removeCredentialReference(reference.kind, reference.ownerId);
      setOrphaned((current) => current.filter((item) => item.id !== reference.id));
      Message.success("遗留凭据已清理");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setCleaning(false);
    }
  };

  const cleanAllCredentials = async () => {
    setCleaning(true);
    try {
      for (const reference of orphaned) {
        await deleteNativeCredential(reference);
        await removeCredentialReference(reference.kind, reference.ownerId);
        setOrphaned((current) => current.filter((item) => item.id !== reference.id));
      }
      Message.success("遗留凭据已全部清理");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      setCleaning(false);
    }
  };

  const enableEncryption = async () => {
    setPassphraseError(undefined);
    if (passphrase.length < LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH) {
      setPassphraseError(`解锁密码至少需要 ${LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH} 个字符。`);
      return;
    }
    if (passphrase !== passphraseConfirmation) {
      setPassphraseError("两次输入的解锁密码不一致。");
      return;
    }
    setEncryptionBusy(true);
    try {
      await enableLocalDataProtection(passphrase);
      setEnableDialogOpen(false);
      setPassphrase("");
      setPassphraseConfirmation("");
      Message.success("本地数据已加密");
    } catch (error) {
      const status = await localDataProtectionStatus().catch(() => undefined);
      if (status?.enabled) {
        setEnableDialogOpen(false);
        setPassphrase("");
        setPassphraseConfirmation("");
        Message.warning("加密已启用，但部分数据未能完成转换，请点击“重新加密现有数据”。");
      } else {
        setPassphraseError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      await refreshEncryptionStatus();
      setEncryptionBusy(false);
    }
  };

  const disableEncryption = async () => {
    setEncryptionBusy(true);
    try {
      await disableLocalDataProtection();
      Message.success("本地数据加密已关闭");
    } catch (error) {
      Message.error(String(error));
      throw error;
    } finally {
      await refreshEncryptionStatus();
      setEncryptionBusy(false);
    }
  };

  const reencryptExistingData = async () => {
    setEncryptionBusy(true);
    try {
      await retryLocalDataEncryption();
      Message.success("现有数据已重新加密");
    } catch (error) {
      Message.error(String(error));
    } finally {
      await refreshEncryptionStatus();
      setEncryptionBusy(false);
    }
  };

  const columns = useMemo<TableColumnProps<CredentialReferenceRecord>[]>(
    () => [
      { title: "来源", dataIndex: "label" },
      {
        title: "类型",
        width: 120,
        render: (_, reference) => credentialKindLabel(reference.kind),
      },
      {
        title: "最近检查",
        width: 140,
        render: (_, reference) => formatTime(reference.updatedAt),
      },
      {
        title: "操作",
        width: 72,
        render: (_, reference) => (
          <Popconfirm
            content={`确定从系统凭据库中删除“${reference.label}”的${credentialKindLabel(reference.kind)}？`}
            onOk={() => cleanCredential(reference)}
          >
            <Button
              aria-label={`清理 ${reference.label}`}
              disabled={cleaning}
              icon={<IconDelete />}
              size="mini"
              status="danger"
            />
          </Popconfirm>
        ),
      },
    ],
    [cleaning],
  );

  return (
    <div className="privacy-settings">
      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>连接历史</Typography.Title>
            <Typography.Text type="secondary">当前保存 {historyCount} 条记录</Typography.Text>
          </div>
          <Popconfirm
            content="确定清空全部连接历史？此操作不会删除主机配置。"
            disabled={historyCount === 0}
            onOk={clearHistory}
          >
            <Button disabled={historyCount === 0} status="danger">
              清空历史
            </Button>
          </Popconfirm>
        </div>
        <div className="settings-group privacy-history-settings">
          <div className="settings-row">
            <Typography.Text>最多保留</Typography.Text>
            <div className="settings-control">
              <Select
                aria-label="连接历史数量"
                onChange={(value) =>
                  updateSetting(
                    "connectionHistoryLimit",
                    value as AppSettings["connectionHistoryLimit"],
                  )
                }
                options={[
                  { label: "20 条", value: 20 },
                  { label: "50 条", value: 50 },
                  { label: "100 条", value: 100 },
                  { label: "不限数量", value: 0 },
                ]}
                value={settings.connectionHistoryLimit}
              />
            </div>
          </div>
          <div className="settings-row">
            <Typography.Text>保留时间</Typography.Text>
            <div className="settings-control">
              <Select
                aria-label="连接历史保留时间"
                onChange={(value) =>
                  updateSetting(
                    "connectionHistoryRetentionDays",
                    value as AppSettings["connectionHistoryRetentionDays"],
                  )
                }
                options={[
                  { label: "7 天", value: 7 },
                  { label: "30 天", value: 30 },
                  { label: "90 天", value: 90 },
                  { label: "永久保留", value: 0 },
                ]}
                value={settings.connectionHistoryRetentionDays}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>终端命令历史</Typography.Title>
            <Typography.Text type="secondary">
              当前保存 {terminalHistoryCount} 条，仅保存在本机且不会随配置导出
            </Typography.Text>
          </div>
          <Popconfirm
            content="确定清空全部终端命令历史？清空后将无法继续使用历史自动补全。"
            disabled={terminalHistoryCount === 0}
            onOk={clearTerminalHistory}
          >
            <Button disabled={terminalHistoryCount === 0} status="danger">
              清空历史
            </Button>
          </Popconfirm>
        </div>
      </section>

      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>本地数据加密</Typography.Title>
            <Typography.Text type="secondary">
              {!encryptionKnown
                ? "正在读取状态…"
                : encryptionEnabled
                  ? `已启用（${encryptionUnlocked ? "已解锁" : "未解锁"}），使用 AES-256-GCM`
                  : "可选：用解锁密码加密主机配置和 AI 对话历史"}
            </Typography.Text>
          </div>
          {encryptionEnabled ? (
            <Space>
              <Button loading={encryptionBusy} onClick={() => void reencryptExistingData()}>
                重新加密现有数据
              </Button>
              <Popconfirm
                content="确定关闭本地数据加密？配置和 AI 对话历史会以明文重新写入本机。"
                onOk={disableEncryption}
              >
                <Button disabled={encryptionBusy} status="danger">
                  关闭加密
                </Button>
              </Popconfirm>
            </Space>
          ) : (
            <Button
              disabled={!encryptionKnown || encryptionBusy}
              type="primary"
              onClick={() => {
                setPassphraseError(undefined);
                setEnableDialogOpen(true);
              }}
            >
              启用加密
            </Button>
          )}
        </div>
        {encryptionEnabled ? (
          <Alert
            content="密钥由解锁密码经 PBKDF2-SHA-256（600,000 次迭代）派生，仅在当前进程内存中保留；关闭应用或切换窗口后需重新解锁。解锁密码不保存，忘记后无法恢复已加密数据。"
            type="info"
          />
        ) : (
          <Alert
            content={`启用后，主机与分组配置、代理、快捷命令、连接历史、应用设置和 AI 对话历史会以密文写入本机存储。解锁密码至少 ${LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH} 个字符，不会保存到凭据库。`}
            type="info"
          />
        )}
      </section>

      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>本地数据存储</Typography.Title>
            <Typography.Text type="secondary">
              以下数据保存在本机应用数据目录或浏览器存储中
            </Typography.Text>
          </div>
        </div>
        <Alert
          content={
            encryptionEnabled
              ? "加密已覆盖主机与分组配置、代理、快捷命令、连接历史、应用设置、AI 对话历史和任务恢复快照。终端日志（开启时）、手动导出的配置文件以及 WebView localStorage 中的界面状态仍为明文；连接密码、私钥口令和同步解锁密钥仍写入系统凭据库。"
              : "主机与分组配置、代理、快捷命令、连接历史、应用设置、AI 对话历史与任务恢复快照、终端日志（开启时）均为明文。只有连接密码、私钥口令和同步解锁密钥写入系统凭据库。可在上方启用应用层加密，或为设备启用 BitLocker、FileVault 或 LUKS。"
          }
          type="warning"
        />
      </section>

      <Modal
        cancelText="取消"
        okButtonProps={{ loading: encryptionBusy }}
        okText="启用加密"
        onCancel={() => {
          if (encryptionBusy) return;
          setEnableDialogOpen(false);
          setPassphrase("");
          setPassphraseConfirmation("");
          setPassphraseError(undefined);
        }}
        onOk={() => void enableEncryption()}
        title="启用本地数据加密"
        unmountOnExit
        visible={enableDialogOpen}
      >
        <Space direction="vertical" size="medium" style={{ width: "100%" }}>
          <Typography.Text>
            设置解锁密码后，应用会把配置和 AI 对话历史用 AES-256-GCM
            加密后再写入本机。密码不会保存，每次启动需要输入；忘记密码将无法恢复已加密数据。
          </Typography.Text>
          <Input.Password
            aria-label="本地数据加密密码"
            autoComplete="new-password"
            onChange={setPassphrase}
            placeholder={`解锁密码（至少 ${LOCAL_ENCRYPTION_MIN_PASSPHRASE_LENGTH} 个字符）`}
            value={passphrase}
          />
          <Input.Password
            aria-label="再次输入本地数据加密密码"
            autoComplete="new-password"
            onChange={setPassphraseConfirmation}
            placeholder="再次输入解锁密码"
            value={passphraseConfirmation}
          />
          {passphraseError && <Typography.Text type="error">{passphraseError}</Typography.Text>}
        </Space>
      </Modal>

      <section className="privacy-section">
        <div className="privacy-section-heading">
          <div>
            <Typography.Title heading={6}>系统凭据</Typography.Title>
            <Typography.Text type="secondary">
              检查不再被主机、密钥、代理或连接历史使用的凭据
            </Typography.Text>
          </div>
          <Space>
            <Button
              icon={<IconRefresh />}
              loading={scanning}
              onClick={() => void scanCredentials()}
            >
              重新扫描
            </Button>
            {orphaned.length > 0 && (
              <Popconfirm
                content={`确定清理检测到的 ${orphaned.length} 项遗留凭据？`}
                onOk={cleanAllCredentials}
              >
                <Button disabled={cleaning} status="danger">
                  全部清理
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        <Alert
          content="仅检查凭据是否存在及其关联关系，密码和密钥口令不会返回到界面或被显示。"
          type="info"
        />
        <Table
          className="credential-cleanup-table"
          columns={columns}
          data={orphaned}
          loading={scanning}
          noDataElement={
            <Empty
              description={hasScanned ? "未发现可清理的遗留凭据" : "点击重新扫描检查遗留凭据"}
            />
          }
          pagination={false}
          rowKey="id"
        />
      </section>
    </div>
  );
}

export default PrivacySettings;
