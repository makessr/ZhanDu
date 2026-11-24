import { useMemo, type ReactNode } from "react";
import {
  aiRemoteFileContextSource,
  formatAiServerContext,
  type AiContextSource,
  type AiRemoteFileContext,
} from "../ai-utils";
import type { SessionStore } from "../session-store";
import { useSessionField } from "../session-store";

interface AiContextSourcesBridgeProps {
  businessContexts: AiContextSource[];
  children: (sources: AiContextSource[]) => ReactNode;
  remoteFileContexts: AiRemoteFileContext[];
  sessionId: string | null;
  store: SessionStore | null;
  terminalSelection: string;
}

export default function AiContextSourcesBridge({
  businessContexts,
  children,
  remoteFileContexts,
  sessionId,
  store,
  terminalSelection,
}: AiContextSourcesBridgeProps) {
  const monitorSnapshot = useSessionField(store, (slice) => slice.monitorSnapshot, null);
  const sftpCurrentPath = useSessionField(store, (slice) => slice.sftpCurrentPath, "");
  const terminalOutput = useSessionField(store, (slice) => slice.terminalRecentOutput, "");

  const sources = useMemo<AiContextSource[]>(() => {
    if (!sessionId) return [];
    const next: AiContextSource[] = [
      { id: "terminal-selection", label: "终端选区", content: terminalSelection },
      { id: "terminal-output", label: "最近终端输出", content: terminalOutput },
      {
        id: "server-monitor",
        label: "服务器状态",
        content: monitorSnapshot ? formatAiServerContext(monitorSnapshot) : "",
      },
      { id: "sftp-path", label: "当前远程目录", content: sftpCurrentPath },
    ];
    next.push(...businessContexts);
    next.push(...remoteFileContexts.map(aiRemoteFileContextSource));
    return next;
  }, [
    businessContexts,
    monitorSnapshot,
    remoteFileContexts,
    sftpCurrentPath,
    sessionId,
    terminalOutput,
    terminalSelection,
  ]);

  return <>{children(sources)}</>;
}
