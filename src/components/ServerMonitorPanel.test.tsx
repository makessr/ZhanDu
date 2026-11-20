import { describe, expect, mock, test } from "bun:test";
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostRecord, TerminalSession } from "../models";

mock.module("./ServerMonitorCharts", () => ({
  UtilizationChart: () => <div data-testid="bar-chart" />,
  ResourceTrendChart: () => <div data-testid="area-chart" />,
  NetworkTrendChart: () => <div data-testid="network-chart" />,
}));

import ServerMonitorPanel from "./ServerMonitorPanel";

function session(status: TerminalSession["status"]): TerminalSession {
  const host: HostRecord = {
    id: "host-1",
    name: "测试主机",
    address: "192.0.2.10",
    port: 22,
    username: "tester",
    authMethod: "password",
    connectTimeoutSeconds: 10,
    keepAliveIntervalSeconds: 30,
    autoReconnect: false,
    maxReconnectAttempts: 3,
  };
  return {
    id: "session-1",
    host,
    openedAt: "2026-09-28T00:00:00.000Z",
    status,
  };
}

describe("ServerMonitorPanel", () => {
  test("pauses hidden monitoring and loads charts only on request", async () => {
    const collect = mock(() => Promise.resolve({
      collectedAt: Date.now(),
      hostname: "test-host",
      loadAverage: [0, 0, 0],
      cpuUsagePercent: 5,
    }));
    mockIPC((command) => {
      if (command === "ssh_monitor_snapshot") return collect();
    });
    let hidden = false;
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    const props = {
      onPortForwardStatusChange: () => undefined,
      onReconnect: () => undefined,
      onSendToAi: () => undefined,
      onSnapshotChange: () => undefined,
      refreshIntervalSeconds: 30,
      session: session("connected"),
    };
    const view = render(<ServerMonitorPanel {...props} visible={false} />);
    try {
      expect(collect).toHaveBeenCalledTimes(0);
      view.rerender(<ServerMonitorPanel {...props} visible />);
      expect(await screen.findByText("test-host")).not.toBeNull();
      expect(collect).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("bar-chart")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "显示图表" }));
      expect(await screen.findByTestId("bar-chart")).not.toBeNull();
      await act(async () => {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(screen.queryByTestId("bar-chart")).toBeNull();
      expect(collect).toHaveBeenCalledTimes(1);
      await act(async () => {
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(collect).toHaveBeenCalledTimes(2);
      expect(await screen.findByTestId("bar-chart")).not.toBeNull();
    } finally {
      view.unmount();
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
      clearMocks();
    }
  });

  test("waits for native window restore even when the webview is visible", async () => {
    let minimized = true;
    const checkMinimized = mock(() => minimized);
    const collect = mock(() => new Promise(() => {}));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "isTauri", {
      configurable: true,
      value: true,
    });
    mockWindows("main");
    mockIPC((command) => {
      if (command === "plugin:window|is_minimized") return checkMinimized();
      if (command === "ssh_monitor_snapshot") return collect();
    }, { shouldMockEvents: true });
    const view = render(
      <ServerMonitorPanel
        visible
        onPortForwardStatusChange={() => undefined}
        onReconnect={() => undefined}
        onSendToAi={() => undefined}
        onSnapshotChange={() => undefined}
        refreshIntervalSeconds={30}
        session={session("connected")}
      />,
    );
    try {
      expect(document.hidden).toBe(false);
      await waitFor(() => expect(checkMinimized).toHaveBeenCalledTimes(1));
      expect(collect).toHaveBeenCalledTimes(0);
      minimized = false;
      await act(() => emit(TauriEvent.WINDOW_FOCUS));
      await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    } finally {
      view.unmount();
      if (descriptor) Object.defineProperty(globalThis, "isTauri", descriptor);
      else Reflect.deleteProperty(globalThis, "isTauri");
      clearMocks();
    }
  });

  test("clears monitor data and uses muted placeholders when disconnected", () => {
    const onSnapshotChange = mock(() => undefined);
    const { container } = render(
      <ServerMonitorPanel
        visible
        onPortForwardStatusChange={() => undefined}
        onReconnect={() => undefined}
        onSendToAi={() => undefined}
        onSnapshotChange={onSnapshotChange}
        refreshIntervalSeconds={30}
        session={session("disconnected")}
      />,
    );

    const monitor = container.querySelector(".server-monitor");
    expect(monitor?.classList.contains("is-unavailable")).toBe(true);
    expect(container.querySelector(".monitor-system-facts")?.textContent).toBe(
      "系统-主机名-内核-运行时间-负载-",
    );
    expect(onSnapshotChange).toHaveBeenCalledWith("session-1", null);
  });

  test("resets monitor state while a session is reconnecting", () => {
    const onSnapshotChange = mock(() => undefined);
    const { container } = render(
      <ServerMonitorPanel
        visible
        onPortForwardStatusChange={() => undefined}
        onReconnect={() => undefined}
        onSendToAi={() => undefined}
        onSnapshotChange={onSnapshotChange}
        refreshIntervalSeconds={30}
        session={session("reconnecting")}
      />,
    );

    expect(container.querySelector(".server-monitor.is-unavailable")).not.toBeNull();
    expect(onSnapshotChange).toHaveBeenCalledWith("session-1", null);
  });
});
