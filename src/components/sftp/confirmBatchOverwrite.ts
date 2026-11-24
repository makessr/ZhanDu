import { Modal } from "@arco-design/web-react";

export default function confirmBatchOverwrite(title: string, content: string) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Modal.confirm({
      title,
      content,
      okText: "继续",
      cancelText: "取消",
      onOk: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}
