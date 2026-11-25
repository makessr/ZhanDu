import { WorkspaceToolPanel, type WorkspaceTool } from "./components/WorkspaceToolPanel";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Button, Message, Typography } from "@arco-design/web-react";
import { isTauri } from "@tauri-apps/api/core";
import {
  IconClose,
  IconCloseCircle,
  IconLeft,
  IconPlus,
  IconPoweroff,
  IconRefresh,
} from "@arco-design/web-react/icon";
import type { ServerMonitorSnapshot, TerminalSession } from "./models";
import type { ContextMenuItem } from "./components/ContextMenu";
import HostManagerPanel from "./components/HostManagerPanel";
import QuickCommandDrawer from "./components/QuickCommandDrawer";
import SftpPanel from "./components/SftpPanel";
import SessionTabs from "./components/SessionTabs";
import { resolveWorkspaceConnection } from "./terminal-workspaces";
import AppWorkspaceLayout from "./components/AppWorkspaceLayout";
import AiContextSourcesBridge from "./components/AiContextSourcesBridge";
import ApplicationTitleBar from "./components/ApplicationTitleBar";
import LocalDataUnlock from "./components/LocalDataUnlock";
import { LocalDataLockedError, unlockLocalData } from "./local-encryption";
export { default as CollapsibleSplitTrigger } from "./components/CollapsibleSplitTrigger";
import { loadConfiguration, type FineShellConfiguration } from "./config-database";
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings, type AppSettings } from "./app-settings";
import { readAppearanceModeHint, setAppearanceMode } from "./appearance";
import {
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
  mergeAiRemoteFileContexts,
} from "./ai-utils";
import {
  createSessionStoreRegistry,
  useSessionField,
  type SessionStoreRegistry,
} from "./session-store";
import { createSftpSelectionAiHandoff } from "./ai-handoff";
import { AI_SIDEBAR_DEFAULT_WIDTH } from "./ai-sidebar";
import { useAiSidebarController } from "./hooks/useAiSidebarController";
import useAiHandoffController from "./hooks/useAiHandoffController";
import {
  applicationUpdater,
  checkForApplicationUpdateOnStartup,
  restoreApplicationFocusAfterUpdateRelaunch,
  setApplicationUpdateNotice,
} from "./app-updater";
import { isTerminalSessionOperational } from "./terminal-utils";
import {
  nextTerminalFontSizeOffset,
  terminalFontSize,
  type TerminalFontZoomAction,
} from "./terminal-font-zoom";
import {
  configureDiagnosticLogging,
  diagnosticInvoke as invoke,
  recordDiagnostic,
} from "./diagnostics";
import {
  commandErrorMessage,
  FineShellCommandError,
  listenProtocolEvent,
  type AgentActionExecutionResult,
  verifyProtocolVersion,
} from "./tauri-protocol";
import { openAuxiliaryWindow, promptStartupApplicationUpdate } from "./app-window-actions";
import { finishWorkspaceStartup } from "./workspace-startup";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
const QuickCommandSettings = lazy(() => import("./components/QuickCommandSettings"));
const ServerMonitorPanel = lazy(() => import("./components/ServerMonitorPanel"));
const loadAiAssistantPanel = () => import("./components/AiAssistantPanel");
const AiAssistantPanel = lazy(loadAiAssistantPanel);
const TerminalView = lazy(() => import("./components/TerminalView"));
const SERVER_MONITOR_COLLAPSED_KEY = "fineshell:server-monitor-collapsed";

