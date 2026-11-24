import { expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { DEFAULT_APP_SETTINGS } from "../app-settings";
import TerminalThemeLibrary from "./TerminalThemeLibrary";

function TestSettings() {
  const [settings, setSettings] = useState(DEFAULT_APP_SETTINGS);
  return <TerminalThemeLibrary settings={settings} setSettings={setSettings} />;
}

test("searches bundled themes and previews scanned and imported Ghostty files", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockIPC((command) => {
    if (command === "read_ghostty_themes") {
      return [{ name: "本机主题", contents: "background = #121314" }];
    }
    if (command === "pick_local_path")
      return { path: "C:\\themes\\手动导入.conf", token: "theme-token" };
    if (command === "read_config_file") return "background = #223344\npalette = 15=#cccccc";
    throw new Error(command);
  });
  const view = render(<TestSettings />);
  try {
    const picker = screen.getByLabelText("终端配色方案") as HTMLSelectElement;
    const search = screen.getByLabelText("搜索终端主题");
    await within(picker).findByRole("option", { name: "本机主题" });
    fireEvent.change(picker, { target: { value: "ghostty:本机主题" } });
    expect(picker.value).toBe("ghostty:本机主题");
    expect(screen.getByLabelText("16 色 ANSI 色板").children).toHaveLength(16);

    fireEvent.change(search, { target: { value: "3024 Night" } });
    expect(within(picker).queryByRole("option", { name: "本机主题" })).toBeNull();
    expect(within(picker).getByRole("option", { name: "3024 Night" })).not.toBeNull();
    fireEvent.change(picker, { target: { value: "base24:3024-night" } });
    expect(picker.value).toBe("base24:3024-night");

    fireEvent.click(screen.getByRole("button", { name: "导入 Ghostty 主题" }));
    await within(picker).findByRole("option", { name: "手动导入" });
    expect(picker.value).toBe("ghostty:手动导入");
    expect(
      within(screen.getByLabelText("16 色 ANSI 色板")).getByTitle("ANSI 15 · #cccccc"),
    ).not.toBeNull();
  } finally {
    view.unmount();
    clearMocks();
    if (descriptor) Object.defineProperty(globalThis, "isTauri", descriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});
