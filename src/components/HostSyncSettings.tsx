import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Checkbox, Input, Message, Popconfirm, Space, Typography } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { APP_DISPLAY_NAME } from "../application-brand";
import { requestPasswordRecovery } from "../host-sync-auth";
import { commandErrorMessage, listenProtocolEvent } from "../tauri-protocol";
import {
  hostSyncAccount,
  hostSyncDevices,
  hostSyncRegistration,
  rotateHostSyncKey,
  sendHostSyncVerification,
  relinkHostSyncKey,
  type BlockedSyncRecord,
  type HostSyncDevice,
  type SyncOptions,
  hostSyncIsBound,
  hostSyncRecoveryKey,
  isHostSyncStorageEvent,
  readHostSyncStatus,
  requestHostSync,
  resetHostSyncPassword,
  signInToHostSync,
  signOutOfHostSync,
  type HostSyncAccount,
} from "../host-sync";

function validMasterPassword(value: string) {
  return Array.from(value.trim()).length >= 16 && new TextEncoder().encode(value).length <= 1024;
}

export default function HostSyncSettings() {
  const [account, setAccount] = useState<HostSyncAccount | null>(null);
  const [status, setStatus] = useState(readHostSyncStatus);
  const [syncPending, setSyncPending] = useState(false);
  const activeSync = useRef<{ id: string; timer: number } | null>(null);
  const [loading, setLoading] = useState(isTauri);
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false);
  const [server, setServer] = useState<string>(
    import.meta.env.VITE_FINESHELL_SYNC_URL || "https://auto.itfans.fun",
  );
  const [email, setEmail] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [renameDevice, setRenameDevice] = useState<string | null>(null);
  const [registrationMode, setRegistrationMode] = useState<"open" | "invite" | "closed" | null>(null);
  const [masterPasswordSupported, setMasterPasswordSupported] = useState(false);
  const [opaqueEnabled, setOpaqueEnabled] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [legacyLogin, setLegacyLogin] = useState(false);
  const [migrateActive, setMigrateActive] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const registrationAttempt = useRef<{ server: string; email: string; id: string } | null>(null);
  const inviteRequired = registrationMode === "invite";
  const [inviteCode, setInviteCode] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [devices, setDevices] = useState<HostSyncDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [confirmedKey, setConfirmedKey] = useState("");
  const [replacementKey, setReplacementKey] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [rotationAccountPassword, setRotationAccountPassword] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    void hostSyncAccount().then((value) => {
      if (!mounted) return;
      setAccount(value);
      if (value) {
        setServer(value.server);
        setEmail(value.email);
      }
    }).catch((error) => {
      if (mounted) Message.error(commandErrorMessage(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    function refresh(event: StorageEvent) {
      if (isHostSyncStorageEvent(event)) {
        setStatus(readHostSyncStatus());
        setChoices({});
      }
    }
    window.addEventListener("storage", refresh);
    const statusListener = listenProtocolEvent("host-sync:status", ({ payload }) => {
      if (!mounted) return;
      setStatus(payload.status);
      setChoices({});
      const pending = activeSync.current;
      if (!pending || pending.id !== payload.requestId) return;
      window.clearTimeout(pending.timer);
      if (payload.status.state === "success" || payload.status.state === "failed") {
        activeSync.current = null;
        setSyncPending(false);
      }
    });
    void statusListener.catch((error) => {
      if (mounted) Message.error(commandErrorMessage(error));
    });
    return () => {
      mounted = false;
      window.removeEventListener("storage", refresh);
      void statusListener.then((unlisten) => unlisten()).catch(() => undefined);
      if (activeSync.current) window.clearTimeout(activeSync.current.timer);
      activeSync.current = null;
    };
  }, []);

  const accountId = account?.accountId;
  useEffect(() => {
    if (!accountId || status?.signInRequired) return;
    let active = true;
    void hostSyncDevices(accountId).then((value) => {
      if (active) {
        setDevices(value);
        setDeviceError("");
      }
    }).catch((error) => {
      if (active) setDeviceError(commandErrorMessage(error));
    });
    return () => { active = false; };
  }, [accountId, status?.signInRequired]);

  useEffect(() => {
    if (!isTauri() || !server.trim()) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void hostSyncRegistration(server).then(({ mode, masterPassword, opaquePublicKey, passwordRecovery }) => {
        if (current) {
          setRegistrationMode(mode);
          setMasterPasswordSupported(masterPassword === true);
          setOpaqueEnabled(Boolean(opaquePublicKey));
          setPasswordRecovery(passwordRecovery === true);
        }
      }).catch((error) => {
        if (current) Message.error(commandErrorMessage(error));
      });
    }, 350);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [register, server]);

  async function sendVerification() {
    setSendingCode(true);
    try {
      await sendHostSyncVerification(server, email, inviteCode.trim());
      Message.success("验证码已发送，请查收邮件");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setSendingCode(false);
    }
  }

  async function refreshDevices(revoke?: string, rename?: string) {
    if (!accountId) return;
    setBusy(true);
    try {
      setDevices(await hostSyncDevices(accountId, revoke, rename));
      setDeviceError("");
      if (rename !== undefined) setRenameDevice(null);
    } catch (error) {
      setDeviceError(commandErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function relink(issue: BlockedSyncRecord) {
    try {
      const path = await open({ title: "选择 SSH 私钥文件", multiple: false, directory: false });
      if (typeof path === "string") await relinkHostSyncKey(issue, path);
    } catch (error) {
      Message.error(commandErrorMessage(error));
    }
  }

  function describe(record: Record<string, unknown> | null, other: Record<string, unknown> | null) {
    if (!record) return "已删除";
    const keys = new Set([...Object.keys(record), ...Object.keys(other ?? {})]);
    const fields = [...keys]
      .filter((key) => key !== "id" && key !== "name" &&
        JSON.stringify(record[key]) !== JSON.stringify(other?.[key]))
      .map((key) => [key, record[key] ?? null]);
    return <div>
      {String(record.name ?? "")}
      {fields.length > 0 && <details>
        <summary>查看配置差异</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(Object.fromEntries(fields), null, 2)}</pre>
      </details>}
    </div>;
  }

  function changeMode(next: boolean) {
    registrationAttempt.current = null;
    setRecoveryKey("");
    setConfirmedKey("");
    setRegistrationMode(null);
    setMasterPasswordSupported(false);
    setLegacyLogin(false);
    setInviteCode("");
    setVerificationCode("");
    setRegister(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const proof = register && inviteRequired
        ? { inviteCode: inviteCode.trim(), verificationCode: verificationCode.trim() }
        : undefined;
      const useMasterPassword = register && masterPasswordSupported;
      const normalizedEmail = email.trim().toLowerCase();
      const attempt = registrationAttempt.current;
      if (useMasterPassword && (!attempt || attempt.server !== server || attempt.email !== normalizedEmail)) {
        registrationAttempt.current = {
          server, email: normalizedEmail,
          id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        };
      }
      const registrationId = useMasterPassword ? registrationAttempt.current?.id : undefined;
      setAccount(await signInToHostSync({
        server, email, password, recoveryKey, register, deviceName, proof,
        useMasterPassword, registrationId, legacyLogin,
      }));
      registrationAttempt.current = null;
      setMigrateActive(false);
      setLegacyLogin(false);
      setInviteCode("");
      setVerificationCode("");
      setStatus(null);
      setRegister(false);
      setRecoveryKey("");
      setConfirmedKey("");
      Message.success("已登录，正在同步主机");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function rotateKey() {
    if (!account) return;
    setBusy(true);
    try {
      await rotateHostSyncKey(account, replacementKey, rotationAccountPassword);
      setReplacementKey("");
      setChangingPassword(false);
      setConfirmedKey("");
      setDevices([]);
      Message.success("已设置新主密码。其他设备需要用新主密码重新登录。");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setRotationAccountPassword("");
      setBusy(false);
    }
  }

  function switchRecovery(next: boolean) {
    setRecovering(next);
    setPassword("");
    setPasswordConfirmation("");
    setVerificationCode("");
    setRecoveryKey("");
    setLegacyLogin(false);
  }

  async function sendRecoveryCode() {
    setSendingCode(true);
    try {
      await requestPasswordRecovery(server, email);
      Message.success("如果该邮箱关联有效账号，重设验证码将发送到邮箱");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setSendingCode(false);
    }
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 12 || password !== passwordConfirmation || !verificationCode.trim()) return;
    setBusy(true);
    try {
      await resetHostSyncPassword(server, email, verificationCode.trim(), password);
      switchRecovery(false);
      if (account) setStatus({ state: "failed", signInRequired: true, message: "账号密码已重设，请使用新密码重新登录。" });
      Message.success("账号密码已重设，请重新登录。主密码与已有主机数据保持原样。");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setPassword("");
      setPasswordConfirmation("");
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await signOutOfHostSync();
      setAccount(null);
      setStatus(null);
      setRecoveryKey("");
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function sync(options: SyncOptions = {}) {
    if (activeSync.current) return;
    const id = crypto.randomUUID();
    function fail(message: string) {
      const pending = activeSync.current;
      if (pending?.id !== id) return;
      window.clearTimeout(pending.timer);
      activeSync.current = null;
      setSyncPending(false);
      setStatus({ state: "failed", message });
    }
    const timer = window.setTimeout(() => fail("同步请求未收到主窗口响应，请重试。"), 10_000);
    activeSync.current = { id, timer };
    setStatus(null);
    setSyncPending(true);
    void requestHostSync({ ...options, manual: true, requestId: id })
      .catch((error) => fail(commandErrorMessage(error)));
  }

  if (!isTauri()) return <Alert content={`请在${APP_DISPLAY_NAME}桌面应用中使用主机同步。`} />;
  if (loading) return <Typography.Text>正在读取同步账号…</Typography.Text>;

  if (account && !status?.signInRequired && !migrateActive && !recovering) {
    const lastSyncAt = status?.time ?? devices.find((device) => device.current)?.lastSyncAt;
    return (
      <Space direction="vertical" size="large">
        <Typography.Text>{account.email}</Typography.Text>
        {status?.message && <Alert type="error" content={status.message} />}
        {syncPending && !status && <Typography.Text>正在请求同步…</Typography.Text>}
        {status?.state === "queued" && <Typography.Text>正在等待当前同步结束…</Typography.Text>}
        {status?.state === "working" && <Typography.Text>正在同步主机…</Typography.Text>}
        {lastSyncAt && (
          <Typography.Text type="secondary">
            {status?.state === "success" && "同步完成 · "}
            最近同步 {new Date(lastSyncAt).toLocaleString()}
          </Typography.Text>
        )}
        <Space wrap>
          <Button type="primary" loading={syncPending} onClick={() => sync()}>立即同步</Button>
          <Button disabled={busy || changingPassword} onClick={() => void signOut()}>退出登录</Button>
          {!changingPassword && <Button disabled={busy} onClick={() => setChangingPassword(true)}>设置或更换主密码</Button>}
          {opaqueEnabled && !account.opaque && <Button disabled={busy || changingPassword}
            onClick={() => { setMigrateActive(true); setLegacyLogin(true); }}>
            迁移旧账号认证
          </Button>}
          {passwordRecovery && <Button disabled={busy || changingPassword}
            onClick={() => switchRecovery(true)}>忘记账号密码</Button>}
        </Space>
        {changingPassword && <Space direction="vertical">
          <Alert type="warning" content="主密码至少 16 个字符，与账号密码不同。更换后其他设备需要重新登录，已经导出的旧快照仍可能由旧密码或旧密钥解开。" />
          <label>账号密码
            <Input.Password value={rotationAccountPassword} onChange={setRotationAccountPassword} autoComplete="current-password" />
          </label>
          <label>新主密码
            <Input.Password value={replacementKey} onChange={setReplacementKey} autoComplete="new-password" />
          </label>
          <Button disabled={busy} onClick={() => void hostSyncRecoveryKey().then(setReplacementKey)
            .catch((error) => Message.error(commandErrorMessage(error)))}>生成强主密码</Button>
          <label>再次输入新主密码
            <Input.Password value={confirmedKey} onChange={setConfirmedKey} autoComplete="off" />
          </label>
          <Space>
            <Button type="primary" loading={busy}
              disabled={!validMasterPassword(replacementKey) || confirmedKey !== replacementKey ||
                !rotationAccountPassword || rotationAccountPassword === replacementKey}
              onClick={() => void rotateKey()}>更换并撤销其他设备</Button>
            <Button disabled={busy} onClick={() => {
              setReplacementKey("");
              setConfirmedKey("");
              setRotationAccountPassword("");
              setChangingPassword(false);
            }}>取消</Button>
          </Space>
        </Space>}
        {status?.recoverable && (
          <Popconfirm content="以这台设备最后验证的快照恢复云端？" onOk={() => sync({ recover: true })}>
            <Button status="warning">恢复云端快照</Button>
          </Popconfirm>
        )}
        {status?.blocked?.map((issue) => (
          <Space key={issue.kind + "/" + issue.id} wrap>
            <Typography.Text>{issue.name} 的 SSH 密钥或关联主机无法读取</Typography.Text>
            {issue.relink && <Button onClick={() => void relink(issue)}>重新关联私钥</Button>}
          </Space>
        ))}
        {!!status?.conflicts?.length && status.snapshot && (
          <Space direction="vertical">
            <Typography.Title heading={6}>解决同步冲突</Typography.Title>
            {status.conflicts.map((conflict) => (
              <fieldset key={conflict.id}>
                <legend>
                  {conflict.id.startsWith("quickCommands/") ? "快捷命令 · " : ""}
                  {conflict.id.startsWith("sftpBookmarks/")
                    ? "快速目录"
                    : String(conflict.local?.name ?? conflict.cloud?.name ?? conflict.id)}
                </legend>
                {conflict.credentialChanged && <Typography.Text>两端凭据有差异</Typography.Text>}
                {(["local", "cloud"] as const).map((side) => (
                  <div key={side}>
                    <label>
                      <input type="radio" name={conflict.id} autoComplete="off"
                        checked={choices[conflict.id] === (side === "local")}
                        onChange={() => setChoices((current) => ({ ...current, [conflict.id]: side === "local" }))}
                      />
                      {side === "local" ? "保留本机版本" : "保留云端版本"}
                    </label>
                    {conflict.id.startsWith("sftpBookmarks/")
                      ? <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                          {Array.isArray(conflict[side]?.bookmarks) ? conflict[side].bookmarks.join("\n") : "没有收藏目录"}
                        </div>
                      : describe(conflict[side], conflict[side === "local" ? "cloud" : "local"])}
                  </div>
                ))}
              </fieldset>
            ))}
            <Button type="primary" disabled={status.conflicts.some(({ id }) => choices[id] === undefined)}
              onClick={() => status.snapshot && sync({ resolution: { snapshot: status.snapshot, choices } })}>
              应用选择并同步
            </Button>
          </Space>
        )}
        <Space direction="vertical">
          <Typography.Title heading={6}>已登录设备</Typography.Title>
          {deviceError && <Alert type="warning" content={deviceError} />}
          {devices.map((device) => (
            <Space key={device.id} wrap>
              <Typography.Text>{device.name}{device.current ? "（本机）" : ""}</Typography.Text>
              <Typography.Text type="secondary">
                {device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : "尚无同步记录"}
              </Typography.Text>
              {device.current && (renameDevice === null
                ? <Button onClick={() => setRenameDevice(device.name)}>重命名本机</Button>
                : <Space>
                    <Input aria-label="本机新名称" value={renameDevice} onChange={setRenameDevice} maxLength={80} />
                    <Button disabled={!renameDevice.trim()} loading={busy}
                      onClick={() => void refreshDevices(undefined, renameDevice.trim())}>保存</Button>
                    <Button onClick={() => setRenameDevice(null)}>取消</Button>
                  </Space>
              )}
              {!device.current && (
                <Popconfirm content="撤销后，该设备必须重新登录才能同步。"
                  onOk={() => refreshDevices(device.id)}>
                  <Button status="danger" loading={busy}>撤销登录</Button>
                </Popconfirm>
              )}
            </Space>
          ))}
          <Button loading={busy} onClick={() => void refreshDevices()}>刷新设备列表</Button>
        </Space>
      </Space>
    );
  }

  return (
    <form onSubmit={recovering ? submitRecovery : submit}>
      <Space direction="vertical" size="medium" style={{ width: "100%" }}>
        <Typography.Paragraph>
          登录后自动同步已保存的主机、相关凭据、快捷命令和命令分组。新设备首次登录时用主密码或旧恢复密钥解锁。
        </Typography.Paragraph>
        {status?.signInRequired && <Alert type="warning" content={status.message} />}
        <label>
          同步服务地址
          <Input value={server} disabled={recovering || migrateActive} onChange={(value) => {
            setRegistrationMode(null); setOpaqueEnabled(false); setPasswordRecovery(false); setLegacyLogin(false); setServer(value);
          }}
            placeholder="https://sync.example.com" />
        </label>
        <label>
          邮箱
          <Input value={email} disabled={migrateActive || (recovering && Boolean(account))}
            onChange={(value) => { setEmail(value); setVerificationCode(""); }}
            autoComplete="username" />
        </label>
        {recovering ? <>
          <Alert content="邮箱验证只能重设账号密码。解锁主机数据仍需要主密码、旧恢复密钥或本机保存的密钥。" />
          <Space>
            <label>邮箱验证码
              <Input value={verificationCode} onChange={setVerificationCode} autoComplete="one-time-code" />
            </label>
            <Button loading={sendingCode} disabled={busy || !email.trim()} onClick={() => void sendRecoveryCode()}>发送验证码</Button>
          </Space>
          <label>新账号密码
            <Input.Password value={password} onChange={setPassword} minLength={12} autoComplete="new-password" />
          </label>
          <label>再次输入账号密码
            <Input.Password value={passwordConfirmation} onChange={setPasswordConfirmation} autoComplete="new-password" />
          </label>
          <Space>
            <Button type="primary" htmlType="submit" loading={busy}
              disabled={!verificationCode.trim() || password.length < 12 || password !== passwordConfirmation}>重设账号密码</Button>
            <Button disabled={busy || sendingCode} onClick={() => switchRecovery(false)}>返回登录</Button>
          </Space>
        </> : <>
        <label>
          设备名称
          <Input value={deviceName} onChange={setDeviceName} maxLength={80} placeholder="例如 Windows 台式机" />
        </label>
        <label>
          账号密码
          <Input.Password value={password} onChange={setPassword} minLength={12}
            autoComplete={register ? "new-password" : "current-password"} />
        </label>
        {register && registrationMode === "closed" && (
          <Alert type="warning" content="此服务器已关闭新账号注册。已有账号可以继续登录。" />
        )}
        {register && inviteRequired && (
          <>
            <label>
              邀请码
              <Input.Password value={inviteCode}
                onChange={(value) => { setInviteCode(value); setVerificationCode(""); }} autoComplete="off" />
            </label>
            <Space>
              <label>
                邮箱验证码
                <Input value={verificationCode} onChange={setVerificationCode} autoComplete="one-time-code" />
              </label>
              <Button loading={sendingCode} disabled={!email.trim() || !inviteCode.trim()}
                onClick={() => void sendVerification()}>发送验证码</Button>
            </Space>
          </>
        )}
        {register ? (
          <>
            <Alert type="warning" content={masterPasswordSupported
              ? "主密码至少 16 个字符，与账号密码不同。请保存在密码管理器。"
              : "此同步服务使用恢复密钥。请生成并保存在密码管理器。"} />
            <label>
              {masterPasswordSupported ? "主密码" : "恢复密钥"}
              <Input.Password value={recoveryKey} onChange={setRecoveryKey} readOnly={!masterPasswordSupported} autoComplete="new-password" />
            </label>
            <Button disabled={busy} onClick={() => void hostSyncRecoveryKey().then(setRecoveryKey)
              .catch((error) => Message.error(commandErrorMessage(error)))}>
              {masterPasswordSupported ? "生成强主密码" : "生成恢复密钥"}
            </Button>
            <label>
              {masterPasswordSupported ? "再次输入主密码" : "粘贴恢复密钥以确认已保存"}
              <Input.Password value={confirmedKey} onChange={setConfirmedKey} autoComplete="off" />
            </label>
          </>
        ) : (
          <label>
            {account ? "主密码或旧恢复密钥（留空使用本机保存的密钥）" : "主密码或旧恢复密钥"}
            <Input.Password value={recoveryKey} onChange={setRecoveryKey} autoComplete="off" />
          </label>
        )}
        {!register && !migrateActive && <Checkbox checked={legacyLogin} onChange={setLegacyLogin}>
          {opaqueEnabled ? "旧账号首次迁移" : "确认使用旧版账号认证"}
        </Checkbox>}
        {!register && legacyLogin && <Alert type="warning" content={
          opaqueEnabled ? "迁移时会通过 HTTPS 向当前同步服务验证一次旧账号密码。" : "旧版认证通过 HTTPS 将账号密码交给同步服务验证。"
        } />}
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}
            disabled={!server || !email || password.length < 12 || (!recoveryKey && (register || !account)) ||
              (!register && !opaqueEnabled && !legacyLogin) ||
              (register && (registrationMode === null || registrationMode === "closed" ||
                (masterPasswordSupported && (!validMasterPassword(recoveryKey) || recoveryKey === password)) ||
                recoveryKey !== (masterPasswordSupported ? confirmedKey : confirmedKey.trim()) ||
                (inviteRequired && (!inviteCode.trim() || !verificationCode.trim()))))}>
            {register ? "创建账号并同步" : opaqueEnabled && legacyLogin ? "迁移并登录" : "登录并同步"}
          </Button>
          {!hostSyncIsBound() && (
            <Button disabled={busy} onClick={() => changeMode(!register)}>
              {register ? "已有账号" : "创建账号"}
            </Button>
          )}
          {account && <Button loading={busy} onClick={() => void signOut()}>退出登录</Button>}
          {!register && !migrateActive && passwordRecovery && <Button disabled={busy} onClick={() => switchRecovery(true)}>忘记账号密码</Button>}
          {migrateActive && <Button disabled={busy} onClick={() => { setMigrateActive(false); setLegacyLogin(false); setPassword(""); }}>取消迁移</Button>}
        </Space>
        </>}
      </Space>
    </form>
  );
}
