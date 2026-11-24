import { createRef } from "react";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TableColumnProps, TableInstance } from "@arco-design/web-react";
import type { SftpEntry } from "../../models";
import SftpBrowserPane, {
  type SftpBrowserPaneActions,
  type SftpBrowserPaneView,
} from "./SftpBrowserPane";

const entry: SftpEntry = {
  id: "entry-1",
  kind: "directory",
  name: "logs",
  path: "/var/logs",
  modifiedAt: 1_700_000_000,
  owner: "root",
  permissions: 493,
  size: 0,
  group: "root",
};

const columns: TableColumnProps<SftpEntry>[] = [
  { dataIndex: "name", title: "名称" },
  { dataIndex: "size", title: "大小" },
];

function paneActions(overrides: Partial<SftpBrowserPaneActions> = {}): SftpBrowserPaneActions {
  return {
    clearHistory: () => undefined,
    closeNameFilter: () => undefined,
    create: () => undefined,
    inputPathChange: () => undefined,
    navigate: () => undefined,
    openDirectory: () => undefined,
    openFile: () => undefined,
    openTransfers: () => undefined,
    paste: () => undefined,
    refresh: () => undefined,
    reconnect: () => undefined,
    removeBookmark: () => undefined,
    retryConnection: () => undefined,
    selectEntries: () => undefined,
    setNameFilter: () => undefined,
    toggleBookmark: () => undefined,
    toggleNameFilter: () => undefined,
    upload: () => undefined,
    up: () => undefined,
    ...overrides,
  };
}

function paneView(overrides: Partial<SftpBrowserPaneView> = {}): SftpBrowserPaneView {
  return {
    bookmarks: [],
    busy: false,
    clipboardEntryCount: 0,
    columns,
    connected: true,
    connectionDescription: "",
    connectionUnavailable: false,
    currentPath: "/var",
    currentPathBookmarked: false,
    cutEntryPaths: new Set<string>(),
    displayedEntries: [entry],
    emptyDirectoryMessage: "目录为空",
    fileDropActive: false,
    filesVisible: true,
    history: [],
    inputPath: "/var",
    loading: false,
    nameFilter: null,
    operationLoading: false,
    pathSuggestions: [],
    ready: true,
    reconnecting: false,
    selectedEntryKeys: [],
    showingPreview: false,
    sftpUnavailable: false,
    transferActivityCount: 0,
    virtualized: false,
    ...overrides,
  };
}

function renderPane(
  view: Partial<SftpBrowserPaneView> = {},
  actions: SftpBrowserPaneActions = paneActions(),
) {
  return render(
    <SftpBrowserPane
      actions={actions}
      dropZoneRef={createRef<HTMLDivElement>()}
      focusPanelForShortcut={() => undefined}
      panelRef={createRef<HTMLElement>()}
      resolveContextMenu={() => []}
      tableRef={createRef<TableInstance>()}
      view={paneView(view)}
    />,
  );
}

describe("SftpBrowserPane", () => {
  test("hides the section while the files workspace is closed", () => {
    const { container } = renderPane({ filesVisible: false });

    const section = container.querySelector("section.sftp-panel");
    expect(section?.hasAttribute("hidden")).toBe(true);
  });

  test("renders the remote path and delegates toolbar refresh", () => {
    const actions = paneActions({ refresh: mock(() => undefined) });
    renderPane({}, actions);

    expect(screen.getByLabelText("当前远程目录：/var")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("刷新目录"));
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  test("closes the name filter from its escape key", () => {
    const actions = paneActions({ closeNameFilter: mock(() => undefined) });
    renderPane({ nameFilter: "" }, actions);

    expect(screen.getByLabelText("当前目录文件名")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("当前目录文件名"), { key: "Escape" });
    expect(actions.closeNameFilter).toHaveBeenCalledTimes(1);
  });

  test("opens a directory on double click and a file through the file handler", () => {
    const actions = paneActions({
      openDirectory: mock(() => undefined),
      openFile: mock(() => undefined),
    });
    const { container } = renderPane({}, actions);

    const row = container.querySelector("[data-sftp-entry-id='entry-1']");
    expect(row).not.toBeNull();
    fireEvent.doubleClick(row as Element);
    expect(actions.openDirectory).toHaveBeenCalledWith(entry);
    expect(actions.openFile).not.toHaveBeenCalled();
  });

  test("shows the retained directory when a terminal follow fails", () => {
    renderPane({ followError: { path: "/etc", message: "权限不足" } });

    expect(screen.getByText(/无法跟随到/)).not.toBeNull();
    expect(screen.getByText("权限不足")).not.toBeNull();
  });

  test("routes reconnect through the SFTP retry when the connection failed", () => {
    const actions = paneActions({ retryConnection: mock(() => undefined) });
    renderPane({ connectionUnavailable: true, sftpUnavailable: true }, actions);

    fireEvent.click(screen.getByRole("button", { name: /重新连接/ }));
    expect(actions.retryConnection).toHaveBeenCalledTimes(1);
  });
});
