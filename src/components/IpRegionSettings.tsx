import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Space, Typography } from "@arco-design/web-react";
import { diagnosticInvoke as invoke } from "../diagnostics";
import { commandErrorMessage } from "../tauri-protocol";

export interface IpRegionStatus {
  ipv4: boolean;
  ipv6: boolean;
}

export default function IpRegionSettings({
  enabled,
  ipv6,
  onEnable,
  onIpv6Change,
}: {
  enabled: boolean;
  ipv6: boolean;
  onEnable: (enabled: boolean) => void;
  onIpv6Change: (enabled: boolean) => void;
}) {
  const [status, setStatus] = useState<IpRegionStatus>();
  const [busy, setBusy] = useState<"ipv4" | "ipv6">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void invoke<IpRegionStatus>("ip_region_status").then((result) => {
      if (active) setStatus(result);
    }).catch((failure) => {
      if (active) setError(commandErrorMessage(failure));
    });
    return () => { active = false; };
  }, []);

  async function update(family: "ipv4" | "ipv6", remove: boolean, importFromFile = false) {
    setBusy(family);
    setError(undefined);
    try {
      const importPath = importFromFile ? await open({ filters: [{ name: "ip2region", extensions: ["xdb"] }], multiple: false }) : undefined;
      if (importFromFile && typeof importPath !== "string") return;
      setStatus(await invoke<IpRegionStatus>("ip_region_update", {
        ipv6: family === "ipv6",
        remove,
        ...(typeof importPath === "string" && { importPath }),
      }));
    } catch (failure) {
      setError(commandErrorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section aria-label="IP 归属地" className="settings-group ip-region-settings">
      <Typography.Text bold>IP 归属地</Typography.Text>
      <Checkbox checked={enabled} onChange={onEnable}>显示远端 IP 归属地</Checkbox>
      <Checkbox checked={ipv6} disabled={!enabled} onChange={onIpv6Change}>同时查询 IPv6</Checkbox>
      <Typography.Text type="secondary">
        下载并校验 ip2region 数据后在本机查询。连接地址不会发送给第三方。归属地仅供参考。
      </Typography.Text>
      {(["ipv4", "ipv6"] as const).map((family) => (
        <div className="ip-region-data-row" key={family}>
          <span>{family === "ipv4" ? "IPv4 数据（约 11 MB）" : "IPv6 数据（约 37 MB）"}</span>
          <Space size="small">
            <Typography.Text type="secondary">{status ? status[family] ? "已下载" : "未下载" : "正在检查"}</Typography.Text>
            <Button disabled={Boolean(busy) || !status} loading={busy === family} onClick={() => void update(family, Boolean(status?.[family]))} size="small">
              {status?.[family] ? "删除数据" : "下载数据"}
            </Button>
            {status && !status[family] && (
              <Button disabled={Boolean(busy)} onClick={() => void update(family, false, true)} size="small">导入文件</Button>
            )}
          </Space>
        </div>
      ))}
      {error && <Alert content={error} showIcon type="error" />}
    </section>
  );
}
