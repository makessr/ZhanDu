import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { createSessionStore } from "../session-store";
import type { AiContextSource } from "../ai-utils";
import AiContextSourcesBridge from "./AiContextSourcesBridge";

function renderBridge(
  store: ReturnType<typeof createSessionStore>,
  props: Partial<Parameters<typeof AiContextSourcesBridge>[0]> = {},
) {
  const seen: AiContextSource[][] = [];
  const result = render(
    <AiContextSourcesBridge
      businessContexts={[]}
      remoteFileContexts={[]}
      sessionId="session-1"
      store={store}
      terminalSelection=""
      {...props}
    >
      {(sources) => {
        seen.push(sources);
        return <span data-testid="sources">{sources.map((source) => source.id).join(",")}</span>;
      }}
    </AiContextSourcesBridge>,
  );
  return { ...result, seen };
}

describe("AiContextSourcesBridge", () => {
  test("combines session store fields with handoff context", () => {
    const store = createSessionStore();
    store.dispatch({ type: "terminal-output", output: "systemctl status app" });
    store.dispatch({ type: "sftp-path", path: "/srv/app" });
    const { seen } = renderBridge(store, {
      businessContexts: [{ content: "nginx.conf", id: "process-selection", label: "业务上下文" }],
      remoteFileContexts: [
        { content: "port 80", name: "app.conf", path: "/srv/app.conf", size: 8 },
      ],
      terminalSelection: "selected line",
    });

    const latest = seen[seen.length - 1] ?? [];
    expect(latest.map((source) => source.id)).toEqual([
      "terminal-selection",
      "terminal-output",
      "server-monitor",
      "sftp-path",
      "process-selection",
      "sftp-file:/srv/app.conf",
    ]);
    expect(latest[1].content).toBe("systemctl status app");
    expect(latest[3].content).toBe("/srv/app");
  });

  test("re-renders when a subscribed field changes", () => {
    const store = createSessionStore();
    const { seen } = renderBridge(store);
    const before = seen.length;

    act(() => {
      store.dispatch({ type: "terminal-output", output: "tail -f app.log" });
    });

    expect(seen.length).toBeGreaterThan(before);
    expect(seen[seen.length - 1]?.[1].content).toBe("tail -f app.log");
  });

  test("ignores session fields the AI context does not read", () => {
    const store = createSessionStore();
    const { seen } = renderBridge(store);
    const before = seen.length;

    act(() => {
      store.dispatch({ type: "sftp-refresh" });
      store.dispatch({ type: "terminal-directory", path: "/var/log" });
    });

    expect(seen.length).toBe(before);
    expect(screen.getByTestId("sources").textContent).toBe(
      "terminal-selection,terminal-output,server-monitor,sftp-path",
    );
  });
});
