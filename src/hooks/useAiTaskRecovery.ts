import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTask, AgentTaskEventPayload, AgentTaskSync } from "../tauri-protocol";
import { agentTaskIsTerminal } from "./ai-agent-plan-presentation";
import { applyAgentTaskEvent, reconcileAgentTaskSync } from "./agent-task-event-state";
import type { AiRequestInvoke } from "./useAiRequestOrchestrator";

export type AiTaskListener = (
  callback: (payload: AgentTaskEventPayload) => void,
) => Promise<() => void>;

export interface ActiveAiRequest {
  assistantId: string;
  conversationId: string;
  hostId: string;
  requestId: string;
}

interface UseAiTaskRecoveryOptions {
  invoke: AiRequestInvoke;
  listenToTaskEvents: AiTaskListener;
  restoreTaskId?: string;
  getActiveRequest: () => ActiveAiRequest | undefined;
  onTaskChange: (task: AgentTask, activeRequest: ActiveAiRequest | undefined) => void;
  onTerminal: () => void;
}

/**
 * Owns the task snapshot shown in the UI: applies live task events, restores an
 * existing task after a remount, and tracks which task the request loop owns.
 */
export function useAiTaskRecovery({
  invoke,
  listenToTaskEvents,
  restoreTaskId,
  getActiveRequest,
  onTaskChange,
  onTerminal,
}: UseAiTaskRecoveryOptions) {
  const [activeTask, setActiveTask] = useState<AgentTask>();
  const activeTaskRef = useRef<AgentTask>();
  const trackedTaskIdRef = useRef<string>();

  const commitActiveTask = useCallback((task: AgentTask | undefined) => {
    activeTaskRef.current = task;
    setActiveTask(task);
  }, []);

  const trackTaskId = useCallback((taskId: string | undefined) => {
    trackedTaskIdRef.current = taskId;
  }, []);

  const resetTask = useCallback(() => {
    trackedTaskIdRef.current = undefined;
    commitActiveTask(undefined);
  }, [commitActiveTask]);

  const callbacksRef = useRef({ getActiveRequest, onTaskChange, onTerminal });
  callbacksRef.current = { getActiveRequest, onTaskChange, onTerminal };

  useEffect(() => {
    let disposed = false;
    let stopTaskEvents: (() => void) | undefined;
    void listenToTaskEvents((payload) => {
      const activeRequest = callbacksRef.current.getActiveRequest();
      const trackedTaskId = activeRequest?.requestId ?? trackedTaskIdRef.current;
      const next = applyAgentTaskEvent(activeTaskRef.current, trackedTaskId, payload);
      if (!next || next === activeTaskRef.current) return;
      commitActiveTask(next);
      callbacksRef.current.onTaskChange(next, activeRequest);
      if (agentTaskIsTerminal(next)) callbacksRef.current.onTerminal();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopTaskEvents = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stopTaskEvents?.();
    };
  }, [commitActiveTask, listenToTaskEvents]);

  useEffect(() => {
    if (!restoreTaskId) {
      if (!callbacksRef.current.getActiveRequest()) {
        resetTask();
      }
      return;
    }
    trackedTaskIdRef.current = restoreTaskId;
    let disposed = false;
    const currentSequence =
      activeTaskRef.current?.id === restoreTaskId ? activeTaskRef.current.lastEventSequence : 0;
    void invoke<AgentTaskSync>("ai_task_sync", {
      taskId: restoreTaskId,
      afterSequence: currentSequence,
    })
      .then((sync) => {
        if (disposed || trackedTaskIdRef.current !== restoreTaskId) return;
        const next = reconcileAgentTaskSync(activeTaskRef.current, restoreTaskId, sync);
        if (!next || next === activeTaskRef.current) return;
        commitActiveTask(next);
        callbacksRef.current.onTaskChange(next, callbacksRef.current.getActiveRequest());
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [commitActiveTask, invoke, resetTask, restoreTaskId]);

  return { activeTask, commitActiveTask, resetTask, trackTaskId };
}
