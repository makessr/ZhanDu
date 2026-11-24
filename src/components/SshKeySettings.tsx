import { randomIdSuffix } from "../random-id";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconDelete, IconEdit, IconFolder, IconPlus } from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { APP_DISPLAY_NAME } from "../application-brand";
import { confirmHostFingerprint } from "../app-window-actions";
import { diagnosticInvoke as invoke } from "../diagnostics";
import { loadConfiguration, updateConfiguration } from "../config-database";
import {
  deleteSshKey,
  removeCredentialReference,
  upsertCredentialReference,
  upsertSshKey,
} from "../configuration-mutations";
import { createCredentialReference } from "../credential-registry";
import type { HostRecord, SshKeyFormValues, SshKeyRecord, SshKeySource } from "../models";
import { getSshKeySource } from "../ssh-keys";
import { sshKeyInstallCommand } from "../ssh-key-install";
import { jumpHostRequest } from "../terminal-utils";
import { resolveWorkspaceConnection } from "../terminal-workspaces";
import { emitProtocolEventTo, listenProtocolEvent, type SshConnectResult } from "../tauri-protocol";

function keyChange(
  configuration: Awaited<ReturnType<typeof loadConfiguration>>,
  hostId: string,
  keyId: string,
) {
  const host = configuration.hosts.find(({ id }) => id === hostId);
  if (!host) throw new Error("所选主机已被删除");
  const oldReference =
    host.authMethod === "privateKey"
      ? host.sshKeyId
        ? configuration.sshKeys.find(({ id }) => id === host.sshKeyId)?.privateKeyPath
        : host.privateKeyPath
      : undefined;
  const replacement = {
    ...host,
    authMethod: "privateKey" as const,
    sshKeyId: keyId,
    privateKeyPath: undefined,
  };
  const [candidate, proxy, jump] = resolveWorkspaceConnection(replacement, configuration);
  const {
    address,
    port,
    username,
    authMethod,
    privateKeyPath,
    connectTimeoutSeconds,
    keepAliveIntervalSeconds,
  } = candidate;
  const request = {
    hostId: keyId,
    address,
    port,
    username,
    authMethod,
    privateKeyPath,
    connectTimeoutSeconds,
    keepAliveIntervalSeconds,
    expectedFingerprint: host.hostFingerprint,
    proxy,
    jumpHost: jumpHostRequest(jump),
  };
  const original = [host.authMethod, host.sshKeyId, oldReference];
  return {
    host,
    replacement,
    request,
    oldReference,
    snapshot: JSON.stringify([request, original]),
  };
}

interface SshPrivateKeyIdentity {
  publicKey: string;
  fingerprint: string;
}

function readKeyIdentity(reference: string) {
  return invoke<SshPrivateKeyIdentity>("ssh_private_key_identity", { reference }).catch(
    () => undefined,
  );
}

function createSshKeyId() {
  return `ssh-key-${Date.now()}-${randomIdSuffix()}`;
}

async function choosePrivateKeyPath() {
  if (!isTauri()) return undefined;
  const selected = await open({
    directory: false,
    multiple: false,
    title: "选择 SSH 私钥",
  });
  return typeof selected === "string" ? selected : undefined;
}

async function storePassphrase(sshKeyId: string, passphrase: string) {
  if (!isTauri()) return;
  await invoke("store_private_key_passphrase", {
    hostId: sshKeyId,
    passphrase,
  });
}

async function removePassphrase(sshKeyId: string) {
  if (isTauri()) {
    await invoke("delete_private_key_passphrase", { hostId: sshKeyId });
  }
  await removeCredentialReference("privateKeyPassphrase", sshKeyId);
}

interface ManagedSshKeyImportResult {
  reference: string;
  keyType: string;
}

interface GeneratedSshKey {
  reference: string;
  publicKey: string;
}

async function importManagedSshKey(sshKeyId: string, privateKey: string) {
  if (!isTauri()) {
    throw new Error("粘贴私钥仅在桌面应用中可用");
  }
  return invoke<ManagedSshKeyImportResult>("managed_ssh_key_import", {
    keyId: sshKeyId,
    privateKey,
  });
}

async function deleteManagedSshKey(sshKeyId: string) {
  if (!isTauri()) return;
  await invoke("managed_ssh_key_delete", { keyId: sshKeyId });
}

