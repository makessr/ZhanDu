import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { recordDiagnostic } from "./diagnostics";

let startup: Promise<void> | undefined;
let showPromise: Promise<void> | undefined;

function mainWindowOnWindows() {
  return isTauri() && navigator.platform.startsWith("Win") ? getCurrentWindow() : null;
}

export function showMainWindowEarly() {
  return (showPromise ??= (async () => {
    const main = mainWindowOnWindows();
    if (main?.label !== "main") return;
    try {
      await main.show();
    } catch (error) {
      // Allow finishWorkspaceStartup to retry if the window was not ready yet.
      showPromise = undefined;
      recordDiagnostic("warn", "frontend.startup", "主窗口提前显示失败", { error: String(error) });
    }
  })());
}

export function finishWorkspaceStartup() {
  return (startup ??= (async () => {
    // Show the window with its loader still on top, then reveal the painted UI.
    await showMainWindowEarly();

    await new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timeout);
        window.cancelAnimationFrame(frame);
        resolve();
      };
      const timeout = window.setTimeout(finish, 160);
      let frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(finish);
      });
    });

    window.dispatchEvent(new Event("fineshell:workspace-ready"));
  })());
}
