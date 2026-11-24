import { describe, expect, mock, test } from "bun:test";
import {
  EMPTY_SESSION_SLICE,
  createSessionStore,
  createSessionStoreRegistry,
  sessionReducer,
  type SessionAction,
} from "./session-store";

function apply(...actions: SessionAction[]) {
  return actions.reduce(sessionReducer, EMPTY_SESSION_SLICE);
}

describe("sessionReducer", () => {
  test("keeps the slice identity for repeated values", () => {
    const directory = apply({ type: "terminal-directory", path: "/srv" });
    const slice = apply(
      { type: "terminal-output", output: "ready" },
      { type: "sftp-path", path: "/srv/app" },
      { type: "terminal-directory", path: "/srv" },
      { type: "monitor-snapshot", snapshot: null },
      { type: "terminal-output", output: "ready" },
      { type: "sftp-path", path: "/srv/app" },
      { type: "terminal-directory", path: "/srv" },
    );
    expect(slice.terminalRecentOutput).toBe("ready");
    expect(slice.sftpCurrentPath).toBe("/srv/app");
    expect(slice.terminalCurrentDirectory?.revision).toBe(1);
    expect(slice.terminalCurrentDirectory?.path).toBe(directory.terminalCurrentDirectory?.path);

    expect(sessionReducer(slice, { type: "terminal-output", output: "ready" })).toBe(slice);
    expect(sessionReducer(slice, { type: "sftp-path", path: "/srv/app" })).toBe(slice);
    expect(sessionReducer(slice, { type: "terminal-directory", path: "/srv" })).toBe(slice);
    expect(sessionReducer(slice, { type: "monitor-snapshot", snapshot: null })).toBe(slice);
  });

  test("clears path fields with empty values", () => {
    const withValues = apply(
      { type: "sftp-path", path: "/srv/app" },
      { type: "terminal-directory", path: "/srv/app" },
    );
    const cleared = apply(
      { type: "sftp-path", path: "/srv/app" },
      { type: "terminal-directory", path: "/srv/app" },
      { type: "sftp-path", path: "" },
      { type: "terminal-directory", path: "" },
    );
    expect(withValues.sftpCurrentPath).toBe("/srv/app");
    expect(cleared.sftpCurrentPath).toBe("");
    expect(cleared.terminalCurrentDirectory).toBeNull();
    expect(sessionReducer(cleared, { type: "terminal-directory", path: "" })).toBe(cleared);
  });

  test("bumps the directory revision only when the path changes", () => {
    const first = apply({ type: "terminal-directory", path: "/srv" });
    const second = sessionReducer(first, { type: "terminal-directory", path: "/var/log" });
    expect(second.terminalCurrentDirectory).toEqual({ path: "/var/log", revision: 2 });
  });

  test("increments the sftp refresh counter", () => {
    expect(apply({ type: "sftp-refresh" }, { type: "sftp-refresh" }).sftpRefreshRequest).toBe(2);
  });
});

describe("createSessionStore", () => {
  test("notifies subscribers only when the slice changes", () => {
    const store = createSessionStore();
    const listener = mock(() => undefined);
    const unsubscribe = store.subscribe(listener);

    store.dispatch({ type: "terminal-output", output: "line" });
    store.dispatch({ type: "terminal-output", output: "line" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.dispatch({ type: "sftp-refresh" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("registers and forgets stores per session", () => {
    const registry = createSessionStoreRegistry();
    const first = registry.get("session-1");
    expect(registry.get("session-1")).toBe(first);
    expect(registry.peek("session-2")).toBeUndefined();

    first.dispatch({ type: "terminal-output", output: "partial" });
    registry.delete("session-1");
    expect(registry.peek("session-1")).toBeUndefined();
    expect(registry.get("session-1").getSlice().terminalRecentOutput).toBe("");
  });
});