interface SshKeyEditorModalProps {
  sshKey: SshKeyRecord | null;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: SshKeyFormValues) => void;
}

function SshKeyEditorModal({ sshKey, visible, onCancel, onSubmit }: SshKeyEditorModalProps) {
  const [form] = Form.useForm<SshKeyFormValues>();
  const initialSource = sshKey ? getSshKeySource(sshKey) : "file";
  const [source, setSource] = useState<SshKeySource>(initialSource);

  return (
    <Modal
      className="ssh-key-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 620 }}
      title={sshKey ? "编辑密钥" : "新增密钥"}
      visible={visible}
    >
      <Form<SshKeyFormValues>
        form={form}
        initialValues={{
          name: sshKey?.name ?? "",
          source: initialSource,
          privateKeyPath: sshKey?.privateKeyPath ?? "",
          privateKeyContent: "",
          passphrase: "",
        }}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <Form.Item
          field="name"
          label="名称"
          rules={[{ required: true, message: "请输入密钥名称" }]}
        >
          <Input autoFocus placeholder="例如：生产环境 Ed25519" />
        </Form.Item>
        <Form.Item field="source" label="添加方式">
          <Radio.Group
            disabled={Boolean(sshKey)}
            onChange={(value) => setSource(value as SshKeySource)}
            options={[
              { label: "选择文件", value: "file" },
              { label: "粘贴私钥", value: "managed" },
            ]}
            type="button"
          />
        </Form.Item>
        {source === "file" ? (
          <Form.Item
            field="privateKeyPath"
            label="私钥文件"
            rules={[{ required: true, message: "请选择私钥文件" }]}
          >
            <Input.Search
              onSearch={() =>
                void choosePrivateKeyPath().then((path) => {
                  if (path) form.setFieldValue("privateKeyPath", path);
                })
              }
              placeholder="选择或输入私钥文件路径"
              searchButton={
                <Tooltip content="选择私钥文件">
                  <IconFolder />
                </Tooltip>
              }
            />
          </Form.Item>
        ) : sshKey ? (
          <Form.Item label="私钥">
            <Input disabled value={`${APP_DISPLAY_NAME}托管密钥`} />
          </Form.Item>
        ) : (
          <Form.Item
            className="ssh-key-managed-content"
            field="privateKeyContent"
            label="私钥内容"
            rules={[{ required: true, message: "请粘贴完整的私钥内容" }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 7, maxRows: 11 }}
              placeholder={
                "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
              }
              spellCheck={false}
            />
          </Form.Item>
        )}
        <Form.Item field="passphrase" label="私钥口令">
          <Input.Password placeholder={sshKey ? "留空则保留原口令" : "没有口令可留空"} />
        </Form.Item>
        <div className="modal-actions">
          <Space>
            {sshKey && (
              <Popconfirm
                content="确定清除该密钥已保存的口令？"
                onOk={() =>
                  void removePassphrase(sshKey.id)
                    .then(() => Message.success("私钥口令已清除"))
                    .catch((error) => Message.error(String(error)))
                }
              >
                <Button>清除口令</Button>
              </Popconfirm>
            )}
            <Button onClick={onCancel}>取消</Button>
            <Button htmlType="submit" type="primary">
              保存
            </Button>
          </Space>
        </div>
      </Form>
    </Modal>
  );
}

