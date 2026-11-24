import { useState, type FormEvent } from "react";
import { Button, Input, Spin, Typography } from "@arco-design/web-react";
import { IconLock } from "@arco-design/web-react/icon";

interface LocalDataUnlockProps {
  error?: string;
  onUnlock: (passphrase: string) => Promise<void>;
  state: "checking" | "locked";
}

function LocalDataUnlock({ error, onUnlock, state }: LocalDataUnlockProps) {
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (state === "checking") {
    return (
      <main className="local-data-gate">
        <div className="local-data-gate-card">
          <Spin size={32} />
          <Typography.Text type="secondary">正在检查本地数据状态…</Typography.Text>
        </div>
      </main>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase || submitting) return;
    setSubmitting(true);
    try {
      await onUnlock(passphrase);
      setPassphrase("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="local-data-gate">
      <form className="local-data-gate-card" onSubmit={submit}>
        <span className="local-data-gate-icon">
          <IconLock />
        </span>
        <Typography.Title heading={5}>本地数据已加密</Typography.Title>
        <Typography.Text type="secondary">
          输入解锁密码后才能读取主机配置、连接历史与 AI 对话。密码只在本窗口内使用，不会写入磁盘。
        </Typography.Text>
        <Input.Password
          aria-label="本地数据解锁密码"
          autoFocus
          onChange={setPassphrase}
          placeholder="解锁密码"
          value={passphrase}
        />
        {error && <Typography.Text type="error">{error}</Typography.Text>}
        <Button htmlType="submit" loading={submitting} type="primary">
          解锁
        </Button>
        <Typography.Text className="local-data-gate-hint" type="secondary">
          忘记密码将无法恢复本地加密数据，只能删除后重新配置。
        </Typography.Text>
      </form>
    </main>
  );
}

export default LocalDataUnlock;
