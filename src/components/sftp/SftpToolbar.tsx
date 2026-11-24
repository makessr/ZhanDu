import { useEffect, useState } from "react";
import {
  AutoComplete,
  Badge,
  Breadcrumb,
  Button,
  Dropdown,
  Menu,
  Space,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowUp,
  IconBook,
  IconClose,
  IconDelete,
  IconDown,
  IconFile,
  IconFolderAdd,
  IconHistory,
  IconPaste,
  IconRefresh,
  IconRight,
  IconSearch,
  IconStar,
  IconStarFill,
  IconUpload,
} from "@arco-design/web-react/icon";
import { remotePathBreadcrumbs } from "../../sftp-utils";
import type { CreateEntryKind } from "./SftpDialogs";

export interface SftpToolbarCommands {
  clearHistory: () => void;
  create: (kind: CreateEntryKind) => void;
  inputPathChange: (value: string) => void;
  navigate: (path: string) => void;
  openTransfers: () => void;
  paste: () => void;
  refresh: () => void;
  removeBookmark: (path: string) => void;
  toggleBookmark: () => void;
  toggleNameFilter: () => void;
  upload: () => void;
  up: () => void;
}

interface SftpToolbarProps {
  bookmarks: string[];
  clipboardEntryCount: number;
  commands: SftpToolbarCommands;
  connected: boolean;
  currentPath: string;
  currentPathBookmarked: boolean;
  history: string[];
  inputPath: string;
  aiFileReadProgress?: { completed: number; total: number };
  loading: boolean;
  nameFilterOpen: boolean;
  operationLoading: boolean;
  pathSuggestions: string[];
  ready: boolean;
  transferActivityCount: number;
}