function SshKeySettings() {
  const [sshKeys, setSshKeys] = useState<SshKeyRecord[]>([]);
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [usage, setUsage] = useState(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingSshKey, setEditingSshKey] = useState<SshKeyRecord | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [installKey, setInstallKey] = useState<{
    id: string;
    name: string;
    publicKey: string;
  } | null>(null);
  const [installHostId, setInstallHostId] = useState<string>();

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setSshKeys(configuration.sshKeys);
    setHosts(configuration.hosts);
    const nextUsage = new Map<string, number>();
    for (const host of configuration.hosts) {
      if (host.sshKeyId) {
        nextUsage.set(host.sshKeyId, (nextUsage.get(host.sshKeyId) ?? 0) + 1);
      }
    }
    for (const deletedHost of configuration.trash) {
      const sshKeyId = deletedHost.host.sshKeyId;
      if (sshKeyId) {
        nextUsage.set(sshKeyId, (nextUsage.get(sshKeyId) ?? 0) + 1);
      }
    }
    setUsage(nextUsage);
  }, []);

  useEffect(() => {
    let disposed = false;
    void refresh()
      .catch((error) => {
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void refresh().catch((error) => Message.error(String(error)));
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const notifyMainWindow = async () => {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(() => undefined);
  };

  const showKeyInstall = useCallback(async (key: SshKeyRecord) => {
    setActing(true);
    try {
      const publicKey = await invoke<string>("managed_ssh_key_public", {
        reference: key.privateKeyPath,
      });
      setInstallHostId(undefined);
      setInstallKey({ id: key.id, name: key.name, publicKey });
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  }, []);

  const generateSshKey = async ({ name }: { name: string }) => {
    const keyName = name.trim();
    if (!keyName || acting) return;
    const id = createSshKeyId();
    setActing(true);
    try {
      const result = await invoke<GeneratedSshKey>("managed_ssh_key_generate", { keyId: id });
      let configuration: Awaited<ReturnType<typeof upsertSshKey>>;
      try {
        configuration = await upsertSshKey({
          id,
          name: keyName,
          privateKeyPath: result.reference,
          source: "managed",
        });
      } catch (error) {
        await deleteManagedSshKey(id).catch(() => undefined);
        throw error;
      }
      setSshKeys(configuration.sshKeys);
      setHosts(configuration.hosts);
      setGeneratorOpen(false);
      setInstallHostId(undefined);
      setInstallKey({ id, name: keyName, publicKey: result.publicKey });
      await notifyMainWindow();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const applyToHost = async () => {
    if (!installKey || !installHostId || acting) return;
    const keyId = installKey.id;
    const hostId = installHostId;
    setActing(true);
    try {
      const change = keyChange(await loadConfiguration(), hostId, keyId);
      const verify = (expectedFingerprint = change.request.expectedFingerprint) =>
        invoke<SshConnectResult>("ssh_verify_private_key", {
          request: { ...change.request, expectedFingerprint },
        });
      let result = await verify();
      if (result.status === "hostKeyVerificationRequired") {
        if (!(await confirmHostFingerprint(change.host, result))) return;
        result = await verify(result.fingerprint);
        if (result.status !== "connected") throw new Error("验证期间主机指纹已变化，请重试");
      }
      const replacingKey = change.host.authMethod !== "password" && change.host.sshKeyId !== keyId;
      const [oldKey, newKey] = replacingKey
        ? await Promise.all([
            change.oldReference ? readKeyIdentity(change.oldReference) : undefined,
            change.request.privateKeyPath
              ? readKeyIdentity(change.request.privateKeyPath)
              : undefined,
          ])
        : [];
      await updateConfiguration((current) => {
        const latest = keyChange(current, hostId, keyId);
        if (latest.snapshot !== change.snapshot) {
          throw new Error("验证期间连接配置已变化，请重试");
        }
        return {
          ...current,
          hosts: current.hosts.map((host) =>
            host.id === hostId
              ? { ...latest.replacement, hostFingerprint: result.fingerprint }
              : host,
          ),
        };
      });
      setInstallKey(null);
      await notifyMainWindow();
      await refresh();
      if (!replacingKey) {
        Message.success("新密钥已验证，主机已切换为密钥登录");
        return;
      }
      if (oldKey && newKey && oldKey.fingerprint === newKey.fingerprint) {
        Message.success("新密钥已验证，与原配置使用同一把公钥");
        return;
      }
      Modal.info({
        title: "新密钥已验证并启用",
        content:
          oldKey && newKey ? (
            <Space direction="vertical">
              <Typography.Text>
                确认没有其他设备需要旧公钥后，在服务器的 authorized_keys
                中按下方指纹核对条目，再手动移除。
              </Typography.Text>
              <Typography.Text copyable>{oldKey.fingerprint}</Typography.Text>
              <Button
                onClick={() =>
                  void writeText(oldKey.publicKey)
                    .then(() => Message.success("旧公钥已复制"))
                    .catch((error) => Message.error(String(error)))
                }
              >
                复制旧公钥
              </Button>
            </Space>
          ) : (
            "当前无法识别旧公钥。请先在服务器核对旧条目的指纹，再手动撤销。"
          ),
      });
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const saveSshKey = async (values: SshKeyFormValues) => {
    const sshKeyId = editingSshKey?.id ?? createSshKeyId();
    setActing(true);
    let passphraseStored = false;
    let managedKeyImported = false;
    try {
      const existingSource = editingSshKey ? getSshKeySource(editingSshKey) : values.source;
      let privateKeyPath = values.privateKeyPath?.trim() ?? "";
      if (!editingSshKey && existingSource === "managed") {
        const result = await importManagedSshKey(sshKeyId, values.privateKeyContent?.trim() ?? "");
        privateKeyPath = result.reference;
        managedKeyImported = true;
      } else if (editingSshKey && existingSource === "managed") {
        privateKeyPath = editingSshKey.privateKeyPath;
      }

      const sshKey: SshKeyRecord = {
        id: sshKeyId,
        name: values.name.trim(),
        privateKeyPath,
        ...(existingSource === "managed" ? { source: "managed" as const } : {}),
      };
      if (values.passphrase) {
        await storePassphrase(sshKeyId, values.passphrase);
        passphraseStored = true;
      }
      const configuration = await upsertSshKey(sshKey);
      setSshKeys(configuration.sshKeys);
      if (values.passphrase) {
        await upsertCredentialReference(
          createCredentialReference("privateKeyPassphrase", sshKeyId, `密钥：${sshKey.name}`),
        ).catch(() => {
          Message.warning("密钥已保存，但凭据索引更新失败，可重新扫描");
        });
      }
      await notifyMainWindow().catch(() => undefined);
      setEditorVisible(false);
      setEditingSshKey(null);
      Message.success(editingSshKey ? "密钥已更新" : "密钥已添加");
    } catch (error) {
      if (!editingSshKey && passphraseStored) {
        await removePassphrase(sshKeyId).catch(() => undefined);
      }
      if (managedKeyImported) {
        await deleteManagedSshKey(sshKeyId).catch(() => undefined);
      }
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeSshKey = async (sshKey: SshKeyRecord) => {
    setActing(true);
    try {
      const configuration = await deleteSshKey(sshKey.id);
      setSshKeys(configuration.sshKeys);
      await notifyMainWindow().catch(() => undefined);
      const cleanupFailures: string[] = [];
      await removePassphrase(sshKey.id).catch(() => {
        cleanupFailures.push("系统凭据");
      });
      if (getSshKeySource(sshKey) === "managed") {
        await deleteManagedSshKey(sshKey.id).catch(() => {
          cleanupFailures.push("托管私钥文件");
        });
      }
      if (cleanupFailures.length === 0) {
        Message.success(`已删除 ${sshKey.name}`);
      } else {
        Message.warning(`密钥记录已删除，但${cleanupFailures.join("和")}清理失败`);
      }
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = useMemo<TableColumnProps<SshKeyRecord>[]>(
    () => [
      {
        title: "密钥",
        dataIndex: "name",
        render: (_, sshKey) => (
          <div className="ssh-key-name-cell">
            <Typography.Text bold>{sshKey.name}</Typography.Text>
            <Typography.Text type="secondary">
              {getSshKeySource(sshKey) === "managed"
                ? `${APP_DISPLAY_NAME}托管`
                : sshKey.privateKeyPath}
            </Typography.Text>
          </div>
        ),
      },
      {
        title: "使用主机",
        width: 100,
        render: (_, sshKey) => `${usage.get(sshKey.id) ?? 0} 台`,
      },
      {
        title: "操作",
        width: 176,
        render: (_, sshKey) => {
          const used = (usage.get(sshKey.id) ?? 0) > 0;
          return (
            <Space size="mini">
              {isTauri() && getSshKeySource(sshKey) === "managed" && (
                <Button disabled={acting} onClick={() => void showKeyInstall(sshKey)} size="mini">
                  安装公钥
                </Button>
              )}
              <Button
                aria-label={`编辑 ${sshKey.name}`}
                disabled={acting}
                icon={<IconEdit />}
                onClick={() => {
                  setEditingSshKey(sshKey);
                  setEditorVisible(true);
                }}
                size="mini"
              />
              <Tooltip content={used ? "仍被主机或回收站记录使用" : undefined}>
                <span>
                  <Popconfirm
                    content={`确定删除密钥“${sshKey.name}”？`}
                    disabled={used}
                    onOk={() => void removeSshKey(sshKey)}
                  >
                    <Button
                      aria-label={`删除 ${sshKey.name}`}
                      disabled={acting || used}
                      icon={<IconDelete />}
                      size="mini"
                      status="danger"
                    />
                  </Popconfirm>
                </span>
              </Tooltip>
            </Space>
          );
        },
      },
    ],
    [acting, showKeyInstall, usage],
  );

  return (
    <div className="ssh-key-settings">
      <div className="ssh-key-settings-heading">
        {isTauri() && (
          <Button disabled={loading || acting} onClick={() => setGeneratorOpen(true)}>
            生成密钥
          </Button>
        )}
        <Button
          disabled={loading || acting}
          icon={<IconPlus />}
          onClick={() => {
            setEditingSshKey(null);
            setEditorVisible(true);
          }}
          type="primary"
        >
          新增密钥
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={sshKeys}
        loading={loading}
        noDataElement={<Empty description="暂无密钥" />}
        pagination={false}
        rowKey="id"
        size="small"
      />
      {editorVisible && (
        <SshKeyEditorModal
          onCancel={() => {
            setEditorVisible(false);
            setEditingSshKey(null);
          }}
          onSubmit={(values) => void saveSshKey(values)}
          sshKey={editingSshKey}
          visible
        />
      )}
      {generatorOpen && (
        <Modal
          confirmLoading={acting}
          footer={null}
          maskClosable={false}
          onCancel={() => {
            if (!acting) setGeneratorOpen(false);
          }}
          title="生成 Ed25519 密钥"
          visible
        >
          <Form<{ name: string }>
            layout="vertical"
            onSubmit={(values) => void generateSshKey(values)}
          >
            <Form.Item field="name" label="密钥名称" rules={[{ required: true }]}>
              <Input autoFocus maxLength={80} placeholder="例如：我的工作服务器" />
            </Form.Item>
            <div className="modal-actions">
              <Button htmlType="submit" loading={acting} type="primary">
                生成密钥
              </Button>
            </div>
          </Form>
        </Modal>
      )}
      {installKey && (
        <Modal
          footer={null}
          maskClosable={false}
          onCancel={() => {
            if (!acting) setInstallKey(null);
          }}
          style={{ width: 620 }}
          title={`安装公钥 · ${installKey.name}`}
          visible
        >
          <Space direction="vertical" size="medium" style={{ width: "100%" }}>
            <Typography.Text>
              用要登录的账号打开服务器终端，粘贴并执行安装命令。栈渡验证新密钥后才会切换主机配置。
            </Typography.Text>
            <Input.TextArea
              aria-label="OpenSSH 公钥"
              autoSize
              readOnly
              value={installKey.publicKey}
            />
            <Space wrap>
              <Button
                onClick={() =>
                  void writeText(installKey.publicKey)
                    .then(() => Message.success("公钥已复制"))
                    .catch((error) => Message.error(String(error)))
                }
              >
                复制公钥
              </Button>
              <Button
                type="primary"
                onClick={() =>
                  void Promise.resolve()
                    .then(() => writeText(sshKeyInstallCommand(installKey.publicKey)))
                    .then(() => Message.success("安装命令已复制"))
                    .catch((error) => Message.error(String(error)))
                }
              >
                复制安装命令
              </Button>
            </Space>
            {hosts.length > 0 && (
              <>
                <Select
                  aria-label="选择要使用密钥的主机"
                  disabled={acting}
                  onChange={setInstallHostId}
                  options={hosts.map((host) => ({
                    label: `${host.name}（${host.username}@${host.address}）`,
                    value: host.id,
                  }))}
                  placeholder="选择要使用密钥的已保存主机"
                  showSearch
                  value={installHostId}
                />
                <Button
                  disabled={!installHostId}
                  loading={acting}
                  onClick={() => void applyToHost()}
                >
                  已安装，验证并启用
                </Button>
              </>
            )}
            <Typography.Text type="secondary">
              启用主机同步后，密钥会随关联的主机端到端加密同步。
            </Typography.Text>
          </Space>
        </Modal>
      )}
    </div>
  );
}

export default SshKeySettings;
