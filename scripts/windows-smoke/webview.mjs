import { setTimeout as delay } from "node:timers/promises";

export async function until(label, action, timeout = 45_000) {
  const end = Date.now() + timeout;
  let failure;
  while (Date.now() < end) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      failure = error;
    }
    await delay(300);
  }
  throw new Error(label + " timed out", { cause: failure });
}

export async function devTools(view, method, params) {
  const socket = new WebSocket(view);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("WebView evaluation timed out")), 8_000);
    function finish(error, result) {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }
    socket.addEventListener("error", () => finish(new Error("WebView connection failed")), { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })), { once: true });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      if (message.error || message.result.exceptionDetails) {
        finish(new Error(message.result?.exceptionDetails?.exception?.description ?? message.error?.message));
      } else {
        finish(null, message.result);
      }
    });
  });
}

export async function evaluate(view, fn, ...args) {
  const result = await devTools(view, "Runtime.evaluate", {
    expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result.value;
}

export function findWindow(port, label) {
  return until("FineShell " + label + " window", async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1500) });
    for (const item of await response.json()) {
      if (item.type !== "page" || !item.webSocketDebuggerUrl) continue;
      const view = new URL(item.webSocketDebuggerUrl);
      if (view.protocol !== "ws:" || view.hostname !== "127.0.0.1" || view.port !== String(port)) continue;
      const current = await evaluate(view, () => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label);
      if (current === label) return view;
    }
  });
}

export function invoke(view, command, args) {
  return evaluate(view, async (command, args) => {
    try {
      return await window.__TAURI_INTERNALS__.invoke(command, args);
    } catch (error) {
      throw new Error(error?.message ?? String(error));
    }
  }, command, args);
}
