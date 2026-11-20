import { useMemo } from "react";
import { VChartSimple, type AreaChartProps, type BarChartProps } from "@visactor/react-vchart";
import {
  VChart,
  registerAreaChart,
  registerBarChart,
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
  normalizeMonitorPercent,
} from "../monitor-utils";

VChart.useRegisters([
  registerAreaChart,
  registerBarChart,
  registerCartesianBandAxis,
  registerCartesianLinearAxis,
  registerDiscreteLegend,
  registerDomTooltipHandler,
  registerTooltip,
]);

type MonitorChartProps = ({ type: "area" } & AreaChartProps) | ({ type: "bar" } & BarChartProps);

function MonitorChart({ className, height, ...spec }: MonitorChartProps) {
  return <VChartSimple vchartConstructor={VChart} className={className} style={{ height }} spec={spec} />;
}

interface UtilizationDatum {
  metric: string;
  value: number;
  displayValue: string;
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

function tooltipMetric(datum?: Record<string, unknown>) {
  return String(datum?.metric ?? "占用率");
}

function tooltipRate(datum?: Record<string, unknown>) {
  return formatMonitorRate(Number(datum?.value));
}

export function UtilizationChart({ utilizationData }: { utilizationData: UtilizationDatum[] }) {
  const appearance = useResolvedAppearance();
  const chartTextColor = appearance === "dark" ? "#c9cdd4" : "#4e5969";
  return (
    <MonitorChart
      type="bar"
      animation={false}
      axes={[
        {
          orient: "left",
          type: "band",
          label: { style: { fill: chartTextColor, fontSize: 11 } },
          tick: { visible: false },
        },
        {
          max: 100,
          min: 0,
          orient: "bottom",
          type: "linear",
          label: { visible: false },
          tick: { visible: false },
        },
      ]}
      bar={{ style: { cornerRadius: 2 } }}
      className="monitor-chart"
      color={["#165dff", "#00b42a", "#f7ba1e"]}
      data={[{ id: "utilization", values: utilizationData }]}
      direction="horizontal"
      height={105}
      padding={{ bottom: 8, left: 0, right: 0, top: 4 }}
      seriesField="metric"
      theme={appearance}
      tooltip={PERCENT_TOOLTIP}
      xField="value"
      yField="metric"
    />
  );
}

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

export function NetworkTrendChart({ monitorHistory }: { monitorHistory: ServerMonitorHistoryPoint[] }) {
  const appearance = useResolvedAppearance();
  const chartTextColor = appearance === "dark" ? "#c9cdd4" : "#4e5969";
  const networkTrendData = useMemo(
    () =>
      monitorHistory.flatMap((point) => {
        const time = new Date(point.collectedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return [
          { metric: "下载", time, value: point.networkReceiveBytesPerSecond },
          { metric: "上传", time, value: point.networkTransmitBytesPerSecond },
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
          orient: "left",
          type: "linear",
          label: { visible: false },
          tick: { visible: false },
        },
      ]}
      className="monitor-chart"
      color={["#165dff", "#f77234"]}
      data={[{ id: "network-trend", values: networkTrendData }]}
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
      stack={true}
      theme={appearance}
      tooltip={{
        dimension: {
          content: [{ key: tooltipMetric, value: tooltipRate }],
        },
        mark: {
          content: [{ key: tooltipMetric, value: tooltipRate }],
        },
      }}
      xField="time"
      yField="value"
    />
  );
}
