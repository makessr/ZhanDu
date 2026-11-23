import { expect, test } from "bun:test";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import type { TerminalSession } from "../models";
import SftpPanel from "./SftpPanel";

test("a failed terminal directory change keeps the last SFTP location and allows the next change", async () => {
  const session: TerminalSession = {
    id: "sftp-follow-test",
    status: "connected",
    openedAt: "2026-11-23T00:00:00.000Z",
    host: {
      id: "sftp-test-host",
      name: "测试主机",
      address: "192.0.2.10",
      port: 22,
      username: "tester",
      authMethod: "password",
      connectTimeoutSeconds: 10,
      keepAliveIntervalSeconds: 30,
      autoReconnect: false,
      maxReconnectAttempts: 3,
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockWindows("main");
  mockIPC((command, args) => {
    if (command === "sftp_connect") return { homeDir: "/home/tester" };
    if (command !== "sftp_list_preview") return;
    const { path } = args as { path: string };
    if (path === "/restricted") throw new Error("无法读取远程目录：Permission denied");
    return { path, entries: [] };
  }, { shouldMockEvents: true });

  const props = {
    confirmFileDelete: true,
    externalEditorName: "",
    externalEditorPath: "",
    sftpUploadRetryAttempts: 0,
    onCurrentPathChange: () => undefined,
    onReconnect: () => undefined,
    onSendFilesToAi: () => undefined,
    onSendSelectionToAi: () => undefined,
    refreshRequest: 0,
    session,
    showHiddenFiles: false,
  };
  const view = render(<SftpPanel {...props} />);
  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    view.rerender(<SftpPanel {...props} terminalDirectory={{ path: "/restricted", revision: 1 }} />);
    expect(await screen.findByText("无法读取远程目录：Permission denied")).not.toBeNull();
    expect(screen.getByLabelText("当前远程目录：/home/tester")).not.toBeNull();

    view.rerender(<SftpPanel {...props} terminalDirectory={{ path: "/home/tester", revision: 2 }} />);
    await waitFor(() => {
      expect(screen.queryByText("无法读取远程目录：Permission denied")).toBeNull();
    });

    view.rerender(<SftpPanel {...props} terminalDirectory={{ path: "/srv/project space", revision: 3 }} />);
    await waitFor(() => {
      expect(screen.getByLabelText("当前远程目录：/srv/project space")).not.toBeNull();
      expect(screen.queryByText("无法读取远程目录：Permission denied")).toBeNull();
    });
  } finally {
    view.unmount();
    clearMocks();
    if (descriptor) Object.defineProperty(globalThis, "isTauri", descriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});
