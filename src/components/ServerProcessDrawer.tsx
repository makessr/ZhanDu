import { WorkspaceToolSurface } from "./WorkspaceToolPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Message,
  Modal,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconRefresh,
  IconRobot,
  IconStop,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { diagnosticInvoke as invoke } from "../diagnostics";
import type {
  ServerProcess,
  ServerProcessListResult,
  TerminalSession,
} from "../models";
import { formatMonitorBytes } from "../monitor-utils";
import { isTerminalSessionOperational } from "../terminal-utils";
import {
  filterServerProcesses,
  formatProcessElapsed,
  formatProcessPercent,
} from "../process-utils";
import { commandErrorMessage } from "../tauri-protocol";
import { createProcessesAiHandoff, type AiHandoffRequest } from "../ai-handoff";

interface ServerProcessDrawerProps {
  onCancel: () => void;
  onSendToAi: (request: AiHandoffRequest) => void;
  session: TerminalSession;
  visible: boolean;
  embedded?: boolean;
}

const PROCESS_TABLE_WIDTH = 830;

const PROCESS_REFRESH_INTERVAL_MS = 5_000;

const PROCESS_STATE_LABELS: Record<string, string> = {
  D: "不可中断",
  I: "空闲",
  R: "运行",
  S: "休眠",
  T: "已停止",
  Z: "僵尸",
};

function processStateLabel(state: string) {
  return PROCESS_STATE_LABELS[state.charAt(0)] ?? state;
}

