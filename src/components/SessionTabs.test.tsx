import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostRecord, TerminalSession } from "../models";
import SessionTabs from "./SessionTabs";

const HOST: HostRecord = {
  id: "host-1",
  name: "生产服务器",
  address: "server.example.com",
  port: 22,
  username: "root",
  authMethod: "password",
  connectTimeoutSeconds: 10,
  keepAliveIntervalSeconds: 15,
  autoReconnect: true,
  maxReconnectAttempts: 3,
};

const SESSION: TerminalSession = {
  id: "session-1",
  host: HOST,
  openedAt: "2026-07-24T00:00:00.000Z",
  status: "connected",
};

function renderTabs(
  activeSessionId: string | null,
  onActiveSessionChange = mock(() => undefined),
  aiAssistantVisible = false,
) {
  const onToggleAiAssistant = mock(() => undefined);
  return {
    onActiveSessionChange,
    onToggleAiAssistant,
    ...render(
      <SessionTabs
        activeSessionId={activeSessionId}
        aiAssistantVisible={aiAssistantVisible}
        hasActiveSession={activeSessionId !== null}
        homeContent={<div>主机管理内容</div>}
        onActiveSessionChange={onActiveSessionChange}
        onCloseSession={() => undefined}
        onToggleAiAssistant={onToggleAiAssistant}
        renderSession={(session) => <div>终端 {session.host.name}</div>}
        sessionContextMenuItems={() => []}
        sessions={[SESSION]}
      />,
    ),
  };
}

describe("SessionTabs", () => {
  test("shows both terminal panes while retaining the selected terminal", () => {
    const second = { ...SESSION, id: "session-2", host: { ...HOST, name: "第二台主机" } };
    const onChange = mock(() => undefined);
    const tabs = (
      <SessionTabs
        activeSessionId={SESSION.id}
        aiAssistantVisible={false}
        hasActiveSession
        homeContent={<div>主机管理内容</div>}
        onActiveSessionChange={onChange}
        onCloseSession={() => undefined}
        onToggleAiAssistant={() => undefined}
        renderSession={(session) => <div>终端 {session.host.name}</div>}
        sessionContextMenuItems={() => []}
        sessions={[SESSION, second]}
      />
    );
    const { container, unmount } = render(tabs);
    const first = container.querySelector('[aria-label="生产服务器"].terminal-pane');
    expect(screen.getAllByRole("region")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "终端布局" }));
    fireEvent.click(screen.getByText("左右分屏"));
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(container.querySelector(".terminal-panes-columns")).not.toBeNull();
    expect(container.querySelector('[aria-label="生产服务器"].terminal-pane')).toBe(first);
    fireEvent.focus(screen.getByRole("region", { name: "第二台主机" }));
    expect(onChange).toHaveBeenCalledWith("session-2");
    unmount();
    const restored = render(tabs);
    expect(restored.container.querySelector(".terminal-panes-columns")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "终端布局" }));
    fireEvent.click(screen.getByText("单窗口"));
    expect(restored.container.querySelector(".terminal-panes-columns")).toBeNull();
  });

  test("saves host references and reopens the named workspace with its ordered panes", async () => {
    const workspacesKey = "fineshell.terminal.workspaces";
    const splitKey = "fineshell.terminal.splitDirection";
    const second = { ...SESSION, id: "second-session", host: { ...HOST, id: "second-host" } };
    const start = mock(async () => ["fresh-first", "fresh-second"]);
    const activate = mock(() => undefined);
    const props = {
      aiAssistantVisible: false,
      hasActiveSession: true,
      homeContent: null,
      onActiveSessionChange: activate,
      onCloseSession: () => undefined,
      onOpenWorkspace: start,
      onToggleAiAssistant: () => undefined,
      renderSession: (session: TerminalSession) => session.id,
      sessionContextMenuItems: () => [],
    };
    localStorage.removeItem(workspacesKey);
    try {
      const original = render(
        <SessionTabs {...props} activeSessionId={second.id} sessions={[SESSION, second]} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "终端布局" }));
      fireEvent.click(screen.getByText("上下分屏"));
      fireEvent.click(screen.getByRole("button", { name: "SSH 工作区" }));
      fireEvent.change(screen.getByRole("textbox", { name: "工作区名称" }), {
        target: { value: "运维" },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存当前会话" }));
      const [saved] = JSON.parse(localStorage.getItem(workspacesKey)!);
      expect(saved.hostIds).toEqual([HOST.id, second.host.id]);
      expect(saved.panes).toEqual([1, 0]);
      expect(saved.layout).toBe("rows");
      original.unmount();
      const fresh = render(
        <SessionTabs {...props} hasActiveSession={false} activeSessionId={null} sessions={[]} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "SSH 工作区" }));
      fireEvent.click(screen.getByRole("button", { name: "打开" }));
      await waitFor(() => expect(activate).toHaveBeenCalledWith("fresh-second"));
      expect(start).toHaveBeenCalledWith([HOST.id, second.host.id]);
      fresh.rerender(
        <SessionTabs
          {...props}
          activeSessionId="fresh-second"
          sessions={[
            { ...SESSION, id: "fresh-first" },
            { ...second, id: "fresh-second" },
          ]}
        />,
      );
      expect(fresh.container.querySelector(".terminal-panes-rows")).not.toBeNull();
      expect(screen.getAllByRole("region").map((pane) => pane.style.order)).toEqual(["1", "0"]);
    } finally {
      localStorage.removeItem(workspacesKey);
      localStorage.removeItem(splitKey);
    }
  });

  test("keeps the fixed home entry outside the scrollable tabs", () => {
    const { container } = renderTabs(null);
    const fixedHome = container.querySelector(".terminal-home-tab");
    const tabContainer = container.querySelector(".terminal-tabs");

    expect(fixedHome).not.toBeNull();
    expect(fixedHome?.getAttribute("aria-selected")).toBe("true");
    expect(tabContainer?.contains(fixedHome)).toBe(false);
  });

  test("switches between a session and the fixed home entry", () => {
    const onChange = mock(() => undefined);
    const { container } = renderTabs(null, onChange);

    fireEvent.click(screen.getByText("生产服务器"));
    expect(onChange).toHaveBeenCalledWith("session-1");

    fireEvent.click(container.querySelector(".terminal-home-tab")!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test("keeps the AI toggle fixed outside the scrollable tabs", () => {
    const { container, onToggleAiAssistant } = renderTabs("session-1", undefined, true);
    const button = screen.getByRole("button", { name: "关闭 AI 助手" });

    expect(container.querySelector(".terminal-tabs")?.contains(button)).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggleAiAssistant).toHaveBeenCalledTimes(1);
  });

  test("disables the AI toggle on the fixed home page", () => {
    renderTabs(null);
    expect(
      (
        screen.getByRole("button", {
          name: "打开 AI 助手",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
