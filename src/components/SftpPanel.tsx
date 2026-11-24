import { useEffect, useMemo, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import type { TableColumnProps, TableInstance } from "@arco-design/web-react";
import type { SftpEntry, TerminalSession } from "../models";
import type { ContextMenuItem } from "./ContextMenu";
import type { AiRemoteFileContext } from "../ai-utils";
import { remoteParentPath } from "../sftp-utils";
import { isTerminalSessionOperational } from "../terminal-utils";
import { commandErrorMessage, type ExternalEditPayload } from "../tauri-protocol";
import SftpOverlayHost from "./sftp/SftpOverlayHost";
import type { TransferActivityRecord } from "./TransferActivityList";
import buildSftpContextMenu from "./sftp/buildSftpContextMenu";
import SftpBrowserPane from "./sftp/SftpBrowserPane";
import buildSftpTableColumns from "./sftp/sftpTableColumns";
import useSftpAiHandoff from "./sftp/useSftpAiHandoff";
import useSftpArchives from "./sftp/useSftpArchives";
import useSftpBookmarks from "./sftp/useSftpBookmarks";
import useSftpClipboard from "./sftp/useSftpClipboard";
import confirmBatchOverwrite from "./sftp/confirmBatchOverwrite";
import useSftpEntryOperations from "./sftp/useSftpEntryOperations";
import useSftpEntrySelection from "./sftp/useSftpEntrySelection";
import useSftpBrowserSession from "./sftp/useSftpBrowserSession";
import useSftpFileTransfers from "./sftp/useSftpFileTransfers";
import { isSftpSessionFailure } from "./sftp/sftpErrors";
import useSftpLocations from "./sftp/useSftpLocations";
import useSftpRemoteDrag from "./sftp/useSftpRemoteDrag";
import useSftpTextEditing, { REMOTE_TEXT_MAX_BYTES } from "./sftp/useSftpTextEditing";
import useSftpTransfers from "./sftp/useSftpTransfers";

export interface SftpPanelCommands {
  currentPathChange: (sessionId: string | null, path: string) => void;
  reconnect: () => void;
  sendFilesToAi: (sessionId: string, files: AiRemoteFileContext[]) => void | Promise<void>;
  sendSelectionToAi: (
    sessionId: string,
    currentDirectory: string,
    entries: SftpEntry[],
  ) => void | Promise<void>;
  showFiles?: () => void;
  showTransfers?: () => void;
}

interface SftpPanelProps {
  commands: SftpPanelCommands;
  filesVisible?: boolean;
  transfersVisible?: boolean;
  confirmFileDelete: boolean;
  externalEditorName: string;
  externalEditorPath: string;
  sftpUploadRetryAttempts: number;
  refreshRequest: number;
  session: TerminalSession | null;
  showHiddenFiles: boolean;
  terminalDirectory?: { path: string; revision: number };
}

function SftpPanel({
  commands,
  filesVisible = true,
  transfersVisible,
  confirmFileDelete,
  externalEditorName,
  externalEditorPath,
  sftpUploadRetryAttempts,
  refreshRequest,
  session,
  showHiddenFiles,
  terminalDirectory,
}: SftpPanelProps) {
  const [transferDrawerVisible, setTransferDrawerVisible] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const tableRef = useRef<TableInstance>(null);
  const locations = useSftpLocations();
  const { recordVisitedPath } = locations;
  const {
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
  } = useSftpBrowserSession({
    currentPathChange: commands.currentPathChange,
    recordVisitedPath,
    refreshRequest,
    session,
    terminalDirectory,
  });
  const {
    clearPathHistory,
    currentLocation,
    currentPathBookmarked,
    pathSuggestions,
    removePathBookmark,
    toggleCurrentPathBookmark,
  } = useSftpBookmarks({
    browserInputPath: browser?.inputPath,
    browserPath: browser?.path,
    hostId: session?.host.id,
    locations,
  });
  const {
    displayedEntries,
    emptyDirectoryMessage,
    nameFilter,
    pendingLocatePathRef,
    selectedEntryKeys,
    setSelectedEntryKeys,
    setNameFilter,
    showingPreview,
    virtualized,
    visibleEntries,
  } = useSftpEntrySelection({
    browser,
    connected,
    panelRef,
    ready,
    sessionId: session?.id,
    showHiddenFiles,
    tableRef,
  });
  const { aiFileReadProgress, sendEntriesToAi } = useSftpAiHandoff({
    confirmOverwrite: confirmBatchOverwrite,
    disabled: operationLoading,
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    sendFilesToAi: commands.sendFilesToAi,
    sessionId: session?.id,
  });

  function clearEntrySelection() {
    setSelectedEntryKeys([]);
  }

  function refreshCurrentDirectory() {
    if (!session) return;
    const currentBrowser = browsersRef.current[session.id];
    if (currentBrowser) return loadDirectory(session.id, currentBrowser.path);
  }

  const {
    cancel: cancelTransfer,
    cancelSessionTransfers,
    clearFinished: clearFinishedTransfersForSession,
    currentTransfers,
    pause: pauseTransfer,
    queueArchiveDownload,
    queueTransfer,
    remove: removeTransfer,
    resume: resumeTransfer,
    retry: retryTransfer,
  } = useSftpTransfers({
    activeSessionId: session?.id,
    isSessionReady,
    onRefreshDirectory: async (sessionId) => {
      const currentBrowser = browsersRef.current[sessionId];
      if (currentBrowser?.status === "ready") {
        await loadDirectory(sessionId, currentBrowser.path);
      }
    },
    onSessionFailure: markSessionFailed,
    uploadRetryAttempts: sftpUploadRetryAttempts,
  });
  const {
    clearClipboard,
    currentClipboard,
    cutEntryPaths,
    pasteClipboard,
    pasteConflictPolicy,
    pendingPaste,
    requestPaste,
    selectPasteConflictPolicy,
    setPendingPaste,
    storeClipboard,
  } = useSftpClipboard({
    onClearSelection: clearEntrySelection,
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onRefreshDirectory: refreshCurrentDirectory,
    sessionId: session?.id,
  });

  useEffect(() => {
    if (!session) return;

    if (isTerminalSessionOperational(session.status)) {
      if (!browser || browser.status === "idle") connectCurrentSession();
      return;
    }

    if (disconnectSession(session.id)) {
      cancelSessionTransfers(session.id);
      clearClipboard(session.id);
    }
  }, [
    browser,
    cancelSessionTransfers,
    clearClipboard,
    connectCurrentSession,
    disconnectSession,
    session,
  ]);

  const {
    closeCreateDialog,
    closePermissionsDialog,
    closeRenameDialog,
    createEntry,
    creatingEntryKind,
    newEntryName,
    openCreateDialog,
    openPermissionsDialog,
    openRenameDialog,
    parsedPermissionValue,
    permissionEntries,
    permissionGroup,
    permissionOwner,
    permissionValue,
    renameEntry,
    renameName,
    renamingEntry,
    requestDeleteEntries,
    requestFastDelete,
    setNewEntryName,
    setPermissionGroup,
    setPermissionOwner,
    setPermissionValue,
    setRenameName,
    updatePermissions,
  } = useSftpEntryOperations({
    confirmFileDelete,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: clearEntrySelection,
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onRefreshDirectory: refreshCurrentDirectory,
    sessionId: session?.id,
  });
  const {
    chooseExternalEditor,
    currentExternalEdits,
    externalEditActionLoading,
    externalEditConflict,
    externalEditForEntry,
    externalEdits,
    openExternalEditor,
    openTextEditor,
    reopenExternalEditLocalFile,
    requestCloseTextEditor,
    resolveExternalEdit,
    selectExternalEditConflict,
    saveTextEditor,
    textEditor,
    textEditorByteLength,
    updateTextContent,
  } = useSftpTextEditing({
    onOperationError: handleOperationError,
    onRefreshDirectory: refreshCurrentDirectory,
    sessionId: session?.id,
  });
  const transferActivityCount = currentTransfers.length + currentExternalEdits.length;
  function focusFilePanelForShortcut(event: React.PointerEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        'button, input, textarea, a, [contenteditable="true"], [role="button"], [role="checkbox"], [role="combobox"], [role="textbox"]',
      )
    ) {
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
  }

  function locateTransferInPanel(transfer: TransferActivityRecord) {
    commands.showFiles?.();
    if (!session || !transfer.remotePath) return;
    pendingLocatePathRef.current = transfer.remotePath;
    setNameFilter(null);
    setTransferDrawerVisible(false);
    void loadDirectory(session.id, remoteParentPath(transfer.remotePath));
  }

  function navigateToPath(path: string) {
    if (!session || !path.trim()) return;
    void loadDirectory(session.id, path.trim());
  }

  const {
    cancel: cancelRemotePointerDrag,
    dropTargetPath: remoteDropTargetPath,
    finish: finishRemotePointerDrag,
    move: moveRemotePointerDrag,
    preview: remoteDragPreview,
    start: startRemotePointerDrag,
  } = useSftpRemoteDrag({
    disabled: !ready || operationLoading,
    entries: visibleEntries,
    onMove: (entries, targetDirectory) => {
      void requestPaste(targetDirectory, { mode: "cut", entries });
    },
    resetKey: `${session?.id ?? ""}\0${browser?.path ?? ""}`,
    selectedEntryKeys,
    setSelectedEntryKeys,
  });

  const externalEditForPath = useMemo(() => {
    const editsByPath = new Map<string, ExternalEditPayload>();
    for (const edit of Object.values(externalEdits)) {
      if (
        edit.sessionId === session?.id &&
        edit.status !== "closed" &&
        !editsByPath.has(edit.remotePath)
      ) {
        editsByPath.set(edit.remotePath, edit);
      }
    }
    return (path: string) => editsByPath.get(path);
  }, [externalEdits, session?.id]);

  const columns = useMemo<TableColumnProps<SftpEntry>[]>(
    () =>
      buildSftpTableColumns({
        drag: {
          cancel: cancelRemotePointerDrag,
          finish: finishRemotePointerDrag,
          move: moveRemotePointerDrag,
          start: startRemotePointerDrag,
        },
        externalEditForPath,
        operationLoading,
        ready,
      }),
    [
      cancelRemotePointerDrag,
      externalEditForPath,
      finishRemotePointerDrag,
      moveRemotePointerDrag,
      operationLoading,
      ready,
      startRemotePointerDrag,
    ],
  );
  const {
    archiveBaseName,
    archiveDialog,
    archiveFormat,
    closeArchiveDialog,
    extractRemoteArchive,
    openArchiveDialog,
    setArchiveBaseName,
    setArchiveFormat,
    submitArchiveDialog,
  } = useSftpArchives({
    confirmOverwrite: confirmBatchOverwrite,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: clearEntrySelection,
    onLoadingChange: setOperationLoading,
    onOperationError: handleOperationError,
    onQueueDownload: ({ archiveName, format, localPath, sourcePaths }) => {
      if (!session) return;
      queueArchiveDownload({
        archiveName,
        format,
        localPath,
        sessionId: session.id,
        sourcePaths,
      });
    },
    onRefreshDirectory: refreshCurrentDirectory,
    sessionId: session?.id,
  });
  const {
    chooseUploadFiles,
    downloadEntries,
    downloadEntry,
    dropZoneRef,
    fileDropActive,
    fileDropTargetPath,
  } = useSftpFileTransfers({
    confirmOverwrite: confirmBatchOverwrite,
    currentDirectory: browser?.path,
    entries: browser?.entries ?? [],
    onClearSelection: clearEntrySelection,
    onQueueTransfer: queueTransfer,
    onRefreshDirectory: refreshCurrentDirectory,
    ready,
    sessionId: session?.id,
  });

  function clearFinishedTransfers() {
    if (!session) return;
    clearFinishedTransfersForSession(session.id);
  }

  function handleOperationError(error: unknown) {
    const message = commandErrorMessage(error);
    if (session && isSftpSessionFailure(message)) {
      markSessionFailed(session.id, message);
    }
    Message.error(message);
  }

  function entryContextMenuItems(entries: SftpEntry[]): ContextMenuItem[] {
    return buildSftpContextMenu({
      clipboardEntryCount: currentClipboard?.entries.length ?? 0,
      entries,
      externalEditorName,
      externalEditorPath,
      operationLoading,
      onArchive: openArchiveDialog,
      onChooseExternalEditor: chooseExternalEditor,
      onCopy: (selected) => storeClipboard(selected, "copy"),
      onCut: (selected) => storeClipboard(selected, "cut"),
      onDelete: requestDeleteEntries,
      onDownload: downloadEntry,
      onDownloadMany: downloadEntries,
      onEditText: openTextEditor,
      onExtract: extractRemoteArchive,
      onFastDelete: requestFastDelete,
      onOpenDirectory: openDirectory,
      onOpenExternal: openExternalEditor,
      onPaste: (targetDirectory) =>
        currentClipboard ? requestPaste(targetDirectory, currentClipboard) : undefined,
      onPermissions: openPermissionsDialog,
      onRefresh: () => {
        if (session && browser) {
          return loadDirectory(session.id, browser.path);
        }
      },
      onRename: openRenameDialog,
      onResolveExternalEdit: selectExternalEditConflict,
      onSendFilesToAi: sendEntriesToAi,
      onSendSelectionToAi: (selected) => {
        if (!session || !browser) return;
        return commands.sendSelectionToAi(session.id, browser.path, selected);
      },
      resolveExternalEdit: externalEditForEntry,
      rootDirectory: browser?.path,
    });
  }

  function resolveEntryContextMenu(event: React.MouseEvent<HTMLElement>): ContextMenuItem[] {
    if (!ready || !(event.target instanceof Element)) return [];
    const row = event.target.closest<HTMLElement>("[data-sftp-entry-id]");
    const entry = visibleEntries.find((candidate) => candidate.id === row?.dataset.sftpEntryId);
    if (!entry) {
      setSelectedEntryKeys([]);
      return entryContextMenuItems([]);
    }

    const entries = selectedEntryKeys.includes(entry.id)
      ? visibleEntries.filter((candidate) => selectedEntryKeys.includes(candidate.id))
      : [entry];
    if (!selectedEntryKeys.includes(entry.id)) {
      setSelectedEntryKeys([entry.id]);
    }
    return entryContextMenuItems(entries);
  }

  function openDirectory(entry: SftpEntry) {
    if (!session || entry.kind !== "directory") return;
    void loadDirectory(session.id, entry.path);
  }

  return (
    <>
      <SftpBrowserPane
        actions={{
          clearHistory: clearPathHistory,
          closeNameFilter: () => {
            setNameFilter(null);
            panelRef.current?.focus({ preventScroll: true });
          },
          create: openCreateDialog,
          inputPathChange: (value) => {
            if (session) updateBrowser(session.id, { inputPath: value });
          },
          navigate: navigateToPath,
          openDirectory,
          openFile: (entry) => void openTextEditor(entry),
          openTransfers: commands.showTransfers ?? (() => setTransferDrawerVisible(true)),
          paste: () => {
            if (browser && currentClipboard) {
              void requestPaste(browser.path, currentClipboard);
            }
          },
          reconnect: commands.reconnect,
          refresh: () => {
            if (session && browser) {
              void loadDirectory(session.id, browser.path);
            }
          },
          removeBookmark: removePathBookmark,
          retryConnection: () => void retryConnection(),
          selectEntries: setSelectedEntryKeys,
          setNameFilter,
          toggleBookmark: toggleCurrentPathBookmark,
          toggleNameFilter: () => setNameFilter((current) => (current === null ? "" : null)),
          upload: () => void chooseUploadFiles(),
          up: () => {
            if (session && browser) {
              void loadDirectory(session.id, remoteParentPath(browser.path));
            }
          },
        }}
        dropZoneRef={dropZoneRef}
        focusPanelForShortcut={focusFilePanelForShortcut}
        panelRef={panelRef}
        resolveContextMenu={resolveEntryContextMenu}
        tableRef={tableRef}
        view={{
          aiFileReadProgress,
          bookmarks: currentLocation.bookmarks,
          busy: Boolean(busy),
          clipboardEntryCount: currentClipboard?.entries.length ?? 0,
          columns,
          connected: Boolean(connected),
          connectionDescription,
          connectionUnavailable,
          currentPath: browser?.path ?? "/",
          currentPathBookmarked,
          cutEntryPaths,
          displayedEntries,
          emptyDirectoryMessage,
          fileDropActive,
          fileDropTargetPath,
          filesVisible,
          followError: browser?.followError,
          history: currentLocation.history,
          inputPath: browser?.inputPath ?? "/",
          loading: browser?.status === "loading",
          nameFilter,
          operationLoading,
          pathSuggestions,
          ready,
          reconnecting,
          remoteDragPreview,
          remoteDropTargetPath,
          selectedEntryKeys,
          showingPreview,
          sftpUnavailable,
          transferActivityCount,
          virtualized,
        }}
      />
      <SftpOverlayHost
        archive={{
          baseName: archiveBaseName,
          format: archiveFormat,
          loading: operationLoading,
          onBaseNameChange: setArchiveBaseName,
          onCancel: closeArchiveDialog,
          onConfirm: () => void submitArchiveDialog(),
          onFormatChange: setArchiveFormat,
          state: archiveDialog,
        }}
        createEntry={{
          kind: creatingEntryKind,
          loading: operationLoading,
          name: newEntryName,
          onCancel: closeCreateDialog,
          onConfirm: () => void createEntry(),
          onNameChange: setNewEntryName,
        }}
        externalEditConflict={{
          edit: externalEditConflict,
          loading: externalEditActionLoading,
          onCancel: () => selectExternalEditConflict(null),
          onResolve: (action) => void resolveExternalEdit(action),
        }}
        pasteConflict={{
          conflictCount: pendingPaste?.conflictCount ?? 0,
          loading: operationLoading,
          onCancel: () => setPendingPaste(null),
          onConfirm: () => {
            if (!pendingPaste) return;
            void pasteClipboard(
              pendingPaste.clipboard,
              pendingPaste.targetDirectory,
              pasteConflictPolicy,
            ).then(() => setPendingPaste(null));
          },
          onPolicyChange: selectPasteConflictPolicy,
          policy: pasteConflictPolicy,
          visible: Boolean(pendingPaste),
        }}
        permissions={{
          entries: permissionEntries,
          group: permissionGroup,
          loading: operationLoading,
          onCancel: closePermissionsDialog,
          onConfirm: () => void updatePermissions(),
          onGroupChange: setPermissionGroup,
          onOwnerChange: setPermissionOwner,
          onPermissionChange: setPermissionValue,
          owner: permissionOwner,
          parsedPermission: parsedPermissionValue,
          permission: permissionValue,
        }}
        rename={{
          entry: renamingEntry,
          loading: operationLoading,
          name: renameName,
          onCancel: closeRenameDialog,
          onConfirm: () => void renameEntry(),
          onNameChange: setRenameName,
        }}
        textEditor={{
          byteLength: textEditorByteLength,
          maxBytes: REMOTE_TEXT_MAX_BYTES,
          onCancel: requestCloseTextEditor,
          onChange: updateTextContent,
          onSave: () => void saveTextEditor(),
          state: textEditor,
        }}
        transferDrawer={{
          embedded: transfersVisible !== undefined,
          externalEdits: currentExternalEdits,
          onCancelTransfer: (transfer) => void cancelTransfer(transfer),
          onClearFinished: clearFinishedTransfers,
          onClose: () => setTransferDrawerVisible(false),
          onLocateRemoteTransfer: locateTransferInPanel,
          onOpenExternalEdit: (edit) => void reopenExternalEditLocalFile(edit),
          onPauseTransfer: (transfer) => void pauseTransfer(transfer),
          onRemoveTransfer: (transfer) => removeTransfer(transfer.transferId),
          onResolveExternalEdit: selectExternalEditConflict,
          onResumeTransfer: (transfer) => void resumeTransfer(transfer),
          onRetryTransfer: (transfer) => void retryTransfer(transfer),
          transfers: currentTransfers,
          visible: transfersVisible ?? transferDrawerVisible,
        }}
      />
    </>
  );
}

export default SftpPanel;
