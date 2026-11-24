import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostRecord } from "./models";

const realConfig = await import("./config-database");
let configuration = realConfig.migrateLegacyConfiguration(null, null);
const host: HostRecord = {
  id: "host-integration",
  name: "集成测试主机",
  address: "10.0.0.10",
  port: 22,
  username: "root",
  authMethod: "password",
  connectTimeoutSeconds: 10,
  keepAliveIntervalSeconds: 30,
  autoReconnect: false,
  maxReconnectAttempts: 3,
};
configuration = { ...configuration, hosts: [host] };

mock.module("./config-database", () => ({
  ...realConfig,
  loadConfiguration: async () => configuration,
  updateConfiguration: async (update: (current: typeof configuration) => typeof configuration) => {
    configuration = update(configuration);
    return configuration;
  },
}));

const invokedCommands: string[] = [];
mock.module("./diagnostics", () => ({
  configureDiagnosticLogging: async () => undefined,
  diagnosticInvoke: async (command: string) => {
    invokedCommands.push(command);
    if (command === "ssh_connect") {
      return { status: "connected", fingerprint: "SHA256:integration", portForwards: [] };
    }
    return undefined;
  },
  recordDiagnostic: () => undefined,
}));

mock.module("./components/TerminalView", () => ({
  default: () => <div data-testid="terminal-view" />,
}));
mock.module("./components/SftpPanel", () => ({
  default: () => <div data-testid="sftp-panel" />,
}));
mock.module("./components/ServerMonitorPanel", () => ({
  default: () => <div data-testid="server-monitor" />,
}));

const { default: App } = await import("./App");

describe("App golden path", () => {
  test("connects to a saved host and opens a session tab", async () => {
    render(<App />);

    const connectButton = await screen.findByRole("button", { name: "连接" }, { timeout: 5_000 });
    expect(screen.getByText("集成测试主机")).toBeTruthy();
    expect(screen.getByText("1 台主机")).toBeTruthy();

    fireEvent.click(connectButton);

    await waitFor(() => expect(invokedCommands).toContain("ssh_connect"));
    await waitFor(() => expect(screen.getAllByText("集成测试主机").length).toBeGreaterThan(0));
    expect(screen.getByTestId("terminal-view")).toBeTruthy();
  });
});
