import { useCallback, useEffect, useRef } from "react";
import type { AiActionExecutionHandler, AiActionTransitionHandler } from "../ai-action-lifecycle";
import { reconcileAiCommandProposalExecution } from "../ai-command-proposals";
import { diagnosticInvoke, recordDiagnostic } from "../diagnostics";
import {
  commandErrorMessage,
  listenProtocolEvent,
  type AgentActionExecutionResult,
  type AgentTask,
  type TauriCommand,
} from "../tauri-protocol";
import type { AiConversation } from "./useAiConversations";

export interface AiAgentBridgeTransport {
  invoke: <T>(command: TauriCommand, args?: Record<string, unknown>) => Promise<T>;
  listen: typeof listenProtocolEvent;
}

const DEFAULT_TRANSPORT: AiAgentBridgeTransport = {
  invoke: diagnosticInvoke,
  listen: listenProtocolEvent,
};

interface UseAiAgentBridgeOptions {
  conversationsByHost: Record<string, AiConversation[]>;
  onAgentActionExecuted: (sessionId: string, result: AgentActionExecutionResult) => void;
  sessionId: string | null;
  transport?: AiAgentBridgeTransport;
  updateMessages: (
    hostId: string,
    conversationId: string,
    update: (current: AiConversation["messages"]) => AiConversation["messages"],
  ) => void;
}

export default function useAiAgentBridge({
  conversationsByHost,
  onAgentActionExecuted,
  sessionId,
  transport = DEFAULT_TRANSPORT,
  updateMessages,
}: UseAiAgentBridgeOptions) {
  const { invoke, listen } = transport;
  const conversationsByHostRef = useRef(conversationsByHost);
  conversationsByHostRef.current = conversationsByHost;

  const taskIdForMessage = useCallback(
    (messageId: string) =>
      Object.values(conversationsByHost)
        .flat()
        .flatMap((conversation) => conversation.messages)
        .find((message) => message.id === messageId)?.taskId,
    [conversationsByHost],
  );

  const transitionAgentAction = useCallback<AiActionTransitionHandler>(
    async (messageId, actionId, transition, detail) => {
      const taskId = taskIdForMessage(messageId);
      if (!taskId) throw new Error("AI 动作缺少对应的任务");
      await invoke("ai_task_action_transition", {
        request: {
          taskId,
          actionId,
          transition,
          ...detail,
        },
      });
    },
    [invoke, taskIdForMessage],
  );

  const executeAgentAction = useCallback<AiActionExecutionHandler>(
    async (messageId, actionId, rollback = false, contentOverride, userConfirmed = true) => {
      const taskId = taskIdForMessage(messageId);
      if (!taskId) throw new Error("AI 动作缺少对应的任务");
      if (!sessionId) throw new Error("当前终端会话不可用");
      let approvalCredential: string | null = null;
      if (userConfirmed) {
        approvalCredential = await invoke<string | null>("ai_task_action_approve", {
          request: {
            taskId,
            actionId,
            rollback,
            contentOverride,
          },
        });
      }
      const result = await invoke<AgentActionExecutionResult>("ai_task_action_execute", {
        request: {
          taskId,
          actionId,
          rollback,
          approvalCredential,
          contentOverride,
        },
      });
      onAgentActionExecuted(sessionId, result);
      return result;
    },
    [invoke, onAgentActionExecuted, sessionId, taskIdForMessage],
  );

  const reconcileTaskCommandExecutions = useCallback(
    (task: AgentTask) => {
      const actions = new Map(
        task.actions
          .filter((action) => action.commandExecution)
          .map((action) => [action.id, action]),
      );
      if (actions.size === 0) return;
      for (const [targetHostId, conversations] of Object.entries(conversationsByHostRef.current)) {
        const conversation = conversations.find((candidate) =>
          candidate.messages.some((message) => message.taskId === task.id),
        );
        if (!conversation) continue;
        updateMessages(targetHostId, conversation.id, (current) =>
          current.map((message) =>
            message.taskId === task.id
              ? {
                  ...message,
                  commandProposals: message.commandProposals?.map((proposal) => {
                    const action = actions.get(proposal.id);
                    return action?.commandExecution
                      ? reconcileAiCommandProposalExecution(proposal, action.commandExecution, {
                          evidence: action.verificationEvidence,
                          status: action.verificationStatus,
                        })
                      : proposal;
                  }),
                }
              : message,
          ),
        );
        break;
      }
    },
    [updateMessages],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("ai-task", ({ payload }) => {
      if (disposed) return;
      reconcileTaskCommandExecutions(payload.task);
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        recordDiagnostic("warn", "ai.command-runtime", "监听 AI 后台命令状态失败", {
          error: commandErrorMessage(error),
        });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [listen, reconcileTaskCommandExecutions]);

  return {
    executeAgentAction,
    reconcileTaskCommandExecutions,
    transitionAgentAction,
  };
}
