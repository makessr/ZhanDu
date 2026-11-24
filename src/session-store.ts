import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ServerMonitorSnapshot } from "./models";

export interface SessionDirectory {
  path: string;
  revision: number;
}

export interface SessionSlice {
  monitorSnapshot: ServerMonitorSnapshot | null;
  sftpCurrentPath: string;
  sftpRefreshRequest: number;
  terminalCurrentDirectory: SessionDirectory | null;
  terminalRecentOutput: string;
}

export const EMPTY_SESSION_SLICE: SessionSlice = Object.freeze({
  monitorSnapshot: null,
  sftpCurrentPath: "",
  sftpRefreshRequest: 0,
  terminalCurrentDirectory: null,
  terminalRecentOutput: "",
});

export type SessionAction =
  | { type: "monitor-snapshot"; snapshot: ServerMonitorSnapshot | null }
  | { type: "sftp-path"; path: string }
  | { type: "sftp-refresh" }
  | { type: "terminal-directory"; path: string }
  | { type: "terminal-output"; output: string };

export function sessionReducer(slice: SessionSlice, action: SessionAction): SessionSlice {
  switch (action.type) {
    case "monitor-snapshot": {
      if (action.snapshot === null) {
        return slice.monitorSnapshot === null ? slice : { ...slice, monitorSnapshot: null };
      }
      return slice.monitorSnapshot === action.snapshot
        ? slice
        : { ...slice, monitorSnapshot: action.snapshot };
    }
    case "sftp-path":
      return slice.sftpCurrentPath === action.path
        ? slice
        : { ...slice, sftpCurrentPath: action.path };
    case "sftp-refresh":
      return { ...slice, sftpRefreshRequest: slice.sftpRefreshRequest + 1 };
    case "terminal-directory":
      if (!action.path) {
        return slice.terminalCurrentDirectory === null
          ? slice
          : { ...slice, terminalCurrentDirectory: null };
      }
      // Prompt hooks report the current directory even when it hasn't changed.
      if (slice.terminalCurrentDirectory?.path === action.path) return slice;
      return {
        ...slice,
        terminalCurrentDirectory: {
          path: action.path,
          revision: (slice.terminalCurrentDirectory?.revision ?? 0) + 1,
        },
      };
    case "terminal-output":
      return slice.terminalRecentOutput === action.output
        ? slice
        : { ...slice, terminalRecentOutput: action.output };
  }
}

export interface SessionStore {
  dispatch: (action: SessionAction) => void;
  getSlice: () => SessionSlice;
  subscribe: (listener: () => void) => () => void;
}

export function createSessionStore(initial: SessionSlice = EMPTY_SESSION_SLICE): SessionStore {
  let slice = initial;
  const listeners = new Set<() => void>();
  return {
    dispatch: (action) => {
      const next = sessionReducer(slice, action);
      if (next === slice) return;
      slice = next;
      for (const listener of listeners) listener();
    },
    getSlice: () => slice,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface SessionStoreRegistry {
  delete: (sessionId: string) => void;
  get: (sessionId: string) => SessionStore;
  peek: (sessionId: string) => SessionStore | undefined;
}

export function createSessionStoreRegistry(): SessionStoreRegistry {
  const stores = new Map<string, SessionStore>();
  return {
    delete: (sessionId) => {
      stores.delete(sessionId);
    },
    get: (sessionId) => {
      let store = stores.get(sessionId);
      if (!store) {
        store = createSessionStore();
        stores.set(sessionId, store);
      }
      return store;
    },
    peek: (sessionId) => stores.get(sessionId),
  };
}

function subscribeToNothing() {
  return () => undefined;
}

export function useSessionField<T>(
  store: SessionStore | null,
  select: (slice: SessionSlice) => T,
  fallback: T,
): T {
  const selectRef = useRef(select);
  selectRef.current = select;
  const getSnapshot = useCallback(
    () => (store ? selectRef.current(store.getSlice()) : fallback),
    [fallback, store],
  );
  return useSyncExternalStore(store?.subscribe ?? subscribeToNothing, getSnapshot, getSnapshot);
}
