import type { ServerMonitorHistoryPoint, ServerMonitorSnapshot } from "./models";

export function appendMonitorHistory(
  history: ServerMonitorHistoryPoint[],
  snapshot: ServerMonitorSnapshot,
  collectedAt = Date.now(),
  limit = 48,
) {
  const previous = history[history.length - 1];
  const elapsedSeconds = previous ? (collectedAt - previous.collectedAt) / 1_000 : 0;
  const interfaceCounters = new Map(previous?.networkInterfaces?.map((item) => [item.name, item]));
  const receiveBytesPerSecond =
    previous && elapsedSeconds > 0
      ? Math.max(0, (snapshot.networkReceiveBytes - previous.networkReceiveBytes) / elapsedSeconds)
      : 0;
  const transmitBytesPerSecond =
    previous && elapsedSeconds > 0
      ? Math.max(
          0,
          (snapshot.networkTransmitBytes - previous.networkTransmitBytes) / elapsedSeconds,
        )
      : 0;

  return [
    ...history,
    {
      collectedAt,
      ...(snapshot.sshLatencyMs !== undefined && { sshLatencyMs: snapshot.sshLatencyMs }),
      cpuUsagePercent: snapshot.cpuUsagePercent,
      memoryUsagePercent: snapshot.memoryUsagePercent,
      diskUsagePercent: snapshot.diskUsagePercent,
      networkReceiveBytes: snapshot.networkReceiveBytes,
      networkTransmitBytes: snapshot.networkTransmitBytes,
      networkReceiveBytesPerSecond: receiveBytesPerSecond,
      networkTransmitBytesPerSecond: transmitBytesPerSecond,
      ...(snapshot.networkInterfaces && {
        networkInterfaces: snapshot.networkInterfaces.map((item) => {
          const prior = interfaceCounters.get(item.name);
          return {
            ...item,
            receiveBytesPerSecond:
              prior && elapsedSeconds > 0
                ? Math.max(0, (item.receiveBytes - prior.receiveBytes) / elapsedSeconds)
                : 0,
            transmitBytesPerSecond:
              prior && elapsedSeconds > 0
                ? Math.max(0, (item.transmitBytes - prior.transmitBytes) / elapsedSeconds)
                : 0,
          };
        }),
      }),
    },
  ].slice(-Math.max(1, limit));
}

export function monitorNetworkRates(
  point: ServerMonitorHistoryPoint | undefined,
  interfaceName: string,
) {
  const selected = point?.networkInterfaces?.find((item) => item.name === interfaceName);
  if (interfaceName)
    return {
      receive: selected?.receiveBytesPerSecond ?? 0,
      transmit: selected?.transmitBytesPerSecond ?? 0,
    };
  return {
    receive: point?.networkReceiveBytesPerSecond ?? 0,
    transmit: point?.networkTransmitBytesPerSecond ?? 0,
  };
}

export function formatMonitorBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatMonitorRate(bytesPerSecond: number) {
  return `${formatMonitorBytes(bytesPerSecond)}/s`;
}

export function formatLatency(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  return `${milliseconds.toFixed(milliseconds >= 10 ? 1 : 2)} ms`;
}

export function formatNetworkEndpoint(address: string, port: string) {
  if (!port) return address;
  const displayAddress = address.includes(":") ? `[${address}]` : address;
  return `${displayAddress}:${port}`;
}

export function formatMonitorPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value)}%`;
}

export function normalizeMonitorPercent(value: unknown) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    return value;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? formatMonitorPercent(numericValue) : undefined;
}

export function formatUptime(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}
