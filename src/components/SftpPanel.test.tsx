import { afterEach, expect, mock, test } from "bun:test";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SftpEntry, TerminalSession } from "../models";
import SftpPanel from "./SftpPanel";

const isTauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");

afterEach(() => {
  clearMocks();
  if (isTauriDescriptor) Object.defineProperty(globalThis, "isTauri", isTauriDescriptor);
  else Reflect.deleteProperty(globalThis, "isTauri");
});

function connectedSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "sftp-test-session",
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
    ...overrides,
  };
}

function panelCommands() {
  return {
    currentPathChange: mock(() => undefined),
    reconnect: mock(() => undefined),
    sendFilesToAi: mock(async () => undefined),
    sendSelectionToAi: mock(async () => undefined),
    showFiles: mock(() => undefined),
    showTransfers: mock(() => undefined),
  };
}

function panelProps(session: TerminalSession, commands = panelCommands()) {
  return {
    commands,
    confirmFileDelete: true,
    externalEditorName: "",
    externalEditorPath: "",
    sftpUploadRetryAttempts: 0,
    refreshRequest: 0,
    session,
    showHiddenFiles: false,
  };
}

interface RecordedCall {
  args: Record<string, unknown>;
  command: string;
}

function installSftpMock(entries: SftpEntry[] = []) {
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockWindows("main");
  const calls: RecordedCall[] = [];
  mockIPC(
    (command, args) => {
      calls.push({ args: (args ?? {}) as Record<string, unknown>, command });
      if (command === "sftp_connect") return { homeDir: "/home/tester" };
      if (command === "sftp_list_preview") {
        const { path } = args as { path: string };
        return { path, entries };
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

function listedPaths(calls: RecordedCall[]) {
  return calls
    .filter((call) => call.command === "sftp_list_preview")
    .map((call) => call.args.path as string);
}

test("connects, lists, and refreshes the active session", async () => {
  const calls = installSftpMock([
    {
      id: "entry-logs",
      kind: "directory",
      name: "logs",
      path: "/home/tester/logs",
      size: 0,
      permissions: 0o755,
      modifiedAt: 1_700_000_000,
    },
  ]);
  const session = connectedSession();
  const props = panelProps(session);
  const view = render(<SftpPanel {...props} />);

  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    expect(calls.filter((call) => call.command === "sftp_connect")).toHaveLength(1);
    expect(listedPaths(calls)).toEqual(["/home/tester"]);
    expect(screen.getByText("logs")).not.toBeNull();

    view.rerender(<SftpPanel {...props} refreshRequest={1} />);
    await waitFor(() => expect(listedPaths(calls)).toEqual(["/home/tester", "/home/tester"]));
    expect(calls.filter((call) => call.command === "sftp_connect")).toHaveLength(1);
  } finally {
    view.unmount();
  }
});

test("reports the browser path through the commands object", async () => {
  installSftpMock();
  const session = connectedSession();
  const commands = panelCommands();
  const view = render(<SftpPanel {...panelProps(session, commands)} />);

  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    await waitFor(() =>
      expect(commands.currentPathChange).toHaveBeenCalledWith(session.id, "/home/tester"),
    );
  } finally {
    view.unmount();
  }
});

test("opens a directory on double click and lists the new path", async () => {
  const calls = installSftpMock([
    {
      id: "entry-logs",
      kind: "directory",
      name: "logs",
      path: "/home/tester/logs",
      size: 0,
      permissions: 0o755,
      modifiedAt: 1_700_000_000,
    },
  ]);
  const props = panelProps(connectedSession());
  const view = render(<SftpPanel {...props} />);

  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    fireEvent.doubleClick(screen.getByText("logs"));

    await screen.findByLabelText("当前远程目录：/home/tester/logs");
    expect(listedPaths(calls)).toEqual(["/home/tester", "/home/tester/logs"]);
  } finally {
    view.unmount();
  }
});

test("disconnects SFTP when the terminal session drops", async () => {
  const calls = installSftpMock();
  const session = connectedSession();
  const props = panelProps(session);
  const view = render(<SftpPanel {...props} />);

  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    view.rerender(<SftpPanel {...props} session={{ ...session, status: "disconnected" }} />);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "sftp_disconnect")).toBe(true),
    );
    expect(calls.find((call) => call.command === "sftp_disconnect")?.args.sessionId).toBe(
      session.id,
    );
  } finally {
    view.unmount();
  }
});

test("a failed terminal directory change keeps the last SFTP location and allows the next change", async () => {
  const session = connectedSession({ id: "sftp-follow-test" });
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockWindows("main");
  mockIPC(
    (command, args) => {
      if (command === "sftp_connect") return { homeDir: "/home/tester" };
      if (command !== "sftp_list_preview") return;
      const { path } = args as { path: string };
      if (path === "/restricted") throw new Error("无法读取远程目录：Permission denied");
      return { path, entries: [] };
    },
    { shouldMockEvents: true },
  );

  const props = panelProps(session);
  const view = render(<SftpPanel {...props} />);
  try {
    await screen.findByLabelText("当前远程目录：/home/tester");
    view.rerender(
      <SftpPanel {...props} terminalDirectory={{ path: "/restricted", revision: 1 }} />,
    );
    expect(await screen.findByText("无法读取远程目录：Permission denied")).not.toBeNull();
    expect(screen.getByLabelText("当前远程目录：/home/tester")).not.toBeNull();

    view.rerender(
      <SftpPanel {...props} terminalDirectory={{ path: "/home/tester", revision: 2 }} />,
    );
    await waitFor(() => {
      expect(screen.queryByText("无法读取远程目录：Permission denied")).toBeNull();
    });

    view.rerender(
      <SftpPanel {...props} terminalDirectory={{ path: "/srv/project space", revision: 3 }} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("当前远程目录：/srv/project space")).not.toBeNull();
      expect(screen.queryByText("无法读取远程目录：Permission denied")).toBeNull();
    });
  } finally {
    view.unmount();
  }
});
