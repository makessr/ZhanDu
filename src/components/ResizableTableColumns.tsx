import { useRef, useState } from "react";
import type { TableColumnProps } from "@arco-design/web-react";

const minColumnWidth = 64;
const maxColumnWidth = 1200;

export function ColumnResizeHandle({ label, width, onResize }: {
  label: string;
  width: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; width: number } | null>(null);
  const resize = (value: number) => onResize(Math.min(maxColumnWidth, Math.max(minColumnWidth, value)));
  return (
    <span
      aria-label={label + "列宽"}
      aria-orientation="vertical"
      aria-valuemax={maxColumnWidth}
      aria-valuemin={minColumnWidth}
      aria-valuenow={width}
      className="table-column-grip"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        resize(width + (event.key === "ArrowRight" ? 12 : -12));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { startX: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
          resize(drag.current.width + event.clientX - drag.current.startX);
        }
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      role="separator"
      tabIndex={0}
      title="拖动调整列宽"
    />
  );
}

export function useResizableColumns<T>(columns: TableColumnProps<T>[]) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const resizableColumns = columns.map((column, index) => {
    const key = String(column.key ?? column.dataIndex ?? index);
    const width = widths[key] ?? (typeof column.width === "number" ? column.width : 160);
    return {
      ...column,
      key,
      width,
      headerCellStyle: { ...column.headerCellStyle, position: "relative" as const },
      title: <>
        {column.title}
        <ColumnResizeHandle
          label={typeof column.title === "string" ? column.title : key}
          width={width}
          onResize={(value) => setWidths((current) => ({ ...current, [key]: value }))}
        />
      </>,
    };
  });
  return {
    columns: resizableColumns,
    tableWidth: resizableColumns.reduce((total, column) => total + column.width, 0),
  };
}
