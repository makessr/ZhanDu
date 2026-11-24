import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Message } from "@arco-design/web-react";
import type { TableInstance } from "@arco-design/web-react";
import {
  filterSftpEntries,
  invertSftpEntryKeys,
  remoteParentPath,
  selectAllSftpEntryKeys,
} from "../../sftp-utils";
import {
  isEditableSelectAllTarget,
  SELECT_ALL_REQUEST_EVENT,
  type SelectAllRequestDetail,
} from "../../select-all-shortcut";
import type { BrowserState } from "./useSftpBrowserSession";

const SFTP_VIRTUAL_ROW_THRESHOLD = 300;

interface UseSftpEntrySelectionOptions {
  browser: BrowserState | null;
  connected: boolean;
  panelRef: RefObject<HTMLElement>;
  ready: boolean;
  sessionId?: string;
  showHiddenFiles: boolean;
  tableRef: RefObject<TableInstance>;
}

export default function useSftpEntrySelection({
  browser,
  connected,
  panelRef,
  ready,
  sessionId,
  showHiddenFiles,
  tableRef,
}: UseSftpEntrySelectionOptions) {
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const [nameFilter, setNameFilter] = useState<string | null>(null);
  const pendingLocatePathRef = useRef<string | null>(null);

  const visibleEntries = useMemo(
    () => filterSftpEntries(browser?.entries ?? [], showHiddenFiles, nameFilter ?? ""),
    [browser?.entries, nameFilter, showHiddenFiles],
  );
  const previewEntries = useMemo(
    () => filterSftpEntries(browser?.previewEntries ?? [], showHiddenFiles, nameFilter ?? ""),
    [browser?.previewEntries, nameFilter, showHiddenFiles],
  );
  const showingPreview = Boolean(connected && !ready && previewEntries.length);
  const displayedEntries = ready ? visibleEntries : showingPreview ? previewEntries : [];
  const virtualized = displayedEntries.length >= SFTP_VIRTUAL_ROW_THRESHOLD;
  const emptyDirectoryMessage = nameFilter?.trim() ? "没有匹配的文件或目录" : "目录为空";

  useEffect(() => {
    setSelectedEntryKeys([]);
    setNameFilter(null);
  }, [browser?.path, sessionId]);

  useEffect(() => {
    const visibleKeys = new Set(visibleEntries.map((entry) => entry.id));
    setSelectedEntryKeys((current) => {
      const next = current.filter((key) => visibleKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [visibleEntries]);

  useEffect(() => {
    const target = pendingLocatePathRef.current;
    if (!target || browser?.status !== "ready") return;
    pendingLocatePathRef.current = null;
    if (browser.path !== remoteParentPath(target)) return;
    const entry = visibleEntries.find((candidate) => candidate.path === target);
    if (!entry) {
      Message.warning("远程文件已不存在，或被隐藏文件设置过滤");
      return;
    }
    setSelectedEntryKeys([entry.id]);
    const frame = requestAnimationFrame(() => {
      if (virtualized) {
        tableRef.current?.scrollIntoView(entry.id);
        return;
      }
      panelRef.current
        ?.querySelector(`[data-sftp-entry-path="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [browser?.path, browser?.status, panelRef, tableRef, virtualized, visibleEntries]);

  useEffect(() => {
    const handleSelectAllRequest = (event: Event) => {
      const panel = panelRef.current;
      if (
        !ready ||
        !panel?.contains(document.activeElement) ||
        isEditableSelectAllTarget(document.activeElement)
      ) {
        return;
      }

      const request = event as CustomEvent<SelectAllRequestDetail>;
      const visibleKeys = visibleEntries.map((entry) => entry.id);
      event.preventDefault();
      setSelectedEntryKeys((current) =>
        request.detail.invert
          ? invertSftpEntryKeys(visibleKeys, current)
          : selectAllSftpEntryKeys(visibleKeys),
      );
    };
    window.addEventListener(SELECT_ALL_REQUEST_EVENT, handleSelectAllRequest);
    return () => window.removeEventListener(SELECT_ALL_REQUEST_EVENT, handleSelectAllRequest);
  }, [panelRef, ready, visibleEntries]);

  return {
    displayedEntries,
    emptyDirectoryMessage,
    nameFilter,
    pendingLocatePathRef,
    previewEntries,
    selectedEntryKeys,
    setSelectedEntryKeys,
    setNameFilter,
    showingPreview,
    virtualized,
    visibleEntries,
  };
}