function ServerProcessDrawer({
  onCancel,
  onSendToAi,
  session,
  visible,
  embedded,
}: ServerProcessDrawerProps) {
  const [result, setResult] = useState<ServerProcessListResult | null>(null);
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedProcessIds, setSelectedProcessIds] = useState<string[]>([]);
  const [signalingProcess, setSignalingProcess] = useState<{
    force: boolean;
    pid: number;
  } | null>(null);
  const loadingRef = useRef(false);
  const requestVersionRef = useRef(0);

  const loadProcesses = useCallback(
    async (showLoading = true) => {
      if (loadingRef.current || !isTerminalSessionOperational(session.status)) {
        return;
      }
      loadingRef.current = true;
      const requestVersion = requestVersionRef.current;
      if (showLoading) setLoading(true);
      try {
        const next = await invoke<ServerProcessListResult>("ssh_processes", {
          sessionId: session.id,
        });
        if (requestVersion !== requestVersionRef.current) return;
        setResult(next);
        setError(undefined);
      } catch (processError) {
        if (requestVersion === requestVersionRef.current) {
          setError(commandErrorMessage(processError));
        }
      } finally {
        if (requestVersion === requestVersionRef.current) {
          loadingRef.current = false;
          if (showLoading) setLoading(false);
        }
      }
    },
    [session.id, session.status],
  );

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingRef.current = false;
    setResult(null);
    setQuery("");
    setError(undefined);
    setLoading(false);
    setSignalingProcess(null);
    setSelectedProcessIds([]);
  }, [session.id]);

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingRef.current = false;
    setLoading(false);
    if (visible) {
      setError(undefined);
      setSignalingProcess(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !isTerminalSessionOperational(session.status)) return;
    void loadProcesses();
    if (!autoRefresh) return;
    const timer = window.setInterval(
      () => void loadProcesses(false),
      PROCESS_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadProcesses, session.status, visible]);

  const filteredProcesses = useMemo(
    () => filterServerProcesses(result?.processes ?? [], query),
    [query, result],
  );
  const selectedProcesses = useMemo(() => {
    const selectedIds = new Set(selectedProcessIds);
    return (result?.processes ?? []).filter((process) =>
      selectedIds.has(process.id),
    );
  }, [result, selectedProcessIds]);
  const signalProcess = useCallback(
    async (process: ServerProcess, force: boolean) => {
      setSignalingProcess({ force, pid: process.pid });
      setError(undefined);
      try {
        await invoke("ssh_signal_process", {
          force,
          pid: process.pid,
          sessionId: session.id,
        });
        Message.success(
          `已向 ${process.name}（PID ${process.pid}）发送 ${force ? "KILL" : "TERM"}`,
        );
        await loadProcesses(false);
      } catch (signalError) {
        setError(commandErrorMessage(signalError));
      } finally {
        setSignalingProcess(null);
      }
    },
    [loadProcesses, session.id],
  );
  const confirmSignalProcess = useCallback(
    (process: ServerProcess, force: boolean) => {
      Modal.confirm({
        cancelText: "取消",
        content: force
          ? `将立即强制结束 ${process.name}（PID ${process.pid}），进程无法执行清理操作。`
          : `向 ${process.name}（PID ${process.pid}）发送 TERM，请求进程正常退出。`,
        okButtonProps: force ? { status: "danger" } : undefined,
        okText: force ? "强制结束" : "结束进程",
        onOk: () => signalProcess(process, force),
        title: force ? "强制结束进程？" : "结束进程？",
      });
    },
    [signalProcess],
  );
  const columns = useMemo<TableColumnProps<ServerProcess>[]>(
    () => [
      {
        align: "right",
        dataIndex: "pid",
        sorter: (left, right) => left.pid - right.pid,
        title: "PID",
        width: 74,
      },
      {
        dataIndex: "user",
        sorter: (left, right) => left.user.localeCompare(right.user),
        title: "用户",
        width: 100,
        render: (user: string) => <span className="server-process-cell" title={user}>{user}</span>,
      },
      {
        align: "right",
        dataIndex: "residentMemoryBytes",
        sorter: (left, right) => left.residentMemoryBytes - right.residentMemoryBytes,
        title: "内存",
        width: 94,
        render: (bytes: number, process) => (
          <span title={`占用 ${formatProcessPercent(process.memoryUsagePercent)}`}>
            {formatMonitorBytes(bytes)}
          </span>
        ),
      },
      {
        align: "right",
        dataIndex: "cpuUsagePercent",
        defaultSortOrder: "descend",
        sorter: (left, right) => left.cpuUsagePercent - right.cpuUsagePercent,
        title: "CPU %",
        width: 86,
        render: (value: number) => formatProcessPercent(value),
      },
      {
        dataIndex: "name",
        title: "名称",
        width: 126,
        render: (name: string, process) => (
          <span
            className="server-process-cell"
            title={`${name} · ${processStateLabel(process.state)} · 已运行 ${formatProcessElapsed(process.elapsedSeconds)}`}
          >
            {name}
          </span>
        ),
      },
      {
        dataIndex: "command",
        title: "命令行",
        width: "24%",
        render: (command: string) => (
          <span className="server-process-cell" title={command}>{command || "—"}</span>
        ),
      },
      {
        title: "路径",
        render: (_, process) => {
          const path = process.command?.trimStart().match(/^\/\S+/)?.[0];
          return <span className="server-process-cell" title={path}>{path ?? "—"}</span>;
        },
      },
      {
        title: "操作",
        width: 76,
        render: (_, process) => (
          <Space size="mini">
            <Tooltip content="结束进程（TERM）">
              <Button
                aria-label={`结束进程 ${process.pid}`}
                disabled={process.pid <= 1 || signalingProcess !== null}
                icon={<IconStop />}
                loading={
                  signalingProcess?.pid === process.pid &&
                  !signalingProcess.force
                }
                onClick={() => confirmSignalProcess(process, false)}
                size="mini"
              />
            </Tooltip>
            <Tooltip content="强制结束（KILL）">
              <Button
                aria-label={`强制结束进程 ${process.pid}`}
                disabled={process.pid <= 1 || signalingProcess !== null}
                icon={<IconThunderbolt />}
                loading={
                  signalingProcess?.pid === process.pid &&
                  signalingProcess.force
                }
                onClick={() => confirmSignalProcess(process, true)}
                size="mini"
                status="danger"
              />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [confirmSignalProcess, signalingProcess],
  );

  return (
    <WorkspaceToolSurface
      embedded={embedded}
      bodyStyle={{ padding: 0 }}
      className="server-process-drawer"
      footer={null}
      onCancel={onCancel}
      title="进程管理"
      visible={visible}
      width={1080}
    >
      <div className="server-process-toolbar">
        <Input.Search
          allowClear
          aria-label="筛选进程"
          className="server-process-query"
          onChange={setQuery}
          placeholder="搜索名称、PID、用户或命令"
          size="small"
          value={query}
        />
        <Space className="server-process-toolbar-actions" size="small">
          <Typography.Text type="secondary">
            {filteredProcesses.length} / {result?.processes.length ?? 0}
          </Typography.Text>
          <span className="server-process-auto-refresh">
            <Switch
              aria-label="自动刷新进程"
              checked={autoRefresh}
              onChange={setAutoRefresh}
              size="small"
            />
            <Typography.Text>自动刷新</Typography.Text>
          </span>
          <Tooltip
            content="刷新进程列表"
            getPopupContainer={() => document.body}
          >
            <Button
              aria-label="刷新进程列表"
              icon={<IconRefresh />}
              loading={loading}
              onClick={() => void loadProcesses()}
              size="small"
            />
          </Tooltip>
          <Button
            disabled={!selectedProcesses.length}
            icon={<IconRobot />}
            onClick={() =>
              onSendToAi(createProcessesAiHandoff(selectedProcesses))
            }
            size="small"
          >
            交给 AI
          </Button>
        </Space>
      </div>
      {(error || result?.truncated) && (
        <div className="server-process-alerts">
          {error && <Alert content={error} showIcon type="error" />}
          {result?.truncated && (
            <Alert
              content="进程数量较多，仅显示 CPU 占用最高的前 500 条"
              showIcon
              type="warning"
            />
          )}
        </div>
      )}
      <Table
        border={false}
        columns={columns}
        data={filteredProcesses}
        loading={loading && !result}
        noDataElement={
          <Empty description={query ? "没有匹配的进程" : "暂无进程"} />
        }
        pagination={false}
        rowKey="id"
        rowSelection={{
          checkAll: true,
          columnWidth: 36,
          onChange: (keys) =>
            setSelectedProcessIds(keys.map((key) => String(key))),
          selectedRowKeys: selectedProcessIds,
          type: "checkbox",
        }}
        scroll={{ x: PROCESS_TABLE_WIDTH, y: "calc(100vh - 180px)" }}
        size="mini"
        tableLayoutFixed
      />
    </WorkspaceToolSurface>
  );
}

export default ServerProcessDrawer;
