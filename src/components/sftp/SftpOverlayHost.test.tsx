import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SftpOverlayHost, { type SftpOverlayHostProps } from "./SftpOverlayHost";

function overlayProps(overrides: Partial<SftpOverlayHostProps> = {}): SftpOverlayHostProps {
  return {
    archive: {
      baseName: "",
      format: "zip",
      loading: false,
      onBaseNameChange: () => undefined,
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onFormatChange: () => undefined,
      state: null,
    },
    createEntry: {
      kind: null,
      loading: false,
      name: "",
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onNameChange: () => undefined,
    },
    externalEditConflict: {
      edit: null,
      loading: false,
      onCancel: () => undefined,
      onResolve: () => undefined,
    },
    pasteConflict: {
      conflictCount: 0,
      loading: false,
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onPolicyChange: () => undefined,
      policy: "rename",
      visible: false,
    },
    permissions: {
      entries: [],
      group: "",
      loading: false,
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onGroupChange: () => undefined,
      onOwnerChange: () => undefined,
      onPermissionChange: () => undefined,
      owner: "",
      parsedPermission: null,
      permission: "",
    },
    rename: {
      entry: null,
      loading: false,
      name: "",
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onNameChange: () => undefined,
    },
    textEditor: {
      byteLength: 0,
      maxBytes: 1024,
      onCancel: () => undefined,
      onChange: () => undefined,
      onSave: () => undefined,
      state: null,
    },
    transferDrawer: {
      embedded: false,
      externalEdits: [],
      onCancelTransfer: () => undefined,
      onClearFinished: () => undefined,
      onClose: () => undefined,
      onLocateRemoteTransfer: () => undefined,
      onOpenExternalEdit: () => undefined,
      onPauseTransfer: () => undefined,
      onRemoveTransfer: () => undefined,
      onResolveExternalEdit: () => undefined,
      onResumeTransfer: () => undefined,
      onRetryTransfer: () => undefined,
      transfers: [],
      visible: false,
    },
    ...overrides,
  };
}

describe("SftpOverlayHost", () => {
  test("keeps every dialog closed until its state exists", () => {
    render(<SftpOverlayHost {...overlayProps()} />);

    expect(screen.queryByText("重命名")).toBeNull();
    expect(screen.queryByText("发现同名项目")).toBeNull();
    expect(screen.queryByText("新建文件夹")).toBeNull();
    expect(screen.queryByLabelText("清除已结束传输和同步记录")).toBeNull();
  });

  test("forwards the transfer drawer state and its clear action", async () => {
    const onClearFinished = mock(() => undefined);
    await act(async () => {
      render(
        <SftpOverlayHost
          {...overlayProps()}
          transferDrawer={{
            ...overlayProps().transferDrawer,
            onClearFinished,
            transfers: [
              {
                bytesPerSecond: 0,
                direction: "download",
                fileName: "app.conf",
                localPath: "C:\\tmp\\app.conf",
                overwrite: false,
                remotePath: "/etc/app.conf",
                sampledAt: 1,
                sampledBytes: 12,
                sessionId: "session-1",
                status: "completed",
                totalBytes: 12,
                transferId: "transfer-1",
                transferredBytes: 12,
              },
            ],
            visible: true,
          }}
        />,
      );
    });

    fireEvent.click(screen.getByLabelText("清除已结束传输和同步记录"));
    expect(onClearFinished).toHaveBeenCalledTimes(1);
  });
});
