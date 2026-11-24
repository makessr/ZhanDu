import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AgentActionExecutionResult, AgentTask } from "../tauri-protocol";
import type { AiConversation, AiMessage } from "./useAiConversations";
import useAiAgentBridge, { type AiAgentBridgeTransport } from "./useAiAgentBridge";

const invokeMock = mock(async (command: string, _args?: unknown): Promise<unknown> => {
  if (command === "ai_task_action_approve") return "credential-1";
  return { actionId: "action-1", actionType: "terminal_command", affectedPaths: [] };
});
const unlistenMock = mock(() => {});
let capturedListener: ((event: { payload: unknown }) => void) | undefined;
const transport: AiAgentBridgeTransport = {
  invoke: invokeMock as unknown as AiAgentBridgeTransport["invoke"],
  listen: (async (_event: string, handler: (event: { payload: unknown }) => void) => {
    capturedListener = handler;
    return unlistenMock;
  }) as unknown as AiAgentBridgeTransport["listen"],
};

function message(overrides: Partial<AiMessage> = {}): AiMessage {
  return { content: "继续排查", id: "message-1", role: "assistant", ...overrides };
}

function conversation(messages: AiMessage[]): AiConversation {
  return {
    createdAt: "2026-07-28T08:00:00.000Z",
    hostId: "host-1",
    hostName: "生产服务器",
    id: "conversation-1",
    messages,
    title: "检查服务",
    updatedAt: "2026-07-28T08:00:00.000Z",
  };
}

function agentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    approvalMode: "on_request",
    contextCapturedAt: 1,
    contextVersion: 1,
    conversationId: "conversation-1",
    currentDirectory: "/srv",
    hostId: "host-1",
    id: "task-1",
    terminalSessionId: "session-1",
    actions: [],
    createdAt: 1,
    diagnostics: {
      actionCount: 0,
      durationMs: 0,
      modelTurnCount: 0,
      planStepCount: 0,
      repairAttemptCount: 0,
      stopReason: null,
      verificationEvidenceCount: 0,
    },
    error: null,
    iteration: 1,
    lastEventSequence: 1,
    modelCompleted: false,
    objective: "重启服务",
    plan: null,
    activeStepId: null,
    repairAttempts: 0,
    repairLimit: 2,
    repairStopReason: null,
    result: null,
    status: "running",
    updatedAt: 1,
    ...overrides,
  };
}

function renderBridge(
  messages: AiMessage[],
  options: {
    onAgentActionExecuted?: (sessionId: string, result: AgentActionExecutionResult) => void;
  } = {},
) {
  let current = conversation(messages);
  const updateMessages = mock(
    (_hostId: string, _conversationId: string, update: (current: AiMessage[]) => AiMessage[]) => {
      current = { ...current, messages: update(current.messages) };
    },
  );
  const onAgentActionExecuted = mock(options.onAgentActionExecuted ?? (() => undefined));
  const view = renderHook(() =>
    useAiAgentBridge({
      conversationsByHost: { "host-1": [current] },
      onAgentActionExecuted,
      sessionId: "session-1",
      transport,
      updateMessages,
    }),
  );
  return { messages: () => current.messages, onAgentActionExecuted, updateMessages, view };
}

describe("useAiAgentBridge", () => {
  test("forwards action transitions with the task id of the message", async () => {
    const { view } = renderBridge([message({ taskId: "task-1" })]);
    await act(async () => {
      await view.result.current.transitionAgentAction("message-1", "action-1", "start", {
        summary: "开始执行",
      });
    });
    expect(invokeMock).toHaveBeenCalledWith("ai_task_action_transition", {
      request: { actionId: "action-1", summary: "开始执行", taskId: "task-1", transition: "start" },
    });
  });

  test("rejects transitions for messages without a task", async () => {
    const { view } = renderBridge([message()]);
    await expect(
      view.result.current.transitionAgentAction("message-1", "action-1", "start"),
    ).rejects.toThrow("AI 动作缺少对应的任务");
  });

  test("approves and executes an agent action, then reports the result", async () => {
    const executionResult = {
      actionId: "action-1",
      actionType: "terminal_command",
      affectedPaths: [],
      file: null,
      command: null,
    } as unknown as AgentActionExecutionResult;
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) =>
      command === "ai_task_action_approve" ? "credential-1" : executionResult,
    );
    const { onAgentActionExecuted, view } = renderBridge([message({ taskId: "task-1" })]);

    let result: AgentActionExecutionResult | undefined;
    await act(async () => {
      result = await view.result.current.executeAgentAction("message-1", "action-1");
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_task_action_approve", {
      request: {
        actionId: "action-1",
        contentOverride: undefined,
        rollback: false,
        taskId: "task-1",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "ai_task_action_execute", {
      request: {
        actionId: "action-1",
        approvalCredential: "credential-1",
        contentOverride: undefined,
        rollback: false,
        taskId: "task-1",
      },
    });
    expect(result).toBe(executionResult);
    expect(onAgentActionExecuted).toHaveBeenCalledWith("session-1", executionResult);
  });

  test("skips the approval request when the action is executed without user confirmation", async () => {
    invokeMock.mockClear();
    const { view } = renderBridge([message({ taskId: "task-1" })]);
    await act(async () => {
      await view.result.current.executeAgentAction("message-1", "action-1", true, "new", false);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ai_task_action_execute", {
      request: {
        actionId: "action-1",
        approvalCredential: null,
        contentOverride: "new",
        rollback: true,
        taskId: "task-1",
      },
    });
  });

  test("reconciles command execution state from ai-task events", async () => {
    const { messages, updateMessages, view } = renderBridge([
      message({
        taskId: "task-1",
        commandProposals: [
          {
            assessment: { canInsert: true, label: "低风险", risk: "safe" },
            command: "systemctl restart app",
            id: "proposal-1",
            purpose: "重启服务",
            sessionId: "session-1",
            status: "executed",
          },
        ],
      }),
    ]);
    expect(view.result.current.reconcileTaskCommandExecutions).toBeFunction();
    await waitFor(() => expect(capturedListener).toBeFunction());

    act(() => {
      capturedListener?.({
        payload: {
          protocolVersion: 1,
          sequence: 2,
          kind: "task_updated",
          task: agentTask({
            actions: [
              {
                id: "proposal-1",
                tool: "run_command",
                reason: "重启服务",
                expectedEffect: "服务恢复",
                risk: "low_risk",
                status: "succeeded",
                summary: null,
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
                verificationStatus: "verified",
                verificationEvidence: [],
                recoveryState: null,
                commandExecution: {
                  submissionId: "submission-1",
                  phase: "completed",
                  outputExcerpt: "OK\n",
                  outputTruncated: false,
                  stdoutExcerpt: "OK\n",
                  stdoutTruncated: false,
                  stderrExcerpt: "",
                  stderrTruncated: false,
                  exitCode: 0,
                  durationMs: 120,
                  reason: null,
                  submittedAt: 1,
                  updatedAt: 2,
                  completedAt: 2,
                },
              },
            ],
          }),
        },
      });
    });

    expect(updateMessages).toHaveBeenCalledWith("host-1", "conversation-1", expect.any(Function));
    const proposal = messages()[0].commandProposals?.[0];
    expect(proposal?.status).toBe("succeeded");
    expect(proposal?.exitCode).toBe(0);
    expect(proposal?.resultOutput).toContain("OK");
  });
});
