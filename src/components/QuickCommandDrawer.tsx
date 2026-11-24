import QuickCommandEditorModal from "./QuickCommandEditorModal";
import { addQuickCommandGroup, upsertQuickCommand } from "../configuration-mutations";
import type { FineShellConfiguration } from "../config-database";
import { emitProtocolEventTo } from "../tauri-protocol";
import { isTauri } from "@tauri-apps/api/core";
import { WorkspaceToolSurface } from "./WorkspaceToolPanel";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Message,
  Modal,
  Select,
  Space,
  Typography,
} from "@arco-design/web-react";
import { IconEdit, IconPaste, IconPlus, IconPlayArrow } from "@arco-design/web-react/icon";
import type { QuickCommandFormValues, QuickCommandRecord } from "../models";
import {
  filterQuickCommands,
  quickCommandFromForm,
  quickCommandParameters,
  renderQuickCommand,
} from "../quick-command-utils";

interface QuickCommandDrawerProps {
  canSend: boolean;
  commands: QuickCommandRecord[];
  onAfterClose?: () => void;
  onCancel?: () => void;
  onSend: (command: string, execute: boolean, sessionId?: string) => Promise<void>;
  onLibraryChange?: (configuration: FineShellConfiguration) => void;
  savedGroups: string[];
  targets?: { label: string; value: string }[];
  visible: boolean;
  embedded?: boolean;
  onEdit?: () => void;
}

interface CommandGroup {
  label: string;
  commands: QuickCommandRecord[];
}

function groupQuickCommands(commands: QuickCommandRecord[]) {
  const groups = new Map<string, QuickCommandRecord[]>();
  for (const command of commands) {
    const label = command.group || "未分组";
    const group = groups.get(label) ?? [];
    group.push(command);
    groups.set(label, group);
  }
  return [...groups].map<CommandGroup>(([label, groupedCommands]) => ({
    label,
    commands: groupedCommands,
  }));
}

