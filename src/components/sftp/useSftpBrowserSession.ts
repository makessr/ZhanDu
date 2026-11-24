import { useCallback, useEffect, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpConnectResult, SftpEntry, SftpListResult, TerminalSession } from "../../models";
import { commandErrorMessage } from "../../tauri-protocol";
import {
  isTerminalSessionOperational,
  jumpHostRequest,
  sshCredentialId,
} from "../../terminal-utils";
import { isSftpSessionFailure } from "./sftpErrors";

export type BrowserStatus = "idle" | "connecting" | "loading" | "ready" | "failed";

export interface BrowserState {
  status: BrowserStatus;
  path: string;
  inputPath: string;
  entries: SftpEntry[];
  previewEntries?: SftpEntry[];
  error?: string;
  followError?: { path: string; message: string };
}

export const INITIAL_BROWSER: BrowserState = {
  status: "idle",
  path: "/",
  inputPath: "/",
  entries: [],
};

type DirectoryLoadReason = "manual" | "initial" | "terminal";

interface UseSftpBrowserSessionOptions {
  currentPathChange: (sessionId: string | null, path: string) => void;
  recordVisitedPath: (hostId: string, path: string) => void;
  refreshRequest: number;
  session: TerminalSession | null;
  terminalDirectory?: { path: string; revision: number };
}

