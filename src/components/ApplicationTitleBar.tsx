import { useEffect, useState } from "react";
import { Button, Dropdown, Menu as ArcoMenu, Message, Tooltip } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize, Minimize, Minus, X } from "lucide-react";
import { isApplePlatform } from "../platform-utils";
import { APP_DISPLAY_NAME } from "../application-brand";
import WorkspaceIcon from "./WorkspaceIcon";

interface ApplicationTitleBarProps {
  hasActiveSession: boolean;
  onOpenQuickCommands: () => void;
  onOpenSettings: () => void;
  onOpenShortcutGuide: () => void;
  onToggleServerMonitor: () => void;
  onToggleSftp: () => void;
  platform?: string;
  serverMonitorCollapsed: boolean;
  sftpCollapsed: boolean;
}

function reportWindowOperationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  Message.error(`窗口操作失败：${message}`);
}

export default function ApplicationTitleBar({
  hasActiveSession,
  onOpenQuickCommands,
  onOpenSettings,
  onOpenShortcutGuide,
  onToggleServerMonitor,
  onToggleSftp,
  platform = navigator.platform,
  serverMonitorCollapsed,
  sftpCollapsed,
}: ApplicationTitleBarProps) {
  const applePlatform = isApplePlatform(platform);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (applePlatform || !isTauri()) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const updateMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (!disposed) setMaximized(next);
      } catch (error) {
        if (!disposed) reportWindowOperationError(error);
      }
    };

    void updateMaximized();
    void appWindow
      .onResized(() => void updateMaximized())
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListening = unlisten;
      })
      .catch(reportWindowOperationError);

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [applePlatform]);

  const runWindowOperation = (operation: () => Promise<void>) => {
    if (!isTauri()) return;
    void operation().catch(reportWindowOperationError);
  };

  const toggleMaximize = () => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setMaximized)
      .catch(reportWindowOperationError);
  };

  return (
    <header
      className={`application-titlebar ${
        applePlatform ? "application-titlebar-macos" : "application-titlebar-custom"
      }`}
    >
      <div
        className="application-titlebar-drag-region"
        data-tauri-drag-region
        onDoubleClick={applePlatform ? undefined : toggleMaximize}
      >
        <div className="application-titlebar-brand">
          <img alt="" src="/app-icon.png" />
          <span>{APP_DISPLAY_NAME}</span>
        </div>
      </div>

      <div className="application-titlebar-toolbar">
        <Tooltip content={serverMonitorCollapsed ? "显示服务器监控" : "隐藏服务器监控"}>
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label={serverMonitorCollapsed ? "显示服务器监控" : "隐藏服务器监控"}
              aria-pressed={!serverMonitorCollapsed}
              className="application-titlebar-action-button"
              disabled={!hasActiveSession}
              icon={<WorkspaceIcon name={serverMonitorCollapsed ? "monitor" : "activity"} />}
              onClick={onToggleServerMonitor}
              type="text"
            />
          </span>
        </Tooltip>
        <Tooltip content={sftpCollapsed ? "显示文件管理" : "隐藏文件管理"}>
          <span className="application-titlebar-action-wrapper">
            <Button
              aria-label={sftpCollapsed ? "显示文件管理" : "隐藏文件管理"}
              aria-pressed={!sftpCollapsed}
              className="application-titlebar-action-button"
              disabled={!hasActiveSession}
              icon={<WorkspaceIcon name={sftpCollapsed ? "folder" : "folder-open"} />}
              onClick={onToggleSftp}
              type="text"
            />
          </span>
        </Tooltip>
        <span className="application-titlebar-action-wrapper">
          <Dropdown
            droplist={
              <ArcoMenu
                className="application-titlebar-menu"
                onClickMenuItem={(key) => {
                  if (key === "quickCommands") onOpenQuickCommands();
                  else if (key === "shortcutGuide") onOpenShortcutGuide();
                  else if (key === "settings") onOpenSettings();
                }}
              >
                <ArcoMenu.Item disabled={!hasActiveSession} key="quickCommands">
                  <span className="application-titlebar-menu-label">
                    <WorkspaceIcon name="terminal" />
                    <span>快捷命令</span>
                  </span>
                </ArcoMenu.Item>
                <ArcoMenu.Item key="shortcutGuide">
                  <span className="application-titlebar-menu-label">
                    <WorkspaceIcon name="keyboard" />
                    <span>快捷键</span>
                  </span>
                </ArcoMenu.Item>
                <ArcoMenu.Item className="application-titlebar-menu-settings" key="settings">
                  <span className="application-titlebar-menu-label">
                    <WorkspaceIcon name="settings" />
                    <span>设置</span>
                  </span>
                </ArcoMenu.Item>
              </ArcoMenu>
            }
            position="br"
            trigger="click"
          >
            <Tooltip content="菜单">
              <Button
                aria-label="打开应用菜单"
                className="application-titlebar-action-button"
                icon={<WorkspaceIcon name="menu" />}
                type="text"
              />
            </Tooltip>
          </Dropdown>
        </span>
      </div>

      {!applePlatform && (
        <div className="application-window-controls">
          <button
            aria-label="最小化窗口"
            className="application-window-control"
            onClick={() => runWindowOperation(() => getCurrentWindow().minimize())}
            type="button"
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            aria-label={maximized ? "还原窗口" : "最大化窗口"}
            className="application-window-control"
            onClick={toggleMaximize}
            type="button"
          >
            {maximized ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
          </button>
          <button
            aria-label="关闭窗口"
            className="application-window-control application-window-control-close"
            onClick={() => runWindowOperation(() => getCurrentWindow().close())}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
