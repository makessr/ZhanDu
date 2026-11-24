import QuickCommandEditorModal from "./QuickCommandEditorModal";
import { quickCommandFromForm } from "../quick-command-utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Empty,
  Message,
  Popconfirm,
  Space,
  Table,
  Typography,
} from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { IconDelete, IconEdit, IconPlus } from "@arco-design/web-react/icon";
import { isTauri } from "@tauri-apps/api/core";
import { loadConfiguration } from "../config-database";
import { deleteQuickCommand, upsertQuickCommand } from "../configuration-mutations";
import type { QuickCommandFormValues, QuickCommandRecord } from "../models";
import { emitProtocolEventTo, listenProtocolEvent } from "../tauri-protocol";

function QuickCommandSettings() {
  const [commands, setCommands] = useState<QuickCommandRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingCommand, setEditingCommand] = useState<QuickCommandRecord | null>(null);

  const refresh = useCallback(async () => {
    const configuration = await loadConfiguration();
    setCommands(configuration.quickCommands);
  }, []);

  useEffect(() => {
    let disposed = false;
    void refresh()
      .catch((error) => {
        if (!disposed) Message.error(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenProtocolEvent("configuration:changed", () => {
      void refresh().catch((error) => Message.error(String(error)));
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const notifyMainWindow = async () => {
    if (!isTauri()) return;
    await emitProtocolEventTo("main", "configuration:changed").catch(() => undefined);
  };

  const saveCommand = async (values: QuickCommandFormValues) => {
    const command = quickCommandFromForm(values, editingCommand?.id);
    setActing(true);
    try {
      const configuration = await upsertQuickCommand(command);
      setCommands(configuration.quickCommands);
      await notifyMainWindow();
      setEditorVisible(false);
      setEditingCommand(null);
      Message.success(editingCommand ? "快捷命令已更新" : "快捷命令已添加");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const removeCommand = async (command: QuickCommandRecord) => {
    setActing(true);
    try {
      const configuration = await deleteQuickCommand(command.id);
      setCommands(configuration.quickCommands);
      await notifyMainWindow();
      Message.success(`已删除 ${command.name}`);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = useMemo<TableColumnProps<QuickCommandRecord>[]>(
    () => [
      {
        title: "快捷命令",
        dataIndex: "name",
        render: (_, command) => (
          <div className="quick-command-name-cell">
            <Typography.Text bold>{command.name}</Typography.Text>
            {command.description && (
              <Typography.Text type="secondary">{command.description}</Typography.Text>
            )}
          </div>
        ),
      },
      {
        title: "分组",
        dataIndex: "group",
        width: 120,
        render: (value) => value || "未分组",
      },
      {
        title: "命令模板",
        dataIndex: "command",
        render: (value) => (
          <Typography.Text className="quick-command-template-cell" code>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: "操作",
        width: 100,
        render: (_, command) => (
          <Space size="mini">
            <Button
              aria-label={`编辑 ${command.name}`}
              disabled={acting}
              icon={<IconEdit />}
              onClick={() => {
                setEditingCommand(command);
                setEditorVisible(true);
              }}
              size="mini"
            />
            <Popconfirm
              content={`确定删除快捷命令“${command.name}”？`}
              onOk={() => void removeCommand(command)}
            >
              <Button
                aria-label={`删除 ${command.name}`}
                disabled={acting}
                icon={<IconDelete />}
                size="mini"
                status="danger"
              />
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [acting],
  );

  return (
    <div className="quick-command-settings">
      <div className="quick-command-settings-heading">
        <Typography.Title heading={5}>快捷命令</Typography.Title>
        <Button
          disabled={loading || acting}
          icon={<IconPlus />}
          onClick={() => {
            setEditingCommand(null);
            setEditorVisible(true);
          }}
          type="primary"
        >
          新增命令
        </Button>
      </div>
      <Table
        border={false}
        columns={columns}
        data={commands}
        loading={loading}
        noDataElement={<Empty description="暂无快捷命令" />}
        pagination={false}
        rowKey="id"
        size="small"
        tableLayoutFixed
      />
      {editorVisible && (
        <QuickCommandEditorModal
          command={editingCommand}
          key={editingCommand?.id ?? "new-command"}
          onCancel={() => {
            setEditorVisible(false);
            setEditingCommand(null);
          }}
          onSubmit={(values) => void saveCommand(values)}
          submitting={acting}
          visible
        />
      )}
    </div>
  );
}

export default QuickCommandSettings;
