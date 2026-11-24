import type { PointerEvent } from "react";
import { Tooltip, Typography } from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconExclamationCircle, IconFile, IconFolder, IconSync } from "@arco-design/web-react/icon";
import type { SftpEntry } from "../../models";
import { formatFileSize, formatPermissions, formatRemoteTime } from "../../sftp-utils";
import type { ExternalEditPayload } from "../../tauri-protocol";
import { externalEditStatusMeta } from "../TransferActivityList";

const sftpNameCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export interface SftpColumnDragHandlers {
  cancel: (event: PointerEvent<HTMLElement>) => void;
  finish: (event: PointerEvent<HTMLElement>) => void;
  move: (event: PointerEvent<HTMLElement>) => void;
  start: (event: PointerEvent<HTMLElement>, entry: SftpEntry) => void;
}

interface BuildSftpTableColumnsOptions {
  drag: SftpColumnDragHandlers;
  externalEditForPath: (path: string) => ExternalEditPayload | undefined;
  operationLoading: boolean;
  ready: boolean;
}

function ExternalEditStatusIcon({ edit }: { edit: ExternalEditPayload }) {
  const status = externalEditStatusMeta(edit.status);

  return (
    <Tooltip content={edit.error || status.label}>
      <span
        aria-label={status.label}
        className={`sftp-external-edit-status sftp-external-edit-status-${status.tone}`}
      >
        {edit.status === "conflict" || edit.status === "failed" ? (
          <IconExclamationCircle />
        ) : (
          <IconSync />
        )}
      </span>
    </Tooltip>
  );
}

export default function buildSftpTableColumns({
  drag,
  externalEditForPath,
  operationLoading,
  ready,
}: BuildSftpTableColumnsOptions): TableColumnProps<SftpEntry>[] {
  return [
    {
      title: "名称",
      dataIndex: "name",
      width: 300,
      sorter: (left, right) => sftpNameCollator.compare(left.name, right.name),
      render: (_, entry) => {
        const externalEdit = externalEditForPath(entry.path);
        return (
          <div
            className={`sftp-name-cell${ready && !operationLoading ? " is-draggable" : ""}`}
            onLostPointerCapture={drag.cancel}
            onPointerCancel={drag.cancel}
            onPointerDown={(event) => drag.start(event, entry)}
            onPointerMove={drag.move}
            onPointerUp={drag.finish}
          >
            {entry.kind === "directory" ? <IconFolder /> : <IconFile />}
            <Typography.Text ellipsis>{entry.name}</Typography.Text>
            {externalEdit && <ExternalEditStatusIcon edit={externalEdit} />}
          </div>
        );
      },
    },
    {
      title: "大小",
      dataIndex: "size",
      sorter: (left, right) => left.size - right.size,
      width: 110,
      render: (_, entry) => (entry.kind === "directory" ? "-" : formatFileSize(entry.size)),
    },
    {
      key: "owner",
      title: "用户 / 用户组",
      width: 140,
      render: (_, entry) =>
        entry.owner || entry.group ? `${entry.owner ?? "-"} / ${entry.group ?? "-"}` : "-",
    },
    {
      title: "权限",
      dataIndex: "permissions",
      width: 86,
      render: (value) => formatPermissions(value),
    },
    {
      title: "修改时间",
      dataIndex: "modifiedAt",
      sorter: (left, right) => (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0),
      width: 150,
      render: (value) => formatRemoteTime(value),
    },
  ];
}