export default function SftpToolbar({
  bookmarks,
  clipboardEntryCount,
  commands,
  connected,
  currentPath,
  currentPathBookmarked,
  history,
  inputPath,
  aiFileReadProgress,
  loading,
  nameFilterOpen,
  operationLoading,
  pathSuggestions,
  ready,
  transferActivityCount,
}: SftpToolbarProps) {
  const [editingPath, setEditingPath] = useState(false);
  const breadcrumbs = remotePathBreadcrumbs(currentPath);

  useEffect(() => {
    setEditingPath(false);
  }, [currentPath, ready]);

  const beginPathEditing = () => {
    if (!ready) return;
    commands.inputPathChange(currentPath);
    setEditingPath(true);
  };

  const cancelPathEditing = () => {
    commands.inputPathChange(currentPath);
    setEditingPath(false);
  };

  const navigateFromEditor = (path: string) => {
    if (!path.trim()) return;
    setEditingPath(false);
    commands.navigate(path);
  };

  return (
    <div className="panel-toolbar sftp-toolbar">
      <Space size="mini">
        <Tooltip content="返回上级目录">
          <Button
            aria-label="返回上级目录"
            disabled={!ready || currentPath === "/"}
            icon={<IconArrowUp />}
            onClick={commands.up}
            size="mini"
          />
        </Tooltip>
        <Tooltip content="刷新">
          <Button
            aria-label="刷新目录"
            disabled={!ready}
            icon={<IconRefresh />}
            loading={loading}
            onClick={commands.refresh}
            size="mini"
          />
        </Tooltip>
      </Space>
      <div className="sftp-path-controls">
        {editingPath ? (
          <AutoComplete
            className="sftp-path-autocomplete"
            data={pathSuggestions}
            disabled={!ready}
            inputProps={{
              "aria-label": "远程目录路径",
              autoFocus: true,
              onKeyDown: (event) => {
                if (event.key === "Escape") cancelPathEditing();
              },
              size: "mini",
            }}
            onBlur={cancelPathEditing}
            onChange={commands.inputPathChange}
            onPressEnter={(_, activeOption) => {
              if (!activeOption) navigateFromEditor(inputPath);
            }}
            onSelect={navigateFromEditor}
            value={connected ? inputPath : ""}
          />
        ) : (
          <div
            aria-label={`当前远程目录：${currentPath}`}
            className="sftp-path-breadcrumb"
            title={currentPath}
          >
            <div className="sftp-path-breadcrumb-scroll">
              <Breadcrumb separator={<IconRight />}>
                {breadcrumbs.map((item) => (
                  <Breadcrumb.Item
                    className="sftp-path-breadcrumb-item"
                    key={item.path}
                    onClick={() => commands.navigate(item.path)}
                  >
                    {item.label}
                  </Breadcrumb.Item>
                ))}
              </Breadcrumb>
            </div>
            <button
              aria-label="编辑远程目录路径"
              className="sftp-path-edit-target"
              disabled={!ready}
              onClick={beginPathEditing}
              type="button"
            />
          </div>
        )}
        <Tooltip content={currentPathBookmarked ? "取消收藏当前目录" : "收藏当前目录"}>
          <Button
            aria-label={currentPathBookmarked ? "取消收藏当前目录" : "收藏当前目录"}
            className={currentPathBookmarked ? "is-active" : undefined}
            disabled={!ready}
            icon={currentPathBookmarked ? <IconStarFill /> : <IconStar />}
            onClick={commands.toggleBookmark}
            size="mini"
          />
        </Tooltip>
        <Dropdown
          disabled={!ready}
          droplist={
            <Menu className="sftp-location-menu" selectable={false}>
              <Menu.ItemGroup title="快速目录">
                {bookmarks.length ? (
                  bookmarks.map((path) => (
                    <Menu.Item key={`bookmark:${path}`} onClick={() => commands.navigate(path)}>
                      <span className="sftp-location-menu-item">
                        <IconStarFill />
                        <span className="sftp-location-path">{path}</span>
                        <Button
                          aria-label={`取消收藏 ${path}`}
                          icon={<IconClose />}
                          onClick={(event) => {
                            event.stopPropagation();
                            commands.removeBookmark(path);
                          }}
                          size="mini"
                          type="text"
                        />
                      </span>
                    </Menu.Item>
                  ))
                ) : (
                  <Menu.Item disabled key="empty-bookmarks">
                    暂无收藏目录
                  </Menu.Item>
                )}
              </Menu.ItemGroup>
              <Menu.ItemGroup title="最近访问">
                {history.length ? (
                  history.map((path) => (
                    <Menu.Item key={`history:${path}`} onClick={() => commands.navigate(path)}>
                      <span className="sftp-location-menu-item">
                        <IconHistory />
                        <span className="sftp-location-path">{path}</span>
                      </span>
                    </Menu.Item>
                  ))
                ) : (
                  <Menu.Item disabled key="empty-history">
                    暂无访问记录
                  </Menu.Item>
                )}
              </Menu.ItemGroup>
              {history.length > 0 && (
                <Menu.Item key="clear-history" onClick={commands.clearHistory}>
                  <span className="sftp-location-menu-item sftp-location-menu-action">
                    <IconDelete />
                    <span>清空最近访问</span>
                  </span>
                </Menu.Item>
              )}
            </Menu>
          }
          position="bl"
          trigger="click"
        >
          <Tooltip content="快速目录和最近访问">
            <Button
              aria-label="打开快速目录和最近访问"
              disabled={!ready}
              icon={<IconBook />}
              size="mini"
            />
          </Tooltip>
        </Dropdown>
      </div>
      {aiFileReadProgress && (
        <span className="sftp-ai-read-progress">
          读取 AI 上下文 {aiFileReadProgress.completed}/{aiFileReadProgress.total}
        </span>
      )}
      <Space size="mini">
        <Tooltip content="按文件名筛选当前目录">
          <Button
            aria-label="筛选文件名"
            aria-pressed={nameFilterOpen}
            disabled={!ready}
            icon={<IconSearch />}
            onClick={commands.toggleNameFilter}
            size="mini"
            type={nameFilterOpen ? "primary" : "default"}
          />
        </Tooltip>
        <Dropdown.Button
          buttonProps={{ icon: <IconFolderAdd /> }}
          disabled={!ready}
          droplist={
            <Menu
              className="sftp-create-menu"
              onClickMenuItem={(key) => commands.create(key === "file" ? "file" : "directory")}
              selectable={false}
            >
              <Menu.Item key="file">
                <span className="sftp-create-menu-label">
                  <IconFile />
                  新建文件
                </span>
              </Menu.Item>
              <Menu.Item key="directory">
                <span className="sftp-create-menu-label">
                  <IconFolderAdd />
                  新建目录
                </span>
              </Menu.Item>
            </Menu>
          }
          icon={<IconDown />}
          onClick={() => commands.create("directory")}
          size="mini"
          trigger="click"
        >
          新建
        </Dropdown.Button>
        <Tooltip
          content={clipboardEntryCount > 0 ? `粘贴 ${clipboardEntryCount} 个项目` : "剪贴板为空"}
        >
          <Button
            aria-label="粘贴远程项目"
            disabled={!ready || clipboardEntryCount === 0 || operationLoading}
            icon={<IconPaste />}
            onClick={commands.paste}
            size="mini"
          />
        </Tooltip>
        <Button
          disabled={!ready}
          icon={<IconUpload />}
          onClick={commands.upload}
          size="mini"
          type="primary"
        >
          上传
        </Button>
        <Tooltip content="传输记录">
          <Badge count={transferActivityCount} maxCount={99}>
            <Button
              aria-label="打开传输记录"
              icon={<IconHistory />}
              onClick={commands.openTransfers}
              size="mini"
            />
          </Badge>
        </Tooltip>
      </Space>
    </div>
  );
}
