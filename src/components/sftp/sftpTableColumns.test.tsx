import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TableColumnProps } from "@arco-design/web-react";
import type { SftpEntry } from "../../models";
import buildSftpTableColumns from "./sftpTableColumns";

const entry: SftpEntry = {
  id: "entry-1",
  kind: "directory",
  modifiedAt: 1_700_000_000,
  name: "logs",
  owner: "root",
  path: "/var/logs",
  permissions: 493,
  size: 0,
};

function cell(columns: TableColumnProps<SftpEntry>[], index: number) {
  const column = columns[index];
  return column.render as (value: unknown, entry: SftpEntry, index: number) => unknown;
}

describe("buildSftpTableColumns", () => {
  test("keeps the established column order and widths", () => {
    const columns = buildSftpTableColumns({
      drag: {
        cancel: () => undefined,
        finish: () => undefined,
        move: () => undefined,
        start: () => undefined,
      },
      externalEditForPath: () => undefined,
      operationLoading: false,
      ready: true,
    });

    expect(columns.map((column) => column.title)).toEqual([
      "名称",
      "大小",
      "用户 / 用户组",
      "权限",
      "修改时间",
    ]);
    expect(columns[0].sorter).toBeFunction();
  });

  test("sorts names numerically and sizes ascending", () => {
    const columns = buildSftpTableColumns({
      drag: {
        cancel: () => undefined,
        finish: () => undefined,
        move: () => undefined,
        start: () => undefined,
      },
      externalEditForPath: () => undefined,
      operationLoading: false,
      ready: true,
    });

    const nameSorter = columns[0].sorter as (left: SftpEntry, right: SftpEntry) => number;
    expect(nameSorter({ ...entry, name: "file2" }, { ...entry, name: "file10" })).toBeLessThan(0);

    const sizeSorter = columns[1].sorter as (left: SftpEntry, right: SftpEntry) => number;
    expect(sizeSorter({ ...entry, size: 2 }, { ...entry, size: 10 })).toBeLessThan(0);
  });

  test("marks a row as draggable only when the browser is ready", () => {
    const drag = {
      cancel: mock(() => undefined),
      finish: mock(() => undefined),
      move: mock(() => undefined),
      start: mock(() => undefined),
    };
    const columns = buildSftpTableColumns({
      drag,
      externalEditForPath: () => undefined,
      operationLoading: false,
      ready: true,
    });

    const { container } = render(<>{cell(columns, 0)(undefined, entry, 0) as never}</>);
    const nameCell = container.querySelector(".sftp-name-cell");
    expect(nameCell?.className).toContain("is-draggable");
    fireEvent.pointerDown(nameCell as Element, { button: 0, pointerId: 1 });
    expect(drag.start).toHaveBeenCalledWith(expect.anything(), entry);
  });

  test("shows the external edit status icon for a synced file", () => {
    const columns = buildSftpTableColumns({
      drag: {
        cancel: () => undefined,
        finish: () => undefined,
        move: () => undefined,
        start: () => undefined,
      },
      externalEditForPath: () => ({
        editId: "edit-1",
        fileName: "app.conf",
        localPath: "C:\\tmp\\app.conf",
        remotePath: "/etc/app.conf",
        sessionId: "session-1",
        status: "synced",
      }),
      operationLoading: false,
      ready: true,
    });

    render(
      <>
        {
          cell(columns, 0)(
            undefined,
            { ...entry, kind: "file", name: "app.conf", path: "/etc/app.conf" },
            0,
          ) as never
        }
      </>,
    );

    expect(screen.getByText("app.conf")).not.toBeNull();
    expect(screen.getByLabelText("已同步")).not.toBeNull();
  });

  test("renders directory sizes as a dash", () => {
    const columns = buildSftpTableColumns({
      drag: {
        cancel: () => undefined,
        finish: () => undefined,
        move: () => undefined,
        start: () => undefined,
      },
      externalEditForPath: () => undefined,
      operationLoading: false,
      ready: true,
    });

    expect(cell(columns, 1)(0, entry, 0)).toBe("-");
  });
});
