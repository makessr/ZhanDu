import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Table } from "@arco-design/web-react";
import { useResizableColumns } from "./ResizableTableColumns";

function NetworkFixture() {
  const table = useResizableColumns<{ local: string; process: string }>([
    { title: "本地地址", dataIndex: "local", width: 176 },
    { title: "进程", dataIndex: "process", width: 300 },
  ]);
  return (
    <Table
      columns={table.columns}
      data={[{ local: "255.255.255.255:65535", process: "openresty worker process (PID 1234567)" }]}
      pagination={false}
      rowKey="local"
      scroll={{ x: table.tableWidth }}
    />
  );
}

test("resizing a header keeps both values visible and changes only that column", () => {
  render(<NetworkFixture />);
  const grip = screen.getByRole("separator", { name: "本地地址列宽" });
  let captured = false;
  grip.setPointerCapture = () => {
    captured = true;
  };
  grip.hasPointerCapture = () => captured;
  fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 200 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: 244 });
  expect(grip.getAttribute("aria-valuenow")).toBe("220");
  expect(screen.getByRole("separator", { name: "进程列宽" }).getAttribute("aria-valuenow")).toBe(
    "300",
  );
  expect(screen.getByText("255.255.255.255:65535")).toBeDefined();
  expect(screen.getByText("openresty worker process (PID 1234567)")).toBeDefined();
});
