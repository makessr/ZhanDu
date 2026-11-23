import { useMemo } from "react";
import { VChartSimple, type AreaChartProps } from "@visactor/react-vchart";
import {
  VChart,
  registerAreaChart,
  registerCartesianBandAxis,
  registerCartesianLinearAxis,
  registerDiscreteLegend,
  registerDomTooltipHandler,
  registerTooltip,
  type ITooltipLineActual,
} from "@visactor/vchart";
import { useResolvedAppearance } from "../hooks/useResolvedAppearance";
import type { ServerMonitorHistoryPoint } from "../models";
import {
  formatMonitorPercent,
  formatMonitorRate,
  monitorNetworkRates,
  normalizeMonitorPercent,
} from "../monitor-utils";

VChart.useRegisters([
  registerAreaChart,
  registerCartesianBandAxis,
  registerCartesianLinearAxis,
  registerDiscreteLegend,
  registerDomTooltipHandler,
  registerTooltip,
]);

type MonitorChartProps = { type: "area" } & AreaChartProps;

function MonitorChart({ className, height, ...spec }: MonitorChartProps) {
  return <VChartSimple vchartConstructor={VChart} className={className} style={{ height }} spec={{ ...spec, background: "transparent" }} />;
}

function enforcePercentTooltipContent(content?: ITooltipLineActual[]) {
  return content?.map((line) => {
    const value = normalizeMonitorPercent(line.value as unknown);
    if (value === undefined || value === line.value) {
      return line;
    }
    return {
      ...line,
      value,
    };
  });
}

const PERCENT_TOOLTIP_CONTENT = {
  content: [{ key: { field: "metric" }, value: { field: "displayValue" } }],
  updateContent: enforcePercentTooltipContent,
};

const PERCENT_TOOLTIP = {
  dimension: PERCENT_TOOLTIP_CONTENT,
  mark: PERCENT_TOOLTIP_CONTENT,
};

export function ResourceTrendChart({ monitorHistory }: { monitorHistory: ServerMonitorHistoryPoint[] }) {
  const appearance = useResolvedAppearance();
  const chartTextColor = appearance === "dark" ? "#c9cdd4" : "#4e5969";
  const chartSecondaryTextColor = appearance === "dark" ? "rgba(255, 255, 255, 0.45)" : "#86909c";
  const trendData = useMemo(
    () =>
      monitorHistory.flatMap((point) => {
        const time = new Date(point.collectedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return [
          {
            metric: "CPU",
            time,
            value: Math.round(point.cpuUsagePercent),
            displayValue: formatMonitorPercent(point.cpuUsagePercent),
          },
          {
            metric: "内存",
            time,
            value: Math.round(point.memoryUsagePercent),
            displayValue: formatMonitorPercent(point.memoryUsagePercent),
          },
        ];
      }),
    [monitorHistory],
  );
  return (
    <MonitorChart
      type="area"
      animation={false}
      area={{ style: { fillOpacity: 0.12 } }}
      axes={[
        {
          orient: "bottom",
          type: "band",
          label: { visible: false },
          tick: { visible: false },
        },
        {
          max: 100,
          min: 0,
          orient: "left",
          type: "linear",
          label: {
            formatMethod: (value) => `${value}%`,
            style: { fill: chartSecondaryTextColor, fontSize: 10 },
          },
          tick: { visible: false },
        },
      ]}
      className="monitor-chart"
      color={["#165dff", "#00b42a"]}
      data={[{ id: "resource-trend", values: trendData }]}
      height={128}
      legends={{
        orient: "top",
        position: "start",
        item: {
          label: { style: { fill: chartTextColor, fontSize: 10 } },
        },
      }}
      line={{ style: { lineWidth: 2 } }}
      padding={{ bottom: 6, left: 0, right: 0, top: 22 }}
      point={{ style: { size: 2 }, visible: monitorHistory.length < 2 }}
      seriesField="metric"
      stack={false}
      theme={appearance}
      tooltip={PERCENT_TOOLTIP}
      xField="time"
      yField="value"
    />
  );
}

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