function QuickCommandDrawer({
  canSend,
  commands,
  onAfterClose,
  onCancel,
  onSend,
  visible,
  embedded,
  onEdit,
  onLibraryChange,
  savedGroups,
  targets = [],
}: QuickCommandDrawerProps) {
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [creatingCommand, setCreatingCommand] = useState(false);
  const [saving, setSaving] = useState(false);
  const [targetId, setTargetId] = useState("");
  const targetAvailable = targetId ? targets.some((target) => target.value === targetId) : canSend;
  const targetOptions = [{ label: "当前会话", value: "" }, ...targets];
  if (targetId && !targetAvailable) {
    targetOptions.push({ label: "目标会话已断开", value: targetId });
  }
  const groups = useMemo(() => {
    const counts = new Map(savedGroups.map((group) => [group, 0]));
    for (const { group = "" } of commands) {
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts];
  }, [commands, savedGroups]);
  const activeGroup = groups.some(([group]) => group === selectedGroup) ? selectedGroup : null;
  const [pendingCommand, setPendingCommand] = useState<QuickCommandRecord | null>(null);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<{
    commandId: string;
    mode: "insert" | "execute";
  } | null>(null);

  const filteredCommands = useMemo(
    () =>
      filterQuickCommands(commands, query).filter(
        (command) => activeGroup === null || (command.group ?? "") === activeGroup,
      ),
    [activeGroup, commands, query],
  );
  const commandGroups = useMemo(() => groupQuickCommands(filteredCommands), [filteredCommands]);
  const parameters = useMemo(
    () => quickCommandParameters(pendingCommand?.command ?? ""),
    [pendingCommand],
  );

  useEffect(() => {
    if (visible) return;
    setPendingCommand(null);
    setParameterValues({});
  }, [visible]);

  const sendCommand = async (command: QuickCommandRecord, execute: boolean) => {
    if (!targetAvailable) {
      Message.warning("目标会话未连接");
      return;
    }
    const commandParameters = quickCommandParameters(command.command);
    if (commandParameters.length) {
      setPendingCommand(command);
      setParameterValues(
        Object.fromEntries(
          commandParameters.map((parameter) => [parameter.name, parameter.defaultValue ?? ""]),
        ),
      );
      return;
    }

    setSending({
      commandId: command.id,
      mode: execute ? "execute" : "insert",
    });
    try {
      await onSend(command.command, execute, targetId || undefined);
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSending(null);
    }
  };

  const sendParameterizedCommand = async (execute: boolean) => {
    if (!pendingCommand || !targetAvailable) return;
    const missingParameter = parameters.find(
      (parameter) => !parameter.defaultValue && !parameterValues[parameter.name]?.trim(),
    );
    if (missingParameter) {
      Message.warning(`请填写参数“${missingParameter.name}”`);
      return;
    }

    setSending({
      commandId: pendingCommand.id,
      mode: execute ? "execute" : "insert",
    });
    try {
      await onSend(
        renderQuickCommand(pendingCommand.command, parameterValues),
        execute,
        targetId || undefined,
      );
      setPendingCommand(null);
      setParameterValues({});
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSending(null);
    }
  };

  function applyLibraryChange(configuration: FineShellConfiguration) {
    onLibraryChange?.(configuration);
    if (isTauri()) {
      void Promise.allSettled([
        emitProtocolEventTo("main", "configuration:changed"),
        emitProtocolEventTo("settings", "configuration:changed"),
      ]);
    }
  }

  async function saveGroup() {
    const name = groupName?.trim();
    if (!name) {
      Message.warning("请输入分组名称");
      return;
    }
    if (saving) return;
    if (!groups.some(([group]) => group === name)) {
      setSaving(true);
      try {
        applyLibraryChange(await addQuickCommandGroup(name));
      } catch (error) {
        Message.error(String(error));
        return;
      } finally {
        setSaving(false);
      }
    }
    setSelectedGroup(name);
    setGroupName(null);
  }

  async function saveCommand(values: QuickCommandFormValues) {
    setSaving(true);
    try {
      const record = quickCommandFromForm(values);
      const configuration = await upsertQuickCommand(record);
      applyLibraryChange(configuration);
      setSelectedGroup(record.group ?? "");
      setCreatingCommand(false);
      Message.success("快捷命令已添加");
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <WorkspaceToolSurface
        embedded={embedded}
        afterClose={onAfterClose}
        bodyStyle={{ padding: 0 }}
        className="quick-command-drawer"
        footer={null}
        onCancel={onCancel}
        title="快捷命令"
        visible={visible}
        width={480}
      >
        {embedded && (
          <aside aria-label="快捷命令分组" className="quick-command-groups">
            <Button
              aria-pressed={activeGroup === null}
              onClick={() => setSelectedGroup(null)}
              size="small"
              type="text"
            >
              <span>全部</span>
              <span>{commands.length}</span>
            </Button>
            {groups.map(([group, count]) => (
              <Button
                aria-pressed={activeGroup === group}
                key={group}
                onClick={() => setSelectedGroup(group)}
                size="small"
                type="text"
              >
                <span title={group}>{group || "未分组"}</span>
                <span>{count}</span>
              </Button>
            ))}
            <Button
              className="quick-command-new-group"
              icon={<IconPlus />}
              onClick={() => setGroupName("")}
              size="small"
              type="text"
            >
              新建分组
            </Button>
          </aside>
        )}
        <div className="quick-command-main">
          <div className="quick-command-drawer-toolbar">
            {embedded && (
              <div className="quick-command-toolbar-actions">
                <Button icon={<IconPlus />} onClick={() => setCreatingCommand(true)} size="small">
                  新建命令
                </Button>
                {onEdit && (
                  <Button icon={<IconEdit />} onClick={onEdit} size="small">
                    命令编辑器
                  </Button>
                )}
              </div>
            )}
            <div className="quick-command-toolbar-search">
              {embedded && (
                <label className="quick-command-target">
                  <span>发送到</span>
                  <Select
                    aria-label="快捷命令发送目标"
                    disabled={sending !== null}
                    onChange={setTargetId}
                    options={targetOptions}
                    placeholder="当前会话"
                    size="small"
                    value={targetId}
                  />
                </label>
              )}
              <Input.Search
                allowClear
                aria-label="筛选快捷命令"
                className="quick-command-query"
                onChange={setQuery}
                placeholder="搜索名称、分组或命令"
                size="small"
                value={query}
              />
            </div>
          </div>
          {!targetAvailable && (
            <div className="quick-command-drawer-alert">
              <Alert content="目标会话未连接" showIcon type="warning" />
            </div>
          )}
          <div className="quick-command-drawer-content">
            {commandGroups.length ? (
              commandGroups.map((group) => (
                <section className="quick-command-group" key={group.label}>
                  <Typography.Text className="quick-command-group-title" type="secondary">
                    {group.label}
                  </Typography.Text>
                  <div className="quick-command-list">
                    {group.commands.map((command) => (
                      <div className="quick-command-list-item" key={command.id}>
                        <div className="quick-command-list-copy">
                          <Typography.Text bold>{command.name}</Typography.Text>
                          <Typography.Text className="quick-command-list-template" code>
                            {command.command}
                          </Typography.Text>
                          {command.description && (
                            <Typography.Text type="secondary">
                              {command.description}
                            </Typography.Text>
                          )}
                        </div>
                        <Space size="mini">
                          <Button
                            disabled={!targetAvailable || sending !== null}
                            icon={<IconPaste />}
                            loading={sending?.commandId === command.id && sending.mode === "insert"}
                            onClick={() => void sendCommand(command, false)}
                            size="mini"
                          >
                            填入
                          </Button>
                          <Button
                            disabled={!targetAvailable || sending !== null}
                            icon={<IconPlayArrow />}
                            loading={
                              sending?.commandId === command.id && sending.mode === "execute"
                            }
                            onClick={() => void sendCommand(command, true)}
                            size="mini"
                            type="primary"
                          >
                            执行
                          </Button>
                        </Space>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            ) : embedded ? (
              <p className="quick-command-empty">
                {query ? "没有匹配的快捷命令" : "暂无快捷命令，点击「新建命令」添加。"}
              </p>
            ) : (
              <Empty description={query ? "没有匹配的快捷命令" : "暂无快捷命令"} />
            )}
          </div>
        </div>
      </WorkspaceToolSurface>
      {visible && creatingCommand && (
        <QuickCommandEditorModal
          command={null}
          initialGroup={activeGroup ?? undefined}
          onCancel={() => setCreatingCommand(false)}
          onSubmit={(values) => void saveCommand(values)}
          submitting={saving}
          visible
        />
      )}
      {visible && groupName !== null && (
        <Modal
          confirmLoading={saving}
          onCancel={() => setGroupName(null)}
          onOk={() => void saveGroup()}
          title="新建命令分组"
          visible
        >
          <Input
            aria-label="分组名称"
            autoFocus
            maxLength={60}
            onChange={setGroupName}
            onPressEnter={() => void saveGroup()}
            value={groupName}
          />
        </Modal>
      )}
      {pendingCommand && (
        <Modal
          className="quick-command-parameter-modal"
          footer={null}
          maskClosable={false}
          onCancel={() => {
            if (sending) return;
            setPendingCommand(null);
            setParameterValues({});
          }}
          style={{ width: 560 }}
          title={pendingCommand.name}
          visible
        >
          <div className="quick-command-parameter-fields">
            {parameters.map((parameter, index) => (
              <label key={parameter.name}>
                <Typography.Text>{parameter.name}</Typography.Text>
                <Input
                  autoFocus={index === 0}
                  onChange={(value) =>
                    setParameterValues((current) => ({
                      ...current,
                      [parameter.name]: value,
                    }))
                  }
                  placeholder={parameter.defaultValue || "必填"}
                  value={parameterValues[parameter.name] ?? ""}
                />
              </label>
            ))}
          </div>
          <Typography.Text className="quick-command-parameter-preview" code>
            {renderQuickCommand(pendingCommand.command, parameterValues)}
          </Typography.Text>
          <div className="modal-actions">
            <Space>
              <Button
                disabled={sending !== null}
                onClick={() => {
                  setPendingCommand(null);
                  setParameterValues({});
                }}
              >
                取消
              </Button>
              <Button
                disabled={!targetAvailable}
                icon={<IconPaste />}
                loading={sending?.mode === "insert"}
                onClick={() => void sendParameterizedCommand(false)}
              >
                填入终端
              </Button>
              <Button
                disabled={!targetAvailable}
                icon={<IconPlayArrow />}
                loading={sending?.mode === "execute"}
                onClick={() => void sendParameterizedCommand(true)}
                type="primary"
              >
                执行
              </Button>
            </Space>
          </div>
        </Modal>
      )}
    </>
  );
}

export default QuickCommandDrawer;
