import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { AgentTask } from "../../tauri-protocol";
import type { AiMessageTimelineActions } from "../AiMessageTimeline";
import AiTimelineSection from "./AiTimelineSection";

const noopActions = new Proxy({}, { get: () => () => undefined }) as AiMessageTimelineActions;

function timeline(overrides: Partial<Parameters<typeof AiTimelineSection>[0]["timeline"]> = {}) {
  return {
    actions: noopActions,
    activeConversationAvailable: true,
    applyingFileChanges: false,
    canInsertCommand: true,
    expandedToolRuns: new Set<string>(),
    hasRecentTerminalOutput: false,
    hostName: "生产服务器",
    loading: false,
    messages: [],
    scrollRef: createRef<HTMLDivElement>(),
    sending: false,
    sessionId: "session-1",
    ...overrides,
  };
}

function agentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    approvalMode: "on_request",
    actions: [],
    activeStepId: null,
    contextCapturedAt: 1,
    contextVersion: 1,
    conversationId: "conversation-1",
    createdAt: 1,
    currentDirectory: "/srv",
    diagnostics: {
      actionCount: 0,
      durationMs: 0,
      modelTurnCount: 0,
      planStepCount: 0,
      repairAttemptCount: 0,
      stopReason: null,
      verificationEvidenceCount: 0,
    },
    error: "连接已中断",
    hostId: "host-1",
    id: "task-1",
    iteration: 1,
    lastEventSequence: 1,
    modelCompleted: false,
    objective: "重启服务",
    plan: null,
    repairAttempts: 0,
    repairLimit: 2,
    repairStopReason: null,
    result: null,
    status: "paused",
    terminalSessionId: "session-1",
    updatedAt: 1,
    ...overrides,
  };
}

describe("AiTimelineSection", () => {
  test("shows the recovery card for paused tasks", () => {
    render(
      <AiTimelineSection
        recovery={{
          onDecision: () => undefined,
          sessionAvailable: true,
          task: agentTask(),
        }}
        timeline={timeline()}
      />,
    );
    expect(screen.getByRole("button", { name: "结束任务" })).toBeDefined();
  });

  test("hides the recovery card while the task keeps running", () => {
    render(
      <AiTimelineSection
        recovery={{
          onDecision: () => undefined,
          sessionAvailable: true,
          task: agentTask({ error: null, status: "running" }),
        }}
        timeline={timeline()}
      />,
    );
    expect(screen.queryByRole("button", { name: "结束任务" })).toBeNull();
    expect(screen.queryByText(/AI 任务执行被中断/)).toBeNull();
  });
});