function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [localDataState, setLocalDataState] = useState<"checking" | "locked" | "unlocked">(
    "checking",
  );
  const [localDataError, setLocalDataError] = useState<string>();
  const [configurationLoadAttempt, setConfigurationLoadAttempt] = useState(0);
  const savedAppearanceRef = useRef<AppSettings["appearanceMode"]>();
  const [commandLibrary, setCommandLibrary] = useState<
    Pick<FineShellConfiguration, "quickCommands" | "quickCommandGroups">
  >({
    quickCommands: [],
    quickCommandGroups: [],
  });
  const applyCommandLibrary = useCallback(
    ({ quickCommands, quickCommandGroups }: FineShellConfiguration) => {
      setCommandLibrary({ quickCommands, quickCommandGroups });
    },
    [],
  );
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool>("files");
  const [workspaceToolTarget, setWorkspaceToolTarget] = useState<HTMLDivElement | null>(null);
  const [editingQuickCommands, setEditingQuickCommands] = useState(false);
  const [serverMonitorCollapsed, setServerMonitorCollapsed] = useState(
    () => localStorage.getItem(SERVER_MONITOR_COLLAPSED_KEY) === "true",
  );
  const [sftpCollapsed, setSftpCollapsed] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(AI_SIDEBAR_DEFAULT_WIDTH);
  const [aiInitialPrompt, setAiInitialPrompt] = useState("");
  const [aiInitialContextIds, setAiInitialContextIds] = useState<AiContextSourceId[]>([]);
  const [aiInitialPromptRequest, setAiInitialPromptRequest] = useState(0);
  const [terminalSelections, setTerminalSelections] = useState<Record<string, string>>({});
  const sessionStoresRef = useRef<SessionStoreRegistry | null>(null);
  if (!sessionStoresRef.current) sessionStoresRef.current = createSessionStoreRegistry();
  const sessionStores = sessionStoresRef.current;
  const [aiRemoteFileContexts, setAiRemoteFileContexts] = useState<
    Record<string, AiRemoteFileContext[]>
  >({});
  const [aiBusinessContexts, setAiBusinessContexts] = useState<Record<string, AiContextSource[]>>(
    {},
  );
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [terminalFontSizeOffset, setTerminalFontSizeOffset] = useState(0);
  const mainSplitRef = useRef<HTMLElement | null>(null);
  const handleSessionsClosed = useCallback(
    (closingIds: Set<string>) => {
      for (const sessionId of closingIds) sessionStores.delete(sessionId);
      setAiRemoteFileContexts((currentContexts) =>
        Object.fromEntries(
          Object.entries(currentContexts).filter(([sessionId]) => !closingIds.has(sessionId)),
        ),
      );
      setAiBusinessContexts((currentContexts) =>
        Object.fromEntries(
          Object.entries(currentContexts).filter(([sessionId]) => !closingIds.has(sessionId)),
        ),
      );
    },
    [sessionStores],
  );
  const {
    activeSession,
    activeSessionId,
    closeSession,
    closeSessions,
    disconnectSession,
    openSession,
    reconnectSession,
    sessions,
    setActiveSessionId,
    syncKnownHostFingerprints,
    updatePortForwardStatus,
  } = useTerminalSessions({ onSessionsClosed: handleSessionsClosed });
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeSessionStore = useMemo(
    () => (activeSessionId ? sessionStores.get(activeSessionId) : null),
    [activeSessionId, sessionStores],
  );
  const sftpRefreshRequest = useSessionField(
    activeSessionStore,
    (slice) => slice.sftpRefreshRequest,
    0,
  );
  const terminalCurrentDirectory = useSessionField(
    activeSessionStore,
    (slice) => slice.terminalCurrentDirectory,
    null,
  );
  const {
    active: aiAssistantActive,
    close: closeAiSidebar,
    frozenWorkspaceWidth: mainWorkspaceFrozenWidth,
    mounted: aiAssistantMounted,
    open: openAiSidebar,
    phase: aiSidebarPhase,
    visible: aiAssistantVisible,
  } = useAiSidebarController({
    getWorkspaceWidth: () => mainSplitRef.current?.getBoundingClientRect().width,
    onResizeFailure: (error, operation) => {
      recordDiagnostic(
        "warn",
        "application.window",
        operation === "expand" ? "AI 侧栏窗口扩宽失败" : "AI 侧栏窗口还原失败",
        { error: commandErrorMessage(error) },
      );
      Message.warning(
        operation === "expand"
          ? "窗口无法扩宽，AI 助手已在当前窗口内打开"
          : "窗口尺寸无法自动还原，请手动调整",
      );
    },
    sidebarWidth: aiSidebarWidth,
  });
  const openAiAssistant = useCallback(
    async (sessionId: string, prompt = "", contextIds: AiContextSourceId[] = []) => {
      if (activeSessionIdRef.current !== sessionId) return false;
      await loadAiAssistantPanel();
      if (activeSessionIdRef.current !== sessionId) return false;
      setAiInitialPrompt(prompt);
      setAiInitialContextIds(contextIds);
      setAiInitialPromptRequest((current) => current + 1);
      await openAiSidebar();
      return true;
    },
    [openAiSidebar],
  );
  const showAiHandoffNotice = useCallback((type: "error" | "warning", content: string) => {
    Message[type](content);
  }, []);
  const { handoffContext, handoffRemoteFiles, handoffTerminalSelection } = useAiHandoffController({
    activeSession,
    businessContexts: aiBusinessContexts,
    onNotice: showAiHandoffNotice,
    openAssistant: openAiAssistant,
    remoteFileContexts: aiRemoteFileContexts,
    setBusinessContexts: setAiBusinessContexts,
    setRemoteFileContexts: setAiRemoteFileContexts,
    setTerminalSelections,
    terminalSelections,
  });
  const previousAiSidebarPhaseRef = useRef(aiSidebarPhase);

  const runtimeTerminalFontSize = terminalFontSize(
    settings.terminalFontSize,
    terminalFontSizeOffset,
  );
  const zoomTerminalFont = useCallback(
    (action: TerminalFontZoomAction) => {
      setTerminalFontSizeOffset((currentOffset) =>
        nextTerminalFontSizeOffset(settings.terminalFontSize, currentOffset, action),
      );
    },
    [settings.terminalFontSize],
  );

  useEffect(() => {
    setTerminalFontSizeOffset(0);
  }, [settings.terminalFontSize]);

  useEffect(() => {
    if (aiSidebarPhase === "closed" && previousAiSidebarPhaseRef.current !== "closed") {
      setTerminalFocusRequest((current) => current + 1);
    }
    previousAiSidebarPhaseRef.current = aiSidebarPhase;
  }, [aiSidebarPhase]);

  const updateMonitorSnapshot = useCallback(
    (sessionId: string | null, snapshot: ServerMonitorSnapshot | null) => {
      if (!sessionId) return;
      sessionStores.get(sessionId).dispatch({ type: "monitor-snapshot", snapshot });
    },
    [sessionStores],
  );

  const updateSftpCurrentPath = useCallback(
    (sessionId: string | null, path: string) => {
      if (!sessionId) return;
      sessionStores.get(sessionId).dispatch({ type: "sftp-path", path });
    },
    [sessionStores],
  );

  const updateTerminalCurrentDirectory = useCallback(
    (sessionId: string, path: string) => {
      sessionStores.get(sessionId).dispatch({ type: "terminal-directory", path });
    },
    [sessionStores],
  );

  useEffect(() => {
    let disposed = false;
    setLocalDataState("checking");
    const protocolReady = isTauri()
      ? verifyProtocolVersion().then(() => undefined)
      : Promise.resolve();
    void protocolReady
      .then(() => loadConfiguration())
      .then((configuration) => {
        if (disposed) return;
        setSettings(configuration.settings);
        savedAppearanceRef.current = configuration.settings.appearanceMode;
        setAppearanceMode(configuration.settings.appearanceMode, {
          persist: true,
        });
        applyCommandLibrary(configuration);
        setLocalDataState("unlocked");
      })
      .catch((error) => {
        if (disposed) return;
        if (error instanceof LocalDataLockedError) {
          setLocalDataState("locked");
          return;
        }
        setLocalDataState("unlocked");
        const message = commandErrorMessage(error);
        recordDiagnostic("warn", "configuration", "应用设置读取失败", {
          error: message,
        });
        if (error instanceof FineShellCommandError && error.operation === "protocol_version") {
          Message.error(message);
        } else {
          Message.warning("设置读取失败，已使用默认值");
        }
      });
    return () => {
      disposed = true;
    };
  }, [applyCommandLibrary, configurationLoadAttempt]);

  useEffect(() => {
    if (localDataState === "checking") return;
    let disposed = false;
    void finishWorkspaceStartup()
      .then(() => !disposed && restoreApplicationFocusAfterUpdateRelaunch())
      .then((focused) => {
        if (focused) {
          recordDiagnostic("info", "application.update", "更新重启后主窗口已恢复前台");
        }
      })
      .catch((error) => {
        recordDiagnostic("warn", "application.update", "更新重启后主窗口聚焦失败", {
          error: commandErrorMessage(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [localDataState]);

  useEffect(() => () => document.body.classList.remove("ai-sidebar-resizing"), []);

  useEffect(() => {
    if (!applicationUpdater.canInstallUpdates) return;
    void checkForApplicationUpdateOnStartup()
      .then((update) => {
        setApplicationUpdateNotice(update);
        if (update) promptStartupApplicationUpdate(update);
      })
      .catch((error) => {
        recordDiagnostic("warn", "application.update", "启动更新检查失败", {
          error: commandErrorMessage(error),
        });
      });
  }, []);

  useEffect(() => {
    void configureDiagnosticLogging(settings.diagnosticLogLevel).catch((error) => {
      recordDiagnostic("warn", "diagnostics", "日志级别同步失败", {
        error: commandErrorMessage(error),
      });
    });
  }, [settings.diagnosticLogLevel]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void loadConfiguration()
        .then((configuration) => {
          if (disposed) return;
          applyCommandLibrary(configuration);
          syncKnownHostFingerprints(configuration.knownHosts);
        })
        .catch((error) => {
          if (!disposed) {
            recordDiagnostic("warn", "configuration", "配置刷新失败", {
              error: commandErrorMessage(error),
            });
            Message.warning("快捷命令读取失败");
          }
        });
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyCommandLibrary, syncKnownHostFingerprints]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const listeners: Array<() => void> = [];
    const keepListener = (stop: () => void) => {
      if (disposed) stop();
      else listeners.push(stop);
    };
    void listenProtocolEvent("appearance:preview", ({ payload }) => {
      setAppearanceMode(payload ?? savedAppearanceRef.current ?? readAppearanceModeHint());
    }).then(keepListener);
    void listenProtocolEvent("settings:changed", ({ payload }) => {
      const nextSettings = sanitizeAppSettings(payload);
      setSettings(nextSettings);
      savedAppearanceRef.current = nextSettings.appearanceMode;
      setAppearanceMode(nextSettings.appearanceMode, { persist: true });
    }).then(keepListener);
    void listenProtocolEvent("local-encryption:changed", () => {
      setLocalDataState("checking");
      setConfigurationLoadAttempt((attempt) => attempt + 1);
    }).then(keepListener);
    return () => {
      disposed = true;
      listeners.forEach((stop) => stop());
    };
  }, []);

  const openWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    setWorkspaceTool(tool);
    setSftpCollapsed(false);
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setWorkspaceTool("files");
      closeAiSidebar();
      return;
    }
    const handleQuickCommandShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceTool("commands");
      }
    };
    window.addEventListener("keydown", handleQuickCommandShortcut, true);
    return () => window.removeEventListener("keydown", handleQuickCommandShortcut, true);
  }, [activeSessionId, closeAiSidebar, openWorkspaceTool]);

  async function sendQuickCommand(command: string, execute: boolean, sessionId?: string) {
    const target = sessionId ? sessions.find((session) => session.id === sessionId) : activeSession;
    if (!target || !isTerminalSessionOperational(target.status)) {
      throw new Error("目标会话未连接");
    }
    const input = execute ? `${command}\r` : command;
    await invoke("ssh_write", {
      sessionId: target.id,
      data: Array.from(new TextEncoder().encode(input)),
    });
    if (target.id === activeSessionId) setTerminalFocusRequest((current) => current + 1);
    Message.success(
      execute ? `命令已发送到 ${target.host.name}` : `命令已填入 ${target.host.name} 的终端`,
    );
  }

  function handleAiAgentActionExecuted(sessionId: string, result: AgentActionExecutionResult) {
    if (result.actionType === "terminal_command") return;
    const updatedFile: AiRemoteFileContext | null = result.file
      ? {
          content: result.file.content,
          name: result.file.path.split("/").pop() || result.file.path,
          path: result.file.path,
          size: result.file.size,
        }
      : null;
    setAiRemoteFileContexts((current) => {
      const remaining = (current[sessionId] ?? []).filter(
        (file) => !result.affectedPaths.includes(file.path),
      );
      if (!updatedFile) {
        return { ...current, [sessionId]: remaining };
      }
      let nextFiles = remaining;
      try {
        nextFiles = mergeAiRemoteFileContexts(remaining, [updatedFile]);
      } catch {
        // The remote operation already succeeded; omit the optional AI context
        // when adding it would exceed the local context limits.
      }
      return {
        ...current,
        [sessionId]: nextFiles,
      };
    });
    sessionStores.get(sessionId).dispatch({ type: "sftp-refresh" });
  }

  async function toggleAiAssistant() {
    if (!activeSession) {
      Message.warning("请先打开终端会话");
      return;
    }
    if (aiAssistantActive) {
      await closeAiSidebar();
      return;
    }
    await loadAiAssistantPanel();
    await openAiSidebar();
  }

  function sessionContextMenuItems(session: TerminalSession): ContextMenuItem[] {
    const canDisconnect =
      session.status === "connecting" ||
      isTerminalSessionOperational(session.status) ||
      session.status === "reconnecting";
    const canReconnect = session.status !== "connecting" && session.status !== "reconnecting";

    return [
      {
        key: "open-new-session",
        label: "新开会话",
        icon: <IconPlus />,
        onClick: () => openSession(session.host, session.proxy, session.jumpHost),
      },
      {
        key: "disconnect",
        label: "断开连接",
        icon: <IconPoweroff />,
        disabled: !canDisconnect,
        dividerBefore: true,
        onClick: () => disconnectSession(session.id),
      },
      {
        key: "reconnect",
        label: "重新连接",
        icon: <IconRefresh />,
        disabled: !canReconnect,
        onClick: () => reconnectSession(session),
      },
      {
        key: "close",
        label: "关闭标签",
        icon: <IconClose />,
        dividerBefore: true,
        onClick: () => closeSession(session.id),
      },
      {
        key: "close-others",
        label: "关闭其他标签",
        icon: <IconCloseCircle />,
        disabled: sessions.length <= 1,
        onClick: () =>
          closeSessions(sessions.filter((item) => item.id !== session.id).map((item) => item.id)),
      },
      {
        key: "close-all",
        label: "关闭全部标签",
        icon: <IconCloseCircle />,
        onClick: () => closeSessions(sessions.map((item) => item.id)),
      },
    ];
  }

  const serverMonitorPanel = (
    <aside className="panel server-monitor-sidebar">
      <div className="server-monitor-content">
        {activeSession ? (
          <Suspense
            fallback={
              <div className="server-monitor-loading">
                <Typography.Text type="secondary">正在加载监控…</Typography.Text>
              </div>
            }
          >
            <ServerMonitorPanel
              tool={sftpCollapsed ? undefined : workspaceTool}
              toolTarget={workspaceToolTarget}
              ipRegionEnabled={settings.ipRegionEnabled}
              ipRegionIpv6={settings.ipRegionIpv6}
              onOpenSettings={() => openAuxiliaryWindow("settings")}
              onSelectTool={openWorkspaceTool}
              onReconnect={() => reconnectSession(activeSession)}
              onSendToAi={(sessionId, request) => void handoffContext(sessionId, request)}
              onSnapshotChange={updateMonitorSnapshot}
              onPortForwardStatusChange={(status) =>
                updatePortForwardStatus(activeSession.id, status)
              }
              refreshIntervalSeconds={settings.monitorRefreshIntervalSeconds}
              session={activeSession}
              visible={!serverMonitorCollapsed}
            />
          </Suspense>
        ) : (
          <section className="server-monitor is-unavailable">
            <Typography.Text type="secondary">打开主机会话后查看监控。</Typography.Text>
          </section>
        )}
      </div>
    </aside>
  );

  const terminalPanel = (
    <section className="panel terminal-panel">
      <SessionTabs
        activeSessionId={activeSessionId}
        aiAssistantVisible={aiAssistantActive}
        hasActiveSession={Boolean(activeSession)}
        homeContent={<HostManagerPanel onConnect={openSession} settings={settings} />}
        onActiveSessionChange={setActiveSessionId}
        onCloseSession={closeSession}
        onOpenWorkspace={async (hostIds) => {
          const configuration = await loadConfiguration();
          const targets = hostIds.map((id) => {
            const host = configuration.hosts.find((item) => item.id === id);
            if (!host) throw new Error("工作区包含已移除的主机，请重新保存工作区");
            return resolveWorkspaceConnection(host, configuration);
          });
          return targets.map((target) => openSession(...target));
        }}
        onToggleAiAssistant={toggleAiAssistant}
        renderSession={(session) => (
          <Suspense fallback={null}>
            <TerminalView
              active={session.id === activeSessionId}
              collectRecentOutput={session.id === activeSessionId && aiAssistantVisible}
              focusRequest={session.id === activeSessionId ? terminalFocusRequest : 0}
              onFontZoom={zoomTerminalFont}
              settings={settings}
              session={session}
              terminalFontSize={runtimeTerminalFontSize}
              onAskAi={(selection) => {
                void handoffTerminalSelection(session.id, selection);
              }}
              onCurrentDirectoryChange={updateTerminalCurrentDirectory}
              onReconnect={() => reconnectSession(session)}
              onRecentOutputChange={(output) =>
                sessionStores.get(session.id).dispatch({
                  type: "terminal-output",
                  output: output.slice(-settings.aiContextMaxChars),
                })
              }
              onSelectionChange={(selection) =>
                setTerminalSelections((current) =>
                  current[session.id] === selection.slice(0, settings.aiContextMaxChars)
                    ? current
                    : {
                        ...current,
                        [session.id]: selection.slice(0, settings.aiContextMaxChars),
                      },
                )
              }
            />
          </Suspense>
        )}
        sessionContextMenuItems={sessionContextMenuItems}
        sessions={sessions}
      />
    </section>
  );

  const sftpPanelCommands = useMemo<ComponentProps<typeof SftpPanel>["commands"]>(
    () => ({
      currentPathChange: updateSftpCurrentPath,
      reconnect: () => {
        if (activeSession) reconnectSession(activeSession);
      },
      sendFilesToAi: async (sessionId, files) => {
        await handoffRemoteFiles(sessionId, files);
      },
      sendSelectionToAi: async (sessionId, currentDirectory, entries) => {
        await handoffContext(sessionId, createSftpSelectionAiHandoff(currentDirectory, entries));
      },
      showFiles: () => openWorkspaceTool("files"),
      showTransfers: () => openWorkspaceTool("transfers"),
    }),
    [
      activeSession,
      handoffContext,
      handoffRemoteFiles,
      openWorkspaceTool,
      reconnectSession,
      updateSftpCurrentPath,
    ],
  );

  const sftpPanel = (
    <WorkspaceToolPanel activeTool={workspaceTool} onSelect={openWorkspaceTool}>
      <SftpPanel
        commands={sftpPanelCommands}
        filesVisible={workspaceTool === "files" && !sftpCollapsed}
        transfersVisible={workspaceTool === "transfers" && !sftpCollapsed}
        confirmFileDelete={settings.confirmFileDelete}
        externalEditorName={settings.externalEditorName}
        externalEditorPath={settings.externalEditorPath}
        sftpUploadRetryAttempts={settings.sftpUploadRetryAttempts}
        refreshRequest={sftpRefreshRequest}
        session={activeSession}
        showHiddenFiles={settings.showHiddenFiles}
        terminalDirectory={terminalCurrentDirectory ?? undefined}
      />
      <div
        className="workspace-tool-slot"
        hidden={!["tunnels", "processes", "network"].includes(workspaceTool)}
        ref={setWorkspaceToolTarget}
      />
      {workspaceTool === "commands" && !sftpCollapsed && (
        <>
          {editingQuickCommands && (
            <div className="workspace-tool-surface">
              <Button
                className="workspace-tool-back"
                icon={<IconLeft />}
                onClick={() => setEditingQuickCommands(false)}
                size="small"
              >
                返回快捷命令
              </Button>
              <Suspense fallback={null}>
                <QuickCommandSettings />
              </Suspense>
            </div>
          )}
          <QuickCommandDrawer
            canSend={Boolean(activeSession && isTerminalSessionOperational(activeSession.status))}
            commands={commandLibrary.quickCommands}
            savedGroups={commandLibrary.quickCommandGroups}
            embedded
            key={activeSessionId}
            onLibraryChange={applyCommandLibrary}
            onEdit={() => setEditingQuickCommands(true)}
            onSend={sendQuickCommand}
            targets={sessions
              .filter(
                (session) =>
                  session.id !== activeSessionId && isTerminalSessionOperational(session.status),
              )
              .map((session) => ({
                label: `${session.host.name} (${session.host.address})`,
                value: session.id,
              }))}
            visible={!editingQuickCommands}
          />
        </>
      )}
    </WorkspaceToolPanel>
  );

  const aiAssistantPanel = aiAssistantMounted ? (
    <Suspense fallback={<div className="ai-assistant-sidebar-panel" />}>
      <AiContextSourcesBridge
        businessContexts={activeSessionId ? (aiBusinessContexts[activeSessionId] ?? []) : []}
        remoteFileContexts={activeSessionId ? (aiRemoteFileContexts[activeSessionId] ?? []) : []}
        sessionId={activeSessionId}
        store={activeSessionStore}
        terminalSelection={activeSessionId ? (terminalSelections[activeSessionId] ?? "") : ""}
      >
        {(contextSources) => (
          <AiAssistantPanel
            canInsertCommand={Boolean(
              activeSession && isTerminalSessionOperational(activeSession.status),
            )}
            contextSources={contextSources}
            hostId={activeSession?.host.id ?? null}
            hostName={activeSession?.host.name ?? ""}
            initialPrompt={aiInitialPrompt}
            initialContextIds={aiInitialContextIds}
            initialPromptRequest={aiInitialPromptRequest}
            onAgentActionExecuted={handleAiAgentActionExecuted}
            onRemoveRemoteFile={(sessionId, path) =>
              setAiRemoteFileContexts((current) => {
                const remaining = (current[sessionId] ?? []).filter((file) => file.path !== path);
                if (remaining.length) {
                  return { ...current, [sessionId]: remaining };
                }
                const next = { ...current };
                delete next[sessionId];
                return next;
              })
            }
            remoteFiles={activeSessionId ? (aiRemoteFileContexts[activeSessionId] ?? []) : []}
            sessionId={activeSessionId}
            settings={settings}
            visible={aiAssistantVisible}
          />
        )}
      </AiContextSourcesBridge>
    </Suspense>
  ) : null;

  if (localDataState !== "unlocked") {
    return (
      <LocalDataUnlock
        error={localDataError}
        onUnlock={async (passphrase) => {
          setLocalDataError(undefined);
          try {
            await unlockLocalData(passphrase);
            setConfigurationLoadAttempt((attempt) => attempt + 1);
          } catch (error) {
            setLocalDataState("locked");
            setLocalDataError(commandErrorMessage(error));
          }
        }}
        state={localDataState}
      />
    );
  }

  return (
    <AppWorkspaceLayout
      applicationTitleBar={
        <ApplicationTitleBar
          hasActiveSession={Boolean(activeSession)}
          onOpenQuickCommands={() => openWorkspaceTool("commands")}
          onOpenSettings={() => openAuxiliaryWindow("settings")}
          onOpenShortcutGuide={() => openAuxiliaryWindow("shortcuts")}
          onToggleServerMonitor={() => {
            const collapsed = !serverMonitorCollapsed;
            setServerMonitorCollapsed(collapsed);
            localStorage.setItem(SERVER_MONITOR_COLLAPSED_KEY, String(collapsed));
          }}
          onToggleSftp={() => setSftpCollapsed((collapsed) => !collapsed)}
          serverMonitorCollapsed={serverMonitorCollapsed || !activeSession}
          sftpCollapsed={sftpCollapsed || !activeSession}
        />
      }
      aiAssistantPanel={aiAssistantPanel}
      aiAssistantMounted={aiAssistantMounted}
      aiAssistantOpening={aiSidebarPhase === "opening"}
      aiSidebarWidth={aiSidebarWidth}
      frozenWorkspaceWidth={mainWorkspaceFrozenWidth}
      mainSplitRef={mainSplitRef}
      onAiSidebarWidthChange={setAiSidebarWidth}
      serverMonitorCollapsed={serverMonitorCollapsed || !activeSession}
      serverMonitorPanel={serverMonitorPanel}
      sftpCollapsed={sftpCollapsed || !activeSession}
      sftpPanel={sftpPanel}
      terminalPanel={terminalPanel}
    />
  );
}

export default App;
