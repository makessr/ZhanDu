import type { ServerMonitorHistoryPoint } from "../models";
import { formatLatency, formatMonitorRate, monitorNetworkRates } from "../monitor-utils";

export function NetworkTrendChart({
  monitorHistory,
  interfaceName,
}: {
  monitorHistory: ServerMonitorHistoryPoint[];
  interfaceName: string;
}) {
  const bars = monitorHistory.map((point) => ({
    time: point.collectedAt,
    ...monitorNetworkRates(point, interfaceName),
  }));
  const maxRate = Math.max(1, ...bars.map(({ receive, transmit }) => Math.max(receive, transmit)));
  return (
    <div className="monitor-network-chart" role="img" aria-label="上传和下载速率趋势">
      {bars.some(({ receive, transmit }) => receive || transmit) && (
        <span className="monitor-network-scale">{formatMonitorRate(maxRate)}</span>
      )}
      <div className="monitor-network-bars">
        {bars.map(({ time, receive, transmit }) => (
          <div
            className="monitor-network-sample"
            key={time}
            title={`${new Date(time).toLocaleTimeString("zh-CN")}  ↑ ${formatMonitorRate(transmit)}  ↓ ${formatMonitorRate(receive)}`}
          >
            <span className="monitor-network-upload" style={{ height: `${transmit / maxRate * 100}%` }} />
            <span className="monitor-network-download" style={{ height: `${receive / maxRate * 100}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonitorLatencyChart({ history }: { history: ServerMonitorHistoryPoint[] }) {
  const samples = history.filter((point) => point.sshLatencyMs !== undefined);
  if (!samples.length) return null;
  const peak = Math.max(1, ...samples.map((point) => point.sshLatencyMs ?? 0));
  return (
    <div aria-label="SSH 延迟趋势" className="monitor-network-chart monitor-latency-chart" role="img">
      <span className="monitor-network-scale">{formatLatency(peak)}</span>
      <div className="monitor-network-bars">
        {samples.map(({ collectedAt, sshLatencyMs }) => (
          <div className="monitor-network-sample" key={collectedAt} title={formatLatency(sshLatencyMs)}>
            <span className="monitor-latency-bar" style={{ height: `${(sshLatencyMs ?? 0) / peak * 100}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
