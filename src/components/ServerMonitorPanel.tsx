import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Radio,
  Skeleton,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import {
  IconBranch,
  IconCloudDownload,
  IconNav,
  IconRefresh,
  IconReply,
  IconRobot,
} from "@arco-design/web-react/icon";
import { diagnosticInvoke as invoke } from "../diagnostics";
import type {
  ServerMonitorHistoryPoint,
  ServerMonitorSnapshot,
  TerminalSession,
  NetworkConnection,
  NetworkConnectionsResult,
  NetworkPingResult,
  NetworkTraceResult,
  PortForwardStatus,
} from "../models";
import {
  appendMonitorHistory,
  formatLatency,
  formatMonitorBytes,
  formatMonitorPercent,
  formatMonitorRate,
  formatNetworkEndpoint,
  formatUptime,
} from "../monitor-utils";
import ServerProcessDrawer from "./ServerProcessDrawer";
import PortForwardDrawer from "./PortForwardDrawer";
import { commandErrorMessage } from "../tauri-protocol";
import { createNetworkAiHandoff, type AiHandoffRequest } from "../ai-handoff";
import ConnectionStatusOverlay from "./ConnectionStatusOverlay";
import { isTerminalSessionOperational } from "../terminal-utils";
import { useResolvedAppearance } from "../hooks/useResolvedAppearance";

const loadCharts = () => import("./ServerMonitorCharts");
const ResourceTrendChart = lazy(() =>
  loadCharts().then(({ ResourceTrendChart }) => ({ default: ResourceTrendChart })),
);
const NetworkTrendChart = lazy(() =>
  loadCharts().then(({ NetworkTrendChart }) => ({ default: NetworkTrendChart })),
);

interface ServerMonitorPanelProps {
  visible: boolean;
  refreshIntervalSeconds: number;
  session: TerminalSession | null;
  onReconnect: () => void;
  onSnapshotChange: (
    sessionId: string | null,
    snapshot: ServerMonitorSnapshot | null,
  ) => void;
  onPortForwardStatusChange: (status: PortForwardStatus) => void;
  onSendToAi: (sessionId: string, request: AiHandoffRequest) => void;
}

type ConnectionFilter = "all" | "listening" | "connected";

const CONNECTION_STATE_LABELS: Record<string, string> = {
  CLOSED: "已关闭",
  CLOSING: "正在关闭",
  "CLOSE-WAIT": "等待关闭",
  ESTAB: "已连接",
  "FIN-WAIT-1": "等待关闭",
  "FIN-WAIT-2": "等待关闭",
  "LAST-ACK": "最终确认",
  LISTEN: "监听",
  "SYN-RECV": "接收连接",
  "SYN-SENT": "正在连接",
  "TIME-WAIT": "等待回收",
  UNCONN: "无连接",
};

function isListeningConnection(connection: NetworkConnection) {
  return connection.state === "LISTEN" || connection.state === "UNCONN";
}

function connectionStateColor(state: string) {
  if (state === "ESTAB") return "green";
  if (state === "LISTEN" || state === "UNCONN") return "blue";
  if (state.includes("WAIT")) return "orange";
  return "gray";
}

