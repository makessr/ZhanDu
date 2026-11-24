import {
  useLayoutEffect,
  useState,
  type PointerEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { Empty, Input, Table } from "@arco-design/web-react";
import type { TableColumnProps, TableInstance } from "@arco-design/web-react";
import { IconFile, IconFolder, IconUpload } from "@arco-design/web-react/icon";
import type { SftpEntry } from "../../models";
import { localFileName } from "../../sftp-utils";
import ConnectionStatusOverlay from "../ConnectionStatusOverlay";
import ContextMenu from "../ContextMenu";
import type { ContextMenuItem } from "../ContextMenu";
import { useResizableColumns } from "../ResizableTableColumns";
import SftpToolbar, { type SftpToolbarCommands } from "./SftpToolbar";
import type { CreateEntryKind } from "./SftpDialogs";
import type { RemoteDragPreview } from "./useSftpRemoteDrag";

export interface SftpBrowserPaneView {
  aiFileReadProgress?: { completed: number; total: number };
  bookmarks: string[];
  busy: boolean;
  clipboardEntryCount: number;
  columns: TableColumnProps<SftpEntry>[];
  connected: boolean;
  connectionDescription: string;
  connectionUnavailable: boolean;
  currentPath: string;
  currentPathBookmarked: boolean;
  cutEntryPaths: ReadonlySet<string>;
  displayedEntries: SftpEntry[];
  emptyDirectoryMessage: string;
  fileDropActive: boolean;
  fileDropTargetPath?: string;
  filesVisible: boolean;
  followError?: { path: string; message: string };
  history: string[];
  inputPath: string;
  loading: boolean;
  nameFilter: string | null;
  operationLoading: boolean;
  pathSuggestions: string[];
  ready: boolean;
  reconnecting: boolean;
  remoteDragPreview?: RemoteDragPreview;
  remoteDropTargetPath?: string;
  selectedEntryKeys: string[];
  showingPreview: boolean;
  sftpUnavailable: boolean;
  transferActivityCount: number;
  virtualized: boolean;
}

export interface SftpBrowserPaneActions {
  clearHistory: () => void;
  closeNameFilter: () => void;
  create: (kind: CreateEntryKind) => void;
  inputPathChange: (value: string) => void;
  navigate: (path: string) => void;
  openDirectory: (entry: SftpEntry) => void;
  openFile: (entry: SftpEntry) => void;
  openTransfers: () => void;
  paste: () => void;
  refresh: () => void;
  reconnect: () => void;
  removeBookmark: (path: string) => void;
  retryConnection: () => void;
  selectEntries: (keys: string[]) => void;
  setNameFilter: (value: string | null) => void;
  toggleBookmark: () => void;
  toggleNameFilter: () => void;
  upload: () => void;
  up: () => void;
}

interface SftpBrowserPaneProps {
  actions: SftpBrowserPaneActions;
  dropZoneRef: RefObject<HTMLDivElement>;
  focusPanelForShortcut: (event: PointerEvent<HTMLElement>) => void;
  panelRef: RefObject<HTMLElement>;
  resolveContextMenu: (event: MouseEvent<HTMLElement>) => ContextMenuItem[];
  tableRef: RefObject<TableInstance>;
  view: SftpBrowserPaneView;
}

export default function SftpBrowserPane({
  actions,
  dropZoneRef,
  focusPanelForShortcut,
  panelRef,
  resolveContextMenu,
  tableRef,
  view,
}: SftpBrowserPaneProps) {
  const [virtualBodyHeight, setVirtualBodyHeight] = useState(1);
  const fileTable = useResizableColumns(view.columns);
  const toolbarCommands: SftpToolbarCommands = {
    clearHistory: actions.clearHistory,
    create: actions.create,
    inputPathChange: actions.inputPathChange,
    navigate: actions.navigate,
    openTransfers: actions.openTransfers,
    paste: actions.paste,
    refresh: actions.refresh,
    removeBookmark: actions.removeBookmark,
    toggleBookmark: actions.toggleBookmark,
    toggleNameFilter: actions.toggleNameFilter,
    upload: actions.upload,
    up: actions.up,
  };

  useLayoutEffect(() => {
    if (!view.virtualized) return;
    const table = tableRef.current?.getRootDomElement();
    const container = table?.parentElement;
    const header = table?.querySelector(".arco-table-header");
    if (!container || !header) return;

    const measure = () => {
      const headerHeight = Math.ceil(header.getBoundingClientRect().height);
      setVirtualBodyHeight(Math.max(1, container.clientHeight - headerHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(header);
    return () => observer.disconnect();
  }, [tableRef, view.virtualized]);

  return (
    <section
      hidden={!view.filesVisible}
      aria-label="文件管理"
      className="panel sftp-panel"
      onPointerDownCapture={focusPanelForShortcut}
      ref={panelRef}
      tabIndex={-1}
    >
      <SftpToolbar
        aiFileReadProgress={view.aiFileReadProgress}
        bookmarks={view.bookmarks}
        clipboardEntryCount={view.clipboardEntryCount}
        commands={toolbarCommands}
        connected={view.connected}
        currentPath={view.currentPath}
        currentPathBookmarked={view.currentPathBookmarked}
        history={view.history}
        inputPath={view.inputPath}
        loading={view.loading}
        nameFilterOpen={view.nameFilter !== null}
        operationLoading={view.operationLoading}
        pathSuggestions={view.pathSuggestions}
        ready={view.ready}
        transferActivityCount={view.transferActivityCount}
      />

      {view.nameFilter !== null && (
        <div className="sftp-name-filter">
          <Input
            allowClear
            aria-label="当前目录文件名"
            autoFocus
            onChange={actions.setNameFilter}
            onKeyDown={(event) => {
              if (event.key === "Escape") actions.closeNameFilter();
            }}
            placeholder="筛选当前目录"
            size="small"
            value={view.nameFilter}
          />
        </div>
      )}
      {view.showingPreview && (
        <div className="sftp-directory-preview-status" role="status">
          正在读取目录，完成后即可操作文件
        </div>
      )}
      {view.ready && view.followError && (
        <div className="sftp-directory-preview-status sftp-follow-status" role="status">
          <span>
            无法跟随到 <bdi>{view.followError.path}</bdi>，已保留当前目录。
          </span>
          <span>{view.followError.message}</span>
        </div>
      )}

      <ContextMenu menuClassName="sftp-context-menu" resolveItems={resolveContextMenu}>
        <div
          className={`sftp-table-container${view.virtualized ? " sftp-table-container-virtualized" : ""}${view.fileDropActive ? " sftp-table-container-drop-active" : ""}`}
          ref={dropZoneRef}
        >
          {view.fileDropActive && (
            <div className="sftp-file-drop-overlay">
              <IconUpload />
              <span>
                释放以上传文件或文件夹到
                {view.fileDropTargetPath
                  ? `“${localFileName(view.fileDropTargetPath)}”`
                  : `“${view.currentPath}”`}
              </span>
            </div>
          )}
          <Table
            border={false}
            className="sftp-table"
            columns={fileTable.columns}
            data={view.displayedEntries}
            loading={Boolean(view.connected && view.busy && !view.showingPreview)}
            noDataElement={
              <Empty description={view.ready ? view.emptyDirectoryMessage : "暂无文件"} />
            }
            onRow={(entry) => ({
              "data-sftp-entry-id": entry.id,
              "data-sftp-entry-kind": entry.kind,
              "data-sftp-entry-path": entry.path,
              onDoubleClick: () => {
                if (!view.ready) return;
                if (entry.kind === "directory") {
                  actions.openDirectory(entry);
                } else if (entry.kind === "file") {
                  actions.openFile(entry);
                }
              },
            })}
            pagination={false}
            ref={tableRef}
            rowKey="id"
            rowClassName={(entry) =>
              [
                view.cutEntryPaths.has(entry.path) ? "sftp-row-cut" : "",
                view.remoteDropTargetPath === entry.path ? "sftp-row-drop-target" : "",
                view.fileDropTargetPath === entry.path ? "sftp-row-drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")
            }
            rowSelection={
              view.ready
                ? {
                    checkAll: true,
                    columnWidth: 42,
                    onChange: (keys) => actions.selectEntries(keys.map((key) => String(key))),
                    selectedRowKeys: view.selectedEntryKeys,
                    type: "checkbox",
                  }
                : undefined
            }
            size="small"
            scroll={{
              x: fileTable.tableWidth + (view.ready ? 42 : 0),
              y: view.virtualized ? virtualBodyHeight : undefined,
            }}
            virtualized={view.virtualized}
          />
          {view.remoteDragPreview && (
            <div
              className="sftp-remote-drag-preview"
              style={{
                left: view.remoteDragPreview.x + 12,
                top: view.remoteDragPreview.y + 12,
              }}
            >
              {view.remoteDragPreview.kind === "directory" ? <IconFolder /> : <IconFile />}
              <span>{view.remoteDragPreview.label}</span>
              {view.remoteDragPreview.count > 1 && (
                <span className="sftp-remote-drag-count">{view.remoteDragPreview.count}</span>
              )}
            </div>
          )}
          {view.connectionUnavailable && (
            <ConnectionStatusOverlay
              description={view.connectionDescription}
              onReconnect={view.sftpUnavailable ? actions.retryConnection : actions.reconnect}
              reconnecting={view.reconnecting}
            />
          )}
        </div>
      </ContextMenu>
    </section>
  );
}
