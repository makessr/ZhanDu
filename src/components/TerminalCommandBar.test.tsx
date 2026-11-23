import { expect, mock, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { DEFAULT_APP_SETTINGS } from "../app-settings";
import TerminalCommandBar from "./TerminalCommandBar";

test("completes remote names and paths, then sends only on explicit submission", async () => {
  const submit = mock(async (_command: string) => undefined);
  mockIPC((command) => {
    if (command === "ssh_command_names") return ["/home/test", ["docker"]];
    if (command === "sftp_list") return { path: "/home/test", entries: [{ name: "test dir", kind: "directory" }] };
    throw new Error(command);
  });
  const view = render(
    <TerminalCommandBar
      connected
      getDirectory={() => "/home/test"}
      getHistory={() => []}
      hostId="test-host"
      inputRef={createRef<HTMLInputElement>()}
      onFocusTerminal={() => undefined}
      onSubmit={submit}
      sessionId="test-session"
      settings={DEFAULT_APP_SETTINGS}
    />,
  );
  try {
    const input = screen.getByRole("textbox", { name: "命令输入框" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "doc" } });
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("docker "));
    expect(submit).toHaveBeenCalledTimes(0);

    fireEvent.change(input, { target: { value: "cd t" } });
    input.setSelectionRange(4, 4);
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("cd 'test dir/'"));
    expect(submit).toHaveBeenCalledTimes(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submit).toHaveBeenCalledWith("cd 'test dir/'"));
  } finally {
    view.unmount();
    clearMocks();
  }
});