function ServerMonitorPanel({
  visible,
  refreshIntervalSeconds,
  session,
  onReconnect,
  onSnapshotChange,
  onPortForwardStatusChange,
  onSendToAi,
}: ServerMonitorPanelProps) {
  const appearance = useResolvedAppearance();
  const chartSecondaryTextColor =
    appearance === "dark" ? "rgba(255, 255, 255, 0.45)" : "#86909c";
  const [chartsVisible, setChartsVisible] = useState(false);
  const [windowVisible, setWindowVisible] = useState(
    () => !document.hidden && !isTauri(),
  );
  const pendingSnapshotRef = useRef<{
    sessionId: string;
    request: Promise<ServerMonitorSnapshot>;
  }>();
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [history, setHistory] = useState<ServerMonitorHistoryPoint[]>([]);
  const [error, setError] = useState<string>();
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);
  const [processDrawerVisible, setProcessDrawerVisible] = useState(false);
  const [portForwardDrawerVisible, setPortForwardDrawerVisible] =
    useState(false);
  const [pingTarget, setPingTarget] = useState("1.1.1.1");
  const [pingResult, setPingResult] = useState<NetworkPingResult | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string>();
  const [connectionsResult, setConnectionsResult] =
    useState<NetworkConnectionsResult | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string>();
  const [connectionFilter, setConnectionFilter] =
    useState<ConnectionFilter>("all");
  const [traceResult, setTraceResult] = useState<NetworkTraceResult | null>(
    null,
  );
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string>();
  const diagnosticsGenerationRef = useRef(0);
  const pingRequestRef = useRef(0);
  const connectionsRequestRef = useRef(0);
  const traceRequestRef = useRef(0);
  const connected = Boolean(
    session && isTerminalSessionOperational(session.status),
  );
  const monitorSnapshot = connected ? snapshot : null;
  const monitorHistory = connected ? history : [];

  const resetMonitorState = useCallback(
    (sessionId: string | null) => {
      diagnosticsGenerationRef.current += 1;
      pingRequestRef.current += 1;
      connectionsRequestRef.current += 1;
      traceRequestRef.current += 1;
      setSnapshot(null);
      onSnapshotChange(sessionId, null);
      setHistory([]);
      setError(undefined);
      setPingResult(null);
      setPingLoading(false);
      setPingError(undefined);
      setConnectionsResult(null);
      setConnectionsLoading(false);
      setConnectionsError(undefined);
      setConnectionFilter("all");
      setTraceResult(null);
      setTraceLoading(false);
      setTraceError(undefined);
      setDiagnosticsVisible(false);
      setProcessDrawerVisible(false);
      setPortForwardDrawerVisible(false);
    },
    [onSnapshotChange],
  );

  useEffect(() => {
    resetMonitorState(session?.id ?? null);
  }, [resetMonitorState, session?.id]);

  useEffect(() => {
    if (!session || isTerminalSessionOperational(session.status)) return;
    resetMonitorState(session.id);
  }, [resetMonitorState, session?.id, session?.status]);

  useEffect(() => {
    if (!visible) {
      setWindowVisible(false);
      return;
    }

    const nativeWindow = isTauri() ? getCurrentWindow() : undefined;
    const unlisten: (() => void)[] = [];
    let disposed = false;
    let generation = 0;
    const updateVisibility = async () => {
      const request = ++generation;
      const minimized = await nativeWindow?.isMinimized().catch(() => false);
      if (!disposed && request === generation) {
        setWindowVisible(!document.hidden && !minimized);
      }
    };
    if (nativeWindow) {
      for (const registration of [
        nativeWindow.onFocusChanged(updateVisibility),
        nativeWindow.onResized(updateVisibility),
      ]) {
        void registration
          .then((stop) => {
            if (disposed) stop();
            else unlisten.push(stop);
          })
          .catch(() => undefined);
      }
    }
    void updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", updateVisibility);
      for (const stop of unlisten) stop();
    };
  }, [visible]);

  useEffect(() => {
    const sessionId = session?.id;
    if (
      !visible ||
      !windowVisible ||
      !sessionId ||
      !isTerminalSessionOperational(session.status)
    ) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collect = async () => {
      const pending = pendingSnapshotRef.current;
      const request = pending?.sessionId === sessionId
        ? pending.request
        : invoke<ServerMonitorSnapshot>("ssh_monitor_snapshot", { sessionId });
      pendingSnapshotRef.current = { sessionId, request };
      try {
        const next = await request;
        if (disposed) return;
        setSnapshot(next);
        onSnapshotChange(sessionId, next);
        setHistory((current) => appendMonitorHistory(current, next));
        setError(undefined);
      } catch (collectionError) {
        if (!disposed) setError(commandErrorMessage(collectionError));
      } finally {
        if (pendingSnapshotRef.current?.request === request) {
          pendingSnapshotRef.current = undefined;
        }
        if (!disposed) {
          timer = setTimeout(collect, refreshIntervalSeconds * 1_000);
        }
      }
    };

    void collect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    onSnapshotChange,
    refreshIntervalSeconds,
    session?.id,
    session?.status,
    visible,
    windowVisible,
  ]);

  const runPing = async (target = pingTarget) => {
    if (!session) return;
    const nextTarget = target.trim();
    const generation = diagnosticsGenerationRef.current;
    const requestId = ++pingRequestRef.current;
    const isCurrentRequest = () =>
      generation === diagnosticsGenerationRef.current &&
      requestId === pingRequestRef.current;
    setPingTarget(nextTarget);
    setPingLoading(true);
    setPingError(undefined);
    try {
      const result = await invoke<NetworkPingResult>("ssh_ping", {
        sessionId: session.id,
        target: nextTarget,
      });
      if (!isCurrentRequest()) return;
      setPingResult(result);
    } catch (pingFailure) {
      if (!isCurrentRequest()) return;
      setPingResult(null);
      setPingError(commandErrorMessage(pingFailure));
    } finally {
      if (isCurrentRequest()) setPingLoading(false);
    }
  };

  const loadNetworkConnections = async () => {
    if (!session) return;
    const generation = diagnosticsGenerationRef.current;
    const requestId = ++connectionsRequestRef.current;
    const isCurrentRequest = () =>
      generation === diagnosticsGenerationRef.current &&
      requestId === connectionsRequestRef.current;
    setConnectionsLoading(true);
    setConnectionsError(undefined);
    try {
      const result = await invoke<NetworkConnectionsResult>(
        "ssh_network_connections",
        { sessionId: session.id },
      );
      if (!isCurrentRequest()) return;
      setConnectionsResult(result);
    } catch (connectionFailure) {
      if (!isCurrentRequest()) return;
      setConnectionsResult(null);
      setConnectionsError(commandErrorMessage(connectionFailure));
    } finally {
      if (isCurrentRequest()) setConnectionsLoading(false);
    }
  };

  const openNetworkDiagnostics = () => {
    if (!session || !isTerminalSessionOperational(session.status)) return;
    setDiagnosticsVisible(true);
    if (!pingResult && !pingLoading) void runPing();
    if (!connectionsResult && !connectionsLoading) {
      void loadNetworkConnections();
    }
  };

  const runTraceRoute = async () => {
    if (!session) return;
    const target = pingTarget.trim();
    const generation = diagnosticsGenerationRef.current;
    const requestId = ++traceRequestRef.current;
    const isCurrentRequest = () =>
      generation === diagnosticsGenerationRef.current &&
      requestId === traceRequestRef.current;
    setTraceLoading(true);
    setTraceError(undefined);
    try {
      const result = await invoke<NetworkTraceResult>("ssh_trace_route", {
        sessionId: session.id,
        target,
      });
      if (!isCurrentRequest()) return;
      setTraceResult(result);
    } catch (traceFailure) {
      if (!isCurrentRequest()) return;
      setTraceResult(null);
      setTraceError(commandErrorMessage(traceFailure));
    } finally {
      if (isCurrentRequest()) setTraceLoading(false);
    }
  };

  const updateDiagnosticsTarget = (value: string) => {
    setPingTarget(value);
    const nextTarget = value.trim();
    if (pingResult?.target !== nextTarget) setPingResult(null);
    if (traceResult?.target !== nextTarget) setTraceResult(null);
  };

  const resourceMeters = [
    { label: "CPU", usage: monitorSnapshot?.cpuUsagePercent },
    {
      label: "内存",
      usage: monitorSnapshot?.memoryUsagePercent,
      bytes: monitorSnapshot && [monitorSnapshot.memoryUsedBytes, monitorSnapshot.memoryTotalBytes],
    },
    {
      label: "交换",
      usage: monitorSnapshot?.swap?.usagePercent,
      bytes: monitorSnapshot?.swap && [monitorSnapshot.swap.usedBytes, monitorSnapshot.swap.totalBytes],
    },
  ];
  const latestHistoryPoint = monitorHistory[monitorHistory.length - 1];
  const filteredConnections = useMemo(() => {
    const connections = connectionsResult?.connections ?? [];
    if (connectionFilter === "listening") {
      return connections.filter(isListeningConnection);
    }
    if (connectionFilter === "connected") {
      return connections.filter((connection) => connection.state === "ESTAB");
    }
    return connections;
  }, [connectionFilter, connectionsResult]);
  const connectionColumns = useMemo<TableColumnProps<NetworkConnection>[]>(
    () => [
      {
        dataIndex: "protocol",
        title: "协议",
        width: 68,
      },
      {
        dataIndex: "state",
        title: "状态",
        width: 96,
        render: (state: string) => (
          <Tag color={connectionStateColor(state)}>
            {CONNECTION_STATE_LABELS[state] ?? state}
          </Tag>
        ),
      },
      {
        title: "本地地址",
        render: (_, connection) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {formatNetworkEndpoint(
              connection.localAddress,
              connection.localPort,
            )}
          </Typography.Text>
        ),
      },
      {
        title: "远端地址",
        render: (_, connection) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {formatNetworkEndpoint(
              connection.remoteAddress,
              connection.remotePort,
            )}
          </Typography.Text>
        ),
      },
      {
        dataIndex: "process",
        title: "进程",
        width: 150,
        render: (process?: string) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>
            {process || "-"}
          </Typography.Text>
        ),
      },
    ],
    [],
  );

  const reconnecting = session?.status === "reconnecting";
  const suspect = session?.status === "suspect";
  const connectionUnavailable = Boolean(
    session &&
    (session.status === "failed" ||
      session.status === "disconnected" ||
      reconnecting ||
      Boolean(error && !suspect)),
  );
  const connectionDescription = reconnecting
    ? "正在重新连接服务器"
    : error || session?.error || "服务器连接已断开";
  const sendNetworkToAi = () => {
    if (
      !session ||
      pingLoading ||
      traceLoading ||
      connectionsLoading ||
      (!pingResult && !traceResult && !connectionsResult)
    ) {
      return;
    }
    onSendToAi(
      session.id,
      createNetworkAiHandoff({
        connections: connectionsResult,
        ping: pingResult,
        trace: traceResult,
      }),
    );
  };

  return (
    <section className={`server-monitor${connected ? "" : " is-unavailable"}`}>
      <div className="server-monitor-heading">
        <Typography.Text bold>服务器监控</Typography.Text>
        <Space size="mini">
          <Tooltip content="进程管理">
            <Button
              aria-label="打开进程管理"
              disabled={!connected}
              icon={<IconNav />}
              onClick={() => setProcessDrawerVisible(true)}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Tooltip content="网络诊断">
            <Button
              aria-label="打开网络诊断"
              disabled={!connected}
              icon={<IconCloudDownload />}
              onClick={openNetworkDiagnostics}
              size="mini"
              type="text"
            />
          </Tooltip>
          <Tooltip content="端口转发">
            <Button
              aria-label="打开端口转发"
              disabled={!session}
              icon={<IconReply />}
              onClick={() => setPortForwardDrawerVisible(true)}
              size="mini"
              type="text"
            />
          </Tooltip>
        </Space>
      </div>
      <dl className="monitor-system-facts">
        <div>
          <dt>系统</dt>
          <dd>{monitorSnapshot?.operatingSystem || "-"}</dd>
        </div>
        <div>
          <dt>主机名</dt>
          <dd>{monitorSnapshot?.hostname || "-"}</dd>
        </div>
        <div>
          <dt>内核</dt>
          <dd>{monitorSnapshot?.kernel || "-"}</dd>
        </div>
        <div>
          <dt>运行时间</dt>
          <dd>{monitorSnapshot ? formatUptime(monitorSnapshot.uptimeSeconds) : "-"}</dd>
        </div>
        <div>
          <dt>负载</dt>
          <dd>
            {monitorSnapshot
              ? monitorSnapshot.loadAverage
                  .map((value) => value.toFixed(2))
                  .join(" / ")
              : "-"}
          </dd>
        </div>
      </dl>

      <div className="monitor-chart-section">
        <div className="monitor-chart-heading">
          <Typography.Text bold>资源占用</Typography.Text>
        </div>
        <div className="monitor-resource-meters">
          {resourceMeters.map(({ label, usage, bytes }) => {
            const percent = typeof usage === "number" && Number.isFinite(usage)
              ? Math.min(100, Math.max(0, usage))
              : undefined;
            const value = percent === undefined ? "—" : formatMonitorPercent(percent);
            const amount = bytes?.map(formatMonitorBytes).join(" / ");
            const text = amount ? `${value}  ${amount}` : value;
            return (
              <div className="monitor-resource-row" key={label}>
                <span>{label}</span>
                <div
                  aria-label={label}
                  aria-valuenow={percent}
                  aria-valuetext={percent === undefined ? undefined : text}
                  className="monitor-resource-track"
                  role={percent === undefined ? undefined : "meter"}
                  title={text}
                >
                  <span aria-hidden className="monitor-resource-fill" style={{ width: `${percent ?? 0}%` }} />
                  <span className="monitor-resource-value">{text}</span>
                </div>
              </div>
            );
          })}
        </div>
        <Button
          aria-expanded={chartsVisible}
          disabled={!connected}
          onClick={() => setChartsVisible((current) => !current)}
          size="mini"
          type="text"
        >
          {chartsVisible ? "隐藏图表" : "显示图表"}
        </Button>
      </div>

      <div className="monitor-chart-section">
        <div className="monitor-chart-heading">
          <Typography.Text bold>资源趋势</Typography.Text>
          <Typography.Text type="secondary">
            {monitorSnapshot
              ? `磁盘 ${formatMonitorBytes(monitorSnapshot.diskUsedBytes)} / ${formatMonitorBytes(monitorSnapshot.diskTotalBytes)}`
              : "磁盘 - / -"}
          </Typography.Text>
        </div>
        {visible && windowVisible && connected && chartsVisible && (
          <Suspense fallback={null}>
            <ResourceTrendChart monitorHistory={monitorHistory} />
          </Suspense>
        )}
      </div>

      <div className="monitor-chart-section">
        <div className="monitor-chart-heading">
          <Typography.Text bold>网络流量</Typography.Text>
          <Typography.Text type="secondary">
            {monitorSnapshot
              ? `累计 ↓ ${formatMonitorBytes(monitorSnapshot.networkReceiveBytes)} / ↑ ${formatMonitorBytes(monitorSnapshot.networkTransmitBytes)}`
              : "累计 ↓ - / ↑ -"}
          </Typography.Text>
        </div>
        <div className="monitor-current-values monitor-network-values">
          <span>
            <span>下载</span>
            <strong>
              {monitorSnapshot
                ? formatMonitorRate(
                    latestHistoryPoint?.networkReceiveBytesPerSecond ?? 0,
                  )
                : "-"}
            </strong>
          </span>
          <span>
            <span>上传</span>
            <strong>
              {monitorSnapshot
                ? formatMonitorRate(
                    latestHistoryPoint?.networkTransmitBytesPerSecond ?? 0,
                  )
                : "-"}
            </strong>
          </span>
        </div>
        {visible && windowVisible && connected && chartsVisible && (
          <Suspense fallback={null}>
            <NetworkTrendChart monitorHistory={monitorHistory} />
          </Suspense>
        )}
      </div>
      <Drawer
        className="network-diagnostics-drawer"
        footer={null}
        onCancel={() => setDiagnosticsVisible(false)}
        title={
          <div className="network-diagnostics-drawer-title">
            <span>网络诊断</span>
            <Button
              disabled={
                pingLoading ||
                traceLoading ||
                connectionsLoading ||
                (!pingResult && !traceResult && !connectionsResult)
              }
              icon={<IconRobot />}
              onClick={sendNetworkToAi}
              size="small"
              type="text"
            >
              交给 AI
            </Button>
          </div>
        }
        visible={diagnosticsVisible}
        width={720}
      >
        <section className="network-diagnostics-section">
          <Typography.Text bold>Ping</Typography.Text>
          <Input.Search
            loading={pingLoading}
            onChange={updateDiagnosticsTarget}
            onSearch={(value) => void runPing(value)}
            placeholder="域名或 IP 地址"
            searchButton="测试"
            value={pingTarget}
          />
          {pingError && <Alert content={pingError} showIcon type="error" />}
          {pingLoading && !pingResult && (
            <Skeleton animation text={{ rows: 2, width: ["100%", "80%"] }} />
          )}
          {pingResult && (
            <Descriptions
              border
              column={2}
              data={[
                {
                  label: "状态",
                  value: (
                    <Tag color={pingResult.reachable ? "green" : "red"}>
                      {pingResult.reachable ? "可达" : "不可达"}
                    </Tag>
                  ),
                },
                {
                  label: "平均延迟",
                  value: formatLatency(pingResult.averageLatencyMs),
                },
                {
                  label: "丢包率",
                  value: formatMonitorPercent(pingResult.packetLossPercent),
                },
                {
                  label: "收发",
                  value: `${pingResult.received} / ${pingResult.transmitted}`,
                },
                {
                  label: "最低延迟",
                  value: formatLatency(pingResult.minimumLatencyMs),
                },
                {
                  label: "最高延迟",
                  value: formatLatency(pingResult.maximumLatencyMs),
                },
              ]}
              size="small"
            />
          )}
        </section>
        <section className="network-diagnostics-section">
          <div className="network-diagnostics-section-heading">
            <span>
              <Typography.Text bold>路由追踪</Typography.Text>
              {traceResult && (
                <Typography.Text type="secondary">
                  {traceResult.resolvedAddress ?? traceResult.target}
                </Typography.Text>
              )}
            </span>
            <Button
              icon={<IconBranch />}
              loading={traceLoading}
              onClick={() => void runTraceRoute()}
              size="small"
            >
              开始追踪
            </Button>
          </div>
          {traceError && <Alert content={traceError} showIcon type="error" />}
          {traceLoading && !traceResult && (
            <Skeleton
              animation
              text={{ rows: 3, width: ["70%", "85%", "60%"] }}
            />
          )}
          {traceResult && (
            <>
              <Tag color={traceResult.reached ? "green" : "orange"}>
                {traceResult.reached ? "已到达目标" : "未在最大跳数内到达"}
              </Tag>
              <Timeline className="network-trace-timeline" mode="left">
                {traceResult.hops.map((hop) => {
                  const reachedTarget =
                    hop.address ===
                    (traceResult.resolvedAddress ?? traceResult.target);
                  return (
                    <Timeline.Item
                      dotColor={
                        reachedTarget
                          ? "#00b42a"
                          : hop.address
                            ? "#165dff"
                            : chartSecondaryTextColor
                      }
                      key={hop.hop}
                      label={`第 ${hop.hop} 跳`}
                      lineType={hop.address ? "solid" : "dashed"}
                    >
                      <div className="network-trace-hop">
                        <Typography.Text>
                          {hop.address ?? "请求超时"}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {formatLatency(hop.latencyMs)}
                        </Typography.Text>
                      </div>
                    </Timeline.Item>
                  );
                })}
              </Timeline>
            </>
          )}
        </section>
        <section className="network-diagnostics-section">
          <div className="network-diagnostics-section-heading">
            <span>
              <Typography.Text bold>网络连接</Typography.Text>
              {connectionsResult && (
                <Typography.Text type="secondary">
                  {connectionsResult.connections.length} 条
                </Typography.Text>
              )}
            </span>
            <Tooltip content="刷新网络连接">
              <Button
                aria-label="刷新网络连接"
                icon={<IconRefresh />}
                loading={connectionsLoading}
                onClick={() => void loadNetworkConnections()}
                size="mini"
                type="text"
              />
            </Tooltip>
          </div>
          <Radio.Group
            mode="fill"
            onChange={setConnectionFilter}
            options={[
              { label: "全部", value: "all" },
              { label: "监听", value: "listening" },
              { label: "已连接", value: "connected" },
            ]}
            size="small"
            type="button"
            value={connectionFilter}
          />
          {connectionsError && (
            <Alert content={connectionsError} showIcon type="error" />
          )}
          {connectionsResult?.truncated && (
            <Alert
              content="连接数量较多，仅显示前 500 条"
              showIcon
              type="warning"
            />
          )}
          <Table
            border={false}
            columns={connectionColumns}
            data={filteredConnections}
            loading={connectionsLoading}
            noDataElement={<Empty description="暂无网络连接" />}
            pagination={false}
            rowKey="id"
            scroll={{ y: 320 }}
            size="small"
          />
        </section>
      </Drawer>
      {session && (
        <>
          <ServerProcessDrawer
            onCancel={() => setProcessDrawerVisible(false)}
            onSendToAi={(request) => onSendToAi(session.id, request)}
            session={session}
            visible={processDrawerVisible}
          />
          <PortForwardDrawer
            onCancel={() => setPortForwardDrawerVisible(false)}
            onStatusChange={onPortForwardStatusChange}
            session={session}
            visible={portForwardDrawerVisible}
          />
        </>
      )}
      {connectionUnavailable && (
        <ConnectionStatusOverlay
          description={connectionDescription}
          onReconnect={onReconnect}
          reconnecting={reconnecting}
        />
      )}
    </section>
  );
}

export default ServerMonitorPanel;
