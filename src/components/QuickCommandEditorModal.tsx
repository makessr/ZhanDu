import { Button, Form, Input, Modal, Space, Tooltip } from "@arco-design/web-react";
import { IconQuestionCircle } from "@arco-design/web-react/icon";
import type { QuickCommandFormValues, QuickCommandRecord } from "../models";

interface QuickCommandEditorModalProps {
  command: QuickCommandRecord | null;
  initialGroup?: string;
  submitting: boolean;
  visible: boolean;
  onCancel: () => void;
  onSubmit: (values: QuickCommandFormValues) => void;
}

export default function QuickCommandEditorModal({
  command,
  initialGroup,
  submitting,
  visible,
  onCancel,
  onSubmit,
}: QuickCommandEditorModalProps) {
  return (
    <Modal
      className="quick-command-editor-modal"
      footer={null}
      maskClosable={false}
      onCancel={onCancel}
      style={{ width: 680 }}
      title={command ? "编辑快捷命令" : "新增快捷命令"}
      visible={visible}
    >
      <Form<QuickCommandFormValues>
        initialValues={{
          name: command?.name ?? "",
          group: command?.group ?? initialGroup ?? "",
          command: command?.command ?? "",
          description: command?.description ?? "",
        }}
        layout="vertical"
        onSubmit={onSubmit}
      >
        <div className="quick-command-form-row">
          <Form.Item
            field="name"
            label="名称"
            rules={[{ required: true, message: "请输入快捷命令名称" }]}
          >
            <Input autoFocus maxLength={80} placeholder="例如：查看服务日志" />
          </Form.Item>
          <Form.Item field="group" label="分组">
            <Input maxLength={60} placeholder="可选" />
          </Form.Item>
        </div>
        <Form.Item
          field="command"
          label={
            <span className="quick-command-template-label">
              命令模板
              <Tooltip content="使用 {{参数}} 或 {{参数:默认值}} 插入动态参数">
                <IconQuestionCircle />
              </Tooltip>
            </span>
          }
          rules={[{ required: true, message: "请输入命令模板" }]}
        >
          <Input.TextArea
            autoSize={{ minRows: 5, maxRows: 10 }}
            maxLength={4000}
            placeholder="tail -n {{行数:100}} {{文件路径}}"
          />
        </Form.Item>
        <Form.Item field="description" label="备注">
          <Input maxLength={160} placeholder="可选" />
        </Form.Item>
        <div className="modal-actions">
          <Space>
            <Button disabled={submitting} onClick={onCancel}>
              取消
            </Button>
            <Button htmlType="submit" loading={submitting} type="primary">
              保存
            </Button>
          </Space>
        </div>
      </Form>
    </Modal>
  );
}