export default function useSftpBrowserSession({
  currentPathChange,
  recordVisitedPath,
  refreshRequest,
  session,
  terminalDirectory,
}: UseSftpBrowserSessionOptions) {
  const [browsers, setBrowsers] = useState<Record<string, BrowserState>>({});
  const [retryingSessionId, setRetryingSessionId] = useState<string>();
  const connectingRef = useRef(new Set<string>());
  const directoryRequestsRef = useRef(new Map<string, symbol>());
  const connectedHomesRef = useRef(new Map<string, string>());
  const handledRefreshRequestsRef = useRef<Record<string, number>>({});
  const handledTerminalDirectoryRevisionsRef = useRef(new Map<string, number>());
  const browsersRef = useRef(browsers);
  const sessionHostIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    browsersRef.current = browsers;
  }, [browsers]);

  if (session) {
    sessionHostIdsRef.current.set(session.id, session.host.id);
  }

  const updateBrowser = useCallback((sessionId: string, values: Partial<BrowserState>) => {
    if (values.status === "idle" || values.status === "failed") {
      directoryRequestsRef.current.delete(sessionId);
      values = { ...values, previewEntries: undefined, followError: undefined };
    }
    if (values.status === "idle") {
      handledTerminalDirectoryRevisionsRef.current.delete(sessionId);
    }
    setBrowsers((current) => ({
      ...current,
      [sessionId]: {
        ...(current[sessionId] ?? INITIAL_BROWSER),
        ...values,
      },
    }));
  }, []);

  const loadDirectory = useCallback(
    async (sessionId: string, path: string, reason: DirectoryLoadReason = "manual") => {
      const initial = reason === "initial";
      const requests = directoryRequestsRef.current;
      const request = Symbol();
      requests.set(sessionId, request);
      updateBrowser(sessionId, {
        status: initial ? "connecting" : "loading",
        inputPath: path,
        error: undefined,
        followError: undefined,
        previewEntries: undefined,
      });
      const onBatch = new Channel<SftpEntry[]>((batch) => {
        if (requests.get(sessionId) !== request) return;
        setBrowsers((current) => {
          const browser = current[sessionId];
          if (!browser) return current;
          return {
            ...current,
            [sessionId]: {
              ...browser,
              previewEntries: [...(browser.previewEntries ?? []), ...batch],
            },
          };
        });
      });
      try {
        const result = await invoke<SftpListResult>("sftp_list_preview", {
          sessionId,
          path,
          onBatch,
        });
        if (requests.get(sessionId) !== request) return;
        updateBrowser(sessionId, {
          status: "ready",
          path: result.path,
          inputPath: result.path,
          entries: result.entries,
          previewEntries: undefined,
          error: undefined,
        });
        const hostId = sessionHostIdsRef.current.get(sessionId);
        if (hostId) recordVisitedPath(hostId, result.path);
      } catch (error) {
        if (requests.get(sessionId) !== request) return;
        const message = commandErrorMessage(error);
        if (initial || isSftpSessionFailure(message)) {
          updateBrowser(sessionId, { status: "failed", error: message });
        } else {
          setBrowsers((current) => {
            const previous = current[sessionId] ?? INITIAL_BROWSER;
            return {
              ...current,
              [sessionId]: {
                ...previous,
                status: "ready",
                inputPath: previous.path,
                previewEntries: undefined,
                followError: reason === "terminal" ? { path, message } : undefined,
              },
            };
          });
          if (reason === "manual") Message.error(message);
        }
      } finally {
        if (requests.get(sessionId) === request) requests.delete(sessionId);
      }
    },
    [recordVisitedPath, updateBrowser],
  );

  const connectAndLoad = useCallback(
    async (currentSession: TerminalSession) => {
      if (connectingRef.current.has(currentSession.id)) return;
      connectingRef.current.add(currentSession.id);
      updateBrowser(currentSession.id, {
        status: "connecting",
        error: undefined,
      });

      try {
        if (!isTauri()) {
          throw new Error("SFTP 仅在桌面应用中可用");
        }

        let homeDir = connectedHomesRef.current.get(currentSession.id);
        if (!homeDir) {
          const result = await invoke<SftpConnectResult>("sftp_connect", {
            request: {
              sessionId: currentSession.id,
              hostId: sshCredentialId(currentSession.host),
              address: currentSession.host.address,
              port: currentSession.host.port,
              username: currentSession.host.username,
              authMethod: currentSession.host.authMethod,
              privateKeyPath: currentSession.host.privateKeyPath,
              connectTimeoutSeconds: currentSession.host.connectTimeoutSeconds,
              keepAliveIntervalSeconds: currentSession.host.keepAliveIntervalSeconds,
              expectedFingerprint:
                currentSession.fingerprint ?? currentSession.host.hostFingerprint,
              proxy: currentSession.proxy,
              jumpHost: jumpHostRequest(currentSession.jumpHost),
            },
          });
          homeDir = result.homeDir;
          connectedHomesRef.current.set(currentSession.id, homeDir);
        }
        await loadDirectory(currentSession.id, homeDir, "initial");
      } catch (error) {
        updateBrowser(currentSession.id, {
          status: "failed",
          error: commandErrorMessage(error),
        });
      } finally {
        connectingRef.current.delete(currentSession.id);
      }
    },
    [loadDirectory, updateBrowser],
  );

  const disconnectSession = useCallback(
    (sessionId: string) => {
      const wasConnected = connectedHomesRef.current.delete(sessionId);
      const wasConnecting = connectingRef.current.delete(sessionId);
      if (!wasConnected && !wasConnecting) return false;
      void invoke("sftp_disconnect", { sessionId }).catch(() => undefined);
      updateBrowser(sessionId, {
        status: "idle",
        entries: [],
        error: undefined,
      });
      return true;
    },
    [updateBrowser],
  );

  const markSessionFailed = useCallback(
    (sessionId: string, message: string) => {
      connectedHomesRef.current.delete(sessionId);
      updateBrowser(sessionId, { status: "failed", error: message });
    },
    [updateBrowser],
  );

  const isSessionReady = useCallback(
    (sessionId: string) => connectedHomesRef.current.has(sessionId),
    [],
  );

  useEffect(() => {
    if (!session || refreshRequest <= 0) return;
    if ((handledRefreshRequestsRef.current[session.id] ?? 0) >= refreshRequest) {
      return;
    }
    const current = browsersRef.current[session.id];
    if (!current || current.status !== "ready") return;
    handledRefreshRequestsRef.current[session.id] = refreshRequest;
    void loadDirectory(session.id, current.path);
  }, [loadDirectory, refreshRequest, session]);

  const browser = session ? (browsers[session.id] ?? INITIAL_BROWSER) : null;
  const connected = Boolean(session && isTerminalSessionOperational(session.status));
  const ready = Boolean(connected && browser?.status === "ready");
  const busy = browser?.status === "connecting" || browser?.status === "loading";
  const sftpReconnecting = retryingSessionId === session?.id;
  const reconnecting = session?.status === "reconnecting" || sftpReconnecting;
  const sessionUnavailable = Boolean(
    session && (session.status === "failed" || session.status === "disconnected" || reconnecting),
  );
  const sftpUnavailable = Boolean(connected && browser?.status === "failed");
  const connectionUnavailable = sessionUnavailable || sftpUnavailable;
  const connectionDescription = sftpReconnecting
    ? "正在重新连接 SFTP"
    : reconnecting
      ? "正在重新连接服务器"
      : sftpUnavailable
        ? browser?.error || "SFTP 连接失败"
        : session?.error || "服务器连接已断开";

  useEffect(() => {
    if (!session || !connected) return;
    if (!terminalDirectory) {
      handledTerminalDirectoryRevisionsRef.current.delete(session.id);
      return;
    }
    if (browser?.status !== "ready") return;
    if (
      handledTerminalDirectoryRevisionsRef.current.get(session.id) === terminalDirectory.revision
    ) {
      return;
    }
    handledTerminalDirectoryRevisionsRef.current.set(session.id, terminalDirectory.revision);
    if (browser.path !== terminalDirectory.path) {
      void loadDirectory(session.id, terminalDirectory.path, "terminal");
    } else if (browser.followError) {
      updateBrowser(session.id, { followError: undefined });
    }
  }, [
    browser?.followError,
    browser?.path,
    browser?.status,
    connected,
    loadDirectory,
    session,
    terminalDirectory,
    updateBrowser,
  ]);

  useEffect(() => {
    currentPathChange(session?.id ?? null, browser?.status === "ready" ? browser.path : "");
  }, [browser?.path, browser?.status, currentPathChange, session?.id]);

  const retryConnection = useCallback(async () => {
    if (!session) return;
    setRetryingSessionId(session.id);
    try {
      connectedHomesRef.current.delete(session.id);
      await invoke("sftp_disconnect", { sessionId: session.id }).catch(() => undefined);
      updateBrowser(session.id, { status: "idle", error: undefined });
      await connectAndLoad(session);
    } finally {
      setRetryingSessionId((current) => (current === session.id ? undefined : current));
    }
  }, [connectAndLoad, session, updateBrowser]);

  const connectCurrentSession = useCallback(() => {
    if (session) void connectAndLoad(session);
  }, [connectAndLoad, session]);

  return {
    browser,
    browsersRef,
    busy,
    connected,
    connectionDescription,
    connectionUnavailable,
    connectCurrentSession,
    disconnectSession,
    isSessionReady,
    loadDirectory,
    markSessionFailed,
    ready,
    reconnecting,
    retryConnection,
    sftpUnavailable,
    updateBrowser,
  };
}
