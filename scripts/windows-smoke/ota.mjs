import assert from "node:assert/strict";
import { evaluate, findWindow, invoke, until } from "./webview.mjs";

const [phase, port, baseline, target, marker] = process.argv.slice(2);
if (
  !["update", "verify"].includes(phase) ||
  !port ||
  !baseline ||
  !target ||
  !marker ||
  baseline === target
) {
  throw new Error(
    "Usage: node ota.mjs <update|verify> <port> <old-version> <new-version> <marker>",
  );
}
const view = await findWindow(port, "main");
const version = await invoke(view, "plugin:app|version");
const key = "fineshell-ota-smoke-marker";

if (phase === "update") {
  assert.equal(version, baseline);
  await evaluate(view, (key, marker) => localStorage.setItem(key, marker), key, marker);
  await until(
    "Application update dialog",
    () =>
      evaluate(
        view,
        (baseline, target) => {
          const modal = document.querySelector(".startup-update-modal");
          if (
            !modal?.textContent.includes("v" + baseline) ||
            !modal.textContent.includes("v" + target)
          )
            return false;
          const button = [...modal.querySelectorAll("button")].find(
            (item) => item.textContent.trim() === "立即更新",
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        baseline,
        target,
      ),
    90_000,
  );
  console.log("应用从正式更新渠道发现新版本，已触发应用内更新。");
} else {
  assert.equal(version, target);
  assert.equal(await evaluate(view, (key) => localStorage.getItem(key), key), marker);
  console.log("应用内更新成功，本地测试配置保留。");
}
