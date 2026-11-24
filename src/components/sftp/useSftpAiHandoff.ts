import { useState } from "react";
import { Message } from "@arco-design/web-react";
import { diagnosticInvoke as invoke } from "../../diagnostics";
import type { SftpEntry } from "../../models";
import {
  MAX_AI_REMOTE_FILES,
  MAX_AI_REMOTE_FILES_BYTES,
  aiRemoteFileContextError,
  aiRemoteFileSensitivityWarning,
  type AiRemoteFileContext,
} from "../../ai-utils";
import type { RemoteTextFile } from "./SftpDialogs";

interface UseSftpAiHandoffOptions {
  confirmOverwrite: (title: string, content: string) => Promise<boolean>;
  disabled: boolean;
  onLoadingChange: (loading: boolean) => void;
  onOperationError: (error: unknown) => void;
  sendFilesToAi: (sessionId: string, files: AiRemoteFileContext[]) => void | Promise<void>;
  sessionId?: string;
}

export default function useSftpAiHandoff({
  confirmOverwrite,
  disabled,
  onLoadingChange,
  onOperationError,
  sendFilesToAi,
  sessionId,
}: UseSftpAiHandoffOptions) {
  const [aiFileReadProgress, setAiFileReadProgress] = useState<{
    completed: number;
    total: number;
  }>();

  async function sendEntriesToAi(entries: SftpEntry[]) {
    if (!sessionId || disabled) return;
    const files = entries.filter((entry) => entry.kind === "file");
    if (!files.length) return;
    if (files.length > MAX_AI_REMOTE_FILES) {
      Message.warning(`每次最多发送 ${MAX_AI_REMOTE_FILES} 个文件给 AI`);
      return;
    }
    const selectedBytes = files.reduce((total, entry) => total + entry.size, 0);
    if (selectedBytes > MAX_AI_REMOTE_FILES_BYTES) {
      Message.warning("所选文件总大小不能超过 512 KiB");
      return;
    }
    const invalidFile = files.find((entry) => Boolean(aiRemoteFileContextError(entry.size)));
    if (invalidFile) {
      Message.warning(`${invalidFile.name}：${aiRemoteFileContextError(invalidFile.size)}`);
      return;
    }

    onLoadingChange(true);
    setAiFileReadProgress({ completed: 0, total: files.length });
    try {
      const contexts: AiRemoteFileContext[] = [];
      for (const entry of files) {
        const document = await invoke<RemoteTextFile>("sftp_read_text_file", {
          sessionId,
          path: entry.path,
        });
        const documentSizeError = aiRemoteFileContextError(document.size);
        if (documentSizeError) {
          throw new Error(`${entry.name}：${documentSizeError}`);
        }
        contexts.push({
          content: document.content,
          name: entry.name,
          path: document.path,
          size: document.size,
        });
        setAiFileReadProgress({
          completed: contexts.length,
          total: files.length,
        });
      }
      const sensitiveFiles = contexts
        .map((file) => ({
          file,
          warning: aiRemoteFileSensitivityWarning(file.path, file.content),
        }))
        .filter((item): item is { file: AiRemoteFileContext; warning: string } =>
          Boolean(item.warning),
        );
      if (sensitiveFiles.length) {
        const confirmed = await confirmOverwrite(
          "发送敏感文件给 AI？",
          `${sensitiveFiles
            .map(({ file, warning }) => `${file.name}：${warning}`)
            .join(
              "\n",
            )}\n\n发送请求时会自动隐藏已识别的凭据，但仍建议确认文件内容适合交给当前 AI 服务。`,
        );
        if (!confirmed) return;
      }
      await sendFilesToAi(sessionId, contexts);
    } catch (error) {
      onOperationError(error);
    } finally {
      setAiFileReadProgress(undefined);
      onLoadingChange(false);
    }
  }

  return { aiFileReadProgress, sendEntriesToAi };
}
