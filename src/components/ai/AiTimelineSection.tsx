import type { AgentTask, AgentTaskRecoveryDecision } from "../../tauri-protocol";
import { agentTaskMayHaveRunningCommand, agentTaskNeedsRecovery } from "../../ai-task-recovery";
import AiMessageTimeline, { type AiMessageTimelineProps } from "../AiMessageTimeline";
import AiTaskRecoveryCard from "../AiTaskRecoveryCard";

export interface AiRecoveryCardModel {
  busyDecision?: AgentTaskRecoveryDecision;
  onDecision: (decision: AgentTaskRecoveryDecision) => void;
  task: AgentTask;
  sessionAvailable: boolean;
}

interface AiTimelineSectionProps {
  recovery?: AiRecoveryCardModel;
  timeline: AiMessageTimelineProps;
}

export default function AiTimelineSection({ recovery, timeline }: AiTimelineSectionProps) {
  return (
    <>
      <AiMessageTimeline {...timeline} />
      {recovery && agentTaskNeedsRecovery(recovery.task) && (
        <AiTaskRecoveryCard
          busyDecision={recovery.busyDecision}
          disconnected={recovery.task.status === "paused_disconnected"}
          onDecision={recovery.onDecision}
          reason={recovery.task.error ?? "AI 任务执行被中断"}
          remoteCommandMayBeRunning={agentTaskMayHaveRunningCommand(recovery.task)}
          sessionAvailable={recovery.sessionAvailable}
        />
      )}
    </>
  );
}
