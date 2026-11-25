import { describe, expect, test } from "bun:test";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { finishWorkspaceStartup, showMainWindowEarly } from "./workspace-startup";

describe("Windows workspace startup", () => {
  test("shows the window before announcing readiness and keeps the loader for index.html", async () => {
    const isTauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
    const shows: string[] = [];
    let readyCount = 0;
    const onReady = () => {
      readyCount += 1;
    };

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    document.body.innerHTML = '<div id="startup-loader" role="status"></div>';
    window.addEventListener("fineshell:workspace-ready", onReady);
    mockWindows("main");
    mockIPC((command) => {
      if (command === "plugin:window|show") shows.push(command);
    });

    try {
      await showMainWindowEarly();
      expect(shows).toEqual(["plugin:window|show"]);
      expect(readyCount).toBe(0);
      expect(document.getElementById("startup-loader")).not.toBeNull();

      await finishWorkspaceStartup();
      expect(readyCount).toBe(1);
      expect(document.getElementById("startup-loader")).not.toBeNull();
    } finally {
      window.removeEventListener("fineshell:workspace-ready", onReady);
      document.body.innerHTML = "";
      clearMocks();
      if (isTauriDescriptor) Object.defineProperty(globalThis, "isTauri", isTauriDescriptor);
      else Reflect.deleteProperty(globalThis, "isTauri");
      if (platformDescriptor) Object.defineProperty(navigator, "platform", platformDescriptor);
      else Reflect.deleteProperty(navigator, "platform");
    }
  });
});
