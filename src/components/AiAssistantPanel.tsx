import { useEffect, useMemo, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import type { AppSettings } from "../app-settings";
import { aiApprovalRequiresUserDecision, buildAiApprovalQueue } from "../ai-approval-queue";
import { buildAiConversationRequestMessages } from "../ai-summaries";
import { agentTaskMayHaveRunningCommand, buildAgentRecoveryPrompt } from "../ai-task-recovery";
import { aiFileEditEligibilityError } from "../ai-file-edits";
import type { AiFileApprovalDecision } from "../ai-file-approvals";
import {
  aiContextMentionIds,
  aiRemoteFileContextSource,
  buildAiContextPayloadResult,
  estimateAiRequestTokenBudget,
  stripAiContextMentions,
  type AiContextSource,
  type AiContextSourceId,
  type AiRemoteFileContext,
} from "../ai-utils";
import { recordDiagnostic } from "../diagnostics";
import {
  commandErrorMessage,
  type AgentApprovalMode,
  type AgentActionExecutionResult,
  type AgentTaskRecoveryDecision,
} from "../tauri-protocol";
import type { TerminalCommandSubmission } from "../terminal-utils";
import {
  aiCommandApprovalDecisionFromSubmission,
  aiCommandResultContextSource,
  type AiCommandApprovalDecision,
  type AiCommandProposal,
} from "../ai-command-proposals";
import useAiAgentBridge from "../hooks/useAiAgentBridge";
import { useAiCommandActions } from "../hooks/useAiCommandActions";
import { useAiConversations, type AiConversation } from "../hooks/useAiConversations";
import { useAiConversationActions } from "../hooks/useAiConversationActions";
import { useAiDraftActions } from "../hooks/useAiDraftActions";
import { useAiFileChangeWorkflow } from "../hooks/useAiFileChangeWorkflow";
import { useAiProposalState } from "../hooks/useAiProposalState";
import { useAiTimelineAutoScroll } from "../hooks/useAiTimelineAutoScroll";
import { useAiRequestOrchestrator } from "../hooks/useAiRequestOrchestrator";
import AiComposer from "./AiComposer";
import type { AiMessageTimelineActions } from "./AiMessageTimeline";
import AiApprovalDock from "./ai/AiApprovalDock";
import AiAssistantHeader from "./ai/AiAssistantHeader";
import AiOverlayHost from "./ai/AiOverlayHost";
import AiTimelineSection from "./ai/AiTimelineSection";
import {
  confirmAiConversationDelete,
  confirmAiFileChange,
  contextSourceDisplayLabel,
  copyCode,
  exportAiConversationFile,
  requestAiConversationRename,
  showAiCommandNotice,
  showAiConversationNotice,
  showAiDraftNotice,
  showAiFileChangeNotice,
} from "./ai/aiPanelActions";

interface AiAssistantPanelProps {
  canInsertCommand: boolean;
  contextSources: AiContextSource[];
  hostId: string | null;
  hostName: string;
  initialContextIds: AiContextSourceId[];
  initialPrompt: string;
  initialPromptRequest: number;
  onAgentActionExecuted: (sessionId: string, result: AgentActionExecutionResult) => void;
  onRemoveRemoteFile: (sessionId: string, path: string) => void;
  remoteFiles: AiRemoteFileContext[];
  sessionId: string | null;
  settings: AppSettings;
  visible: boolean;
}

function AiAssistantPanel({
  canInsertCommand,
  contextSources,
  hostId,
  hostName,
  initialContextIds,
  initialPrompt,
  initialPromptRequest,
  onAgentActionExecuted,
  onRemoveRemoteFile,
  remoteFiles,
  sessionId,
  settings,
  visible,
}: AiAssistantPanelProps) {
  const [expandedToolRuns, setExpandedToolRuns] = useState<Set<string>>(() => new Set());
  const [approvalMode, setApprovalMode] = useState<AgentApprovalMode>("on_request");
  const [automaticApprovalFailures, setAutomaticApprovalFailures] = useState<Set<string>>(
    () => new Set(),
  );
  const [recoveryDecision, setRecoveryDecision] = useState<AgentTaskRecoveryDecision>();
  const automaticApprovalAttemptsRef = useRef(new Set<string>());
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setApprovalMode("on_request");
    setAutomaticApprovalFailures(new Set());
    automaticApprovalAttemptsRef.current.clear();
  }, [canInsertCommand, hostId, sessionId]);

  const {
    activeConversation,
    activeConversationId,
    conversationId: conversationStateKey,
    conversationsByHost,
    createAndActivateConversation,
    draft: prompt,
    getHostConversations,
    hostConversations,
    isHostLoaded,
    loading: historyLoading,
    messages,
    persistConversation,
    removeConversation: removeStoredConversation,
    renameConversation: renameStoredConversation,
    selectConversation: selectStoredConversation,
    setDraft: setConversationDraft,
    updateConversation,
    updateMessages,
  } = useAiConversations({
    hostId,
    hostName,
    onLoadError: (error) => Message.warning(`AI 历史记录加载失败：${commandErrorMessage(error)}`),
    onSaveError: (error) => Message.warning(`AI 对话保存失败：${commandErrorMessage(error)}`),
    sessionId,
  });
  const { executeAgentAction, reconcileTaskCommandExecutions, transitionAgentAction } =
    useAiAgentBridge({
      conversationsByHost,
      onAgentActionExecuted,
      sessionId,
      updateMessages,
    });
  // `messages` changes on every streamed frame; keep the same array while the
  // command results are unchanged so context-dependent memos stay valid.
  const commandResultContextSourcesRef = useRef<AiContextSource[]>([]);
  const commandResultContextSources = useMemo(() => {
    const next = messages.flatMap((message) =>
      (message.commandProposals ?? [])
        .map(aiCommandResultContextSource)
        .filter((source) => source !== null),
    );
    const previous = commandResultContextSourcesRef.current;
    if (
      next.length === previous.length &&
      next.every(
        (source, index) =>
          source.id === previous[index]?.id &&
          source.label === previous[index]?.label &&
          source.content === previous[index]?.content,
      )
    ) {
      return previous;
    }
    commandResultContextSourcesRef.current = next;
    return next;
  }, [messages]);
  const commandDecisionRef = useRef<
    (proposalId: string, decision: AiCommandApprovalDecision) => boolean
  >(() => false);
  const availableContextSources = useMemo(() => {
    const sources = new Map(contextSources.map((source) => [source.id, source]));
    for (const source of commandResultContextSources) {
      sources.set(source.id, source);
    }
    return Array.from(sources.values());
  }, [commandResultContextSources, contextSources]);
  const {
    rejectCommandProposal,
    rejectFileEditProposal,
    rejectFileOperationProposal,
    retryFileEditProposal,
    retryFileOperationProposal,
    updateCommandProposal,
    updateCommandProposalInConversation,
    updateFileEditProposal,
    updateFileOperationProposal,
  } = useAiProposalState({
    activeConversationId: activeConversation?.id,
    commandSubmission: null,
    conversationsByHost,
    getHostConversations,
    hostId,
    isHostLoaded,
    onActionTransition: transitionAgentAction,
    onActionTransitionError: (error) =>
      Message.error(`AI 动作状态更新失败：${commandErrorMessage(error)}`),
    onCommandLifecycleObserved: async () => undefined,
    onCommandLifecycleProcessed: (proposalId, submission) => {
      const decision = aiCommandApprovalDecisionFromSubmission(submission);
      if (decision) commandDecisionRef.current(proposalId, decision);
    },
    persistConversation,
    updateMessages,
  });

  const {
    activeTask,
    cancelDiagnosticPlan,
    cancelRequest,
    confirmDiagnosticPlan,
    decideCommandProposal,
    decideFileProposal,
    reviseDiagnosticPlan,
    resolveTaskInterruption,
    sendMessage,
    sending,
    stopDiagnosticPlan,
    summarizingConversationIds,
  } = useAiRequestOrchestrator({
    approvalMode,
    onCancelError: (error) => Message.error(commandErrorMessage(error)),
    onMissingModel: () => Message.warning("请先在设置中配置 AI 模型"),
    onSessionSwitchInterrupt: () => Message.warning("已切换终端，进行中的 AI 任务已中断"),
    onSummaryError: (error) =>
      recordDiagnostic("warn", "ai.summary", "后台整理对话摘要失败", {
        error: commandErrorMessage(error),
      }),
    persistConversation,
    restoreTaskId: [...messages].reverse().find((message) => message.taskId)?.taskId,
    sessionId,
    settings,
    setDraft: setConversationDraft,
    updateConversation,
    updateMessages,
  });
  useEffect(() => {
    if (activeTask) reconcileTaskCommandExecutions(activeTask);
  }, [activeTask, reconcileTaskCommandExecutions]);
  const approvalQueue = useMemo(
    () =>
      buildAiApprovalQueue(
        messages,
        activeTask?.id,
        sending,
        activeTask?.status === "awaiting_approval" ? activeTask.plan?.id : undefined,
      ),
    [activeTask?.id, activeTask?.plan?.id, activeTask?.status, messages, sending],
  );
  const queuedApproval = approvalQueue[0];
  const queuedApprovalId = queuedApproval
    ? queuedApproval.kind === "diagnostic"
      ? queuedApproval.plan.id
      : queuedApproval.proposal.id
    : undefined;
  const automaticApproval =
    queuedApproval &&
    queuedApprovalId &&
    !automaticApprovalFailures.has(queuedApprovalId) &&
    !aiApprovalRequiresUserDecision(queuedApproval, approvalMode)
      ? queuedApproval
      : undefined;
  const activeApproval = automaticApproval ? undefined : queuedApproval;
  const dockedCommandProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue.filter((item) => item.kind === "command").map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  const dockedDiagnosticPlanIds = useMemo(
    () =>
      new Set(
        approvalQueue.filter((item) => item.kind === "diagnostic").map(({ plan }) => plan.id),
      ),
    [approvalQueue],
  );
  const dockedFileEditProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "file-edit")
          .map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  const dockedFileOperationProposalIds = useMemo(
    () =>
      new Set(
        approvalQueue
          .filter((item) => item.kind === "file-operation")
          .map(({ proposal }) => proposal.id),
      ),
    [approvalQueue],
  );
  commandDecisionRef.current = decideCommandProposal;
  const {
    approveCommandProposal,
    captureVerificationTarget,
    completeVerification,
    copyAllCommandProposals,
    copyCommandProposal,
    prepareCommandVerification,
    updateDraft,
  } = useAiCommandActions({
    contextSources: availableContextSources,
    conversationId: conversationStateKey,
    hostId,
    onCopyText: copyCode,
    onPrepareCommand: async (messageId, proposal, userConfirmed) => {
      if (!sessionId) throw new Error("当前终端会话不可用");
      if (!hostId) throw new Error("当前主机不可用");
      const result = await executeAgentAction(
        messageId,
        proposal.id,
        false,
        undefined,
        userConfirmed,
      );
      if (result.actionType !== "terminal_command") {
        throw new Error("AI 后台命令返回了无效结果");
      }
      if (!result.command) throw new Error("AI 后台命令缺少执行结果");
      return {
        command: proposal.command,
        completedAt: new Date(result.command.completedAt).toISOString(),
        durationMs: result.command.durationMs,
        exitCode: result.command.exitCode ?? undefined,
        hostId,
        id: result.command.submissionId,
        output: result.command.output ?? undefined,
        outputTruncated: result.command.outputTruncated,
        stdout: result.command.stdout ?? undefined,
        stdoutTruncated: result.command.stdoutTruncated,
        stderr: result.command.stderr ?? undefined,
        stderrTruncated: result.command.stderrTruncated,
        phase: result.command.phase,
        reason: result.command.reason ?? undefined,
        sessionId,
        submittedAt: new Date(result.command.submittedAt).toISOString(),
      } satisfies TerminalCommandSubmission;
    },
    onNotice: showAiCommandNotice,
    sessionId,
    setDraft: setConversationDraft,
    updateCommandProposal,
    updateCommandProposalInConversation,
  });
  const executeCommandAndResume = async (
    messageId: string,
    proposal: AiCommandProposal,
    userConfirmed = true,
  ) => {
    const submission = await approveCommandProposal(messageId, proposal, userConfirmed);
    // Not pending anymore: another path already settled this proposal.
    if (submission === false) return false;
    // An automatic attempt falls back to manual approval, so the round keeps
    // waiting. A manual attempt must settle the round, otherwise the agent
    // loop waits forever for a decision that never comes.
    if ("failed" in submission) {
      if (userConfirmed) {
        commandDecisionRef.current(proposal.id, {
          kind: "execution_unavailable",
          reason: submission.reason,
        });
      }
      return false;
    }
    let decision: ReturnType<typeof aiCommandApprovalDecisionFromSubmission>;
    try {
      decision = aiCommandApprovalDecisionFromSubmission(submission);
    } catch (error) {
      decision = {
        kind: "execution_unavailable",
        reason: commandErrorMessage(error),
      };
    }
    // A still-running submission is settled later by task events.
    if (decision) commandDecisionRef.current(proposal.id, decision);
    return true;
  };
  const approveCommandAndResume = async (messageId: string, proposal: AiCommandProposal) => {
    await executeCommandAndResume(messageId, proposal);
  };
  const rejectCommandAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiCommandApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectCommandProposal(messageId, proposalId);
    if (updated) decideCommandProposal(proposalId, decision);
    return updated;
  };
  const {
    applying: fileEditApplying,
    approveFileEditProposal,
    approveFileOperationProposal,
    applyReviewedFileEdit,
    applyReviewedFileOperation,
    closeFileChangeReview,
    confirmApplyAllFileEdits,
    confirmApplyAllFileOperations,
    confirmRollbackAllFileEdits,
    confirmRollbackAllFileOperations,
    confirmRollbackFileEdit: confirmRollbackAppliedFileEdit,
    confirmRollbackFileOperation,
    fileChangeReview,
    fileChangeReviewItems,
    openFileEditReview,
    openFileOperationReview,
    reviewedFileEditError,
    reviewedFileEditContent,
    reviewedFileEditProposal,
    reviewedFileOperationProposal,
    selectFileChangeReview,
    setFileEditReviewContent,
  } = useAiFileChangeWorkflow({
    messages,
    onExecuteAction: executeAgentAction,
    onConfirm: confirmAiFileChange,
    onNotice: showAiFileChangeNotice,
    sessionId,
    updateFileEditProposal,
    updateFileOperationProposal,
  });
  const completeFileApproval = (proposalId: string, decision: AiFileApprovalDecision) =>
    decideFileProposal(proposalId, decision);
  const approveFileEditAndResume = async (
    messageId: string,
    proposal: NonNullable<Extract<typeof activeApproval, { kind: "file-edit" }>>["proposal"],
    userConfirmed = true,
  ) => {
    const result = await approveFileEditProposal(messageId, proposal, userConfirmed);
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件已更新" }
        : {
            kind: "execution_failed",
            reason: result === "conflict" ? "远程文件已被其他程序修改" : "远程文件写入失败",
          },
    );
    return result;
  };
  const approveFileOperationAndResume = async (
    messageId: string,
    proposal: NonNullable<Extract<typeof activeApproval, { kind: "file-operation" }>>["proposal"],
    userConfirmed = true,
  ) => {
    const result = await approveFileOperationProposal(messageId, proposal, userConfirmed);
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件操作已完成" }
        : {
            kind: "execution_failed",
            reason: result === "conflict" ? "远端文件状态已发生变化" : "远程文件操作失败",
          },
    );
    return result;
  };
  const rejectFileEditAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiFileApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectFileEditProposal(messageId, proposalId);
    if (updated) completeFileApproval(proposalId, decision);
  };
  const rejectFileOperationAndResume = async (
    messageId: string,
    proposalId: string,
    decision: AiFileApprovalDecision = { kind: "rejected" },
  ) => {
    const updated = await rejectFileOperationProposal(messageId, proposalId);
    if (updated) completeFileApproval(proposalId, decision);
  };
  const applyReviewedFileEditAndResume = async () => {
    const proposal = reviewedFileEditProposal;
    const result = await applyReviewedFileEdit();
    if (!proposal || !result) return;
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件已更新" }
        : {
            kind: "execution_failed",
            reason: result === "conflict" ? "远程文件已被其他程序修改" : "远程文件写入失败",
          },
    );
  };
  const applyReviewedFileOperationAndResume = async () => {
    const proposal = reviewedFileOperationProposal;
    const result = await applyReviewedFileOperation();
    if (!proposal || !result) return;
    completeFileApproval(
      proposal.id,
      result === "applied"
        ? { kind: "execution_completed", summary: "远程文件操作已完成" }
        : {
            kind: "execution_failed",
            reason: result === "conflict" ? "远端文件状态已发生变化" : "远程文件操作失败",
          },
    );
  };

  useEffect(() => {
    if (!automaticApproval || !queuedApprovalId || !sending) return;
    if (automaticApprovalAttemptsRef.current.has(queuedApprovalId)) return;
    automaticApprovalAttemptsRef.current.add(queuedApprovalId);
    const approval = automaticApproval;
    const approvalId = queuedApprovalId;
    const markAutomaticApprovalFailed = () =>
      setAutomaticApprovalFailures((current) => new Set(current).add(approvalId));

    void (async () => {
      try {
        await runAutomaticApproval();
      } catch (error) {
        markAutomaticApprovalFailed();
        Message.warning(`自动执行未完成，请手动确认：${commandErrorMessage(error)}`);
      }
    })();

    async function runAutomaticApproval() {
      if (approval.kind === "command") {
        const approved = await executeCommandAndResume(
          approval.messageId,
          approval.proposal,
          false,
        );
        if (!approved) markAutomaticApprovalFailed();
        return;
      }
      if (approval.kind === "file-edit") {
        await approveFileEditAndResume(approval.messageId, approval.proposal, false);
        return;
      }
      if (approval.kind === "file-operation") {
        await approveFileOperationAndResume(approval.messageId, approval.proposal, false);
      }
    }
  }, [automaticApproval, queuedApprovalId, sending]);

  const { addToolRunToDraft, applyPromptPreset, removeRemoteFile, updateRemoteFileMention } =
    useAiDraftActions({
      contextSources: availableContextSources,
      conversationId: conversationStateKey,
      initialContextIds,
      initialPrompt,
      initialPromptRequest,
      onNotice: showAiDraftNotice,
      onRemoveRemoteFile,
      prompt,
      sending,
      sessionId,
      updateDraft,
      visible,
    });
  const {
    closeHistory,
    exportConversation,
    historyConversations,
    historyVisible,
    newConversation,
    openHistory,
    removeConversation,
    renameConversation,
    selectConversation,
  } = useAiConversationActions({
    conversations: hostConversations,
    createConversation: createAndActivateConversation,
    exportConversation: exportAiConversationFile,
    hostId,
    onConfirmDelete: confirmAiConversationDelete,
    onNotice: showAiConversationNotice,
    onRequestRename: requestAiConversationRename,
    removeConversation: removeStoredConversation,
    renameConversation: renameStoredConversation,
    selectConversation: selectStoredConversation,
    sending,
    sessionId,
  });
  const selectedContextIds = useMemo(
    () => aiContextMentionIds(prompt, availableContextSources),
    [availableContextSources, prompt],
  );
  const question = stripAiContextMentions(prompt, availableContextSources);

  const selectedContextSources = availableContextSources.filter(
    (source) => selectedContextIds.includes(source.id) && Boolean(source.content.trim()),
  );
  const contextPayload = useMemo(
    () =>
      buildAiContextPayloadResult(
        availableContextSources,
        selectedContextIds,
        settings.aiContextMaxChars,
      ),
    [availableContextSources, selectedContextIds, settings.aiContextMaxChars],
  );
  const context = contextPayload.content;
  // The budget is for the next request, which can't be sent while one is in
  // flight, so it doesn't need to follow every streamed frame.
  const budgetMessagesRef = useRef(messages);
  if (!sending) budgetMessagesRef.current = messages;
  const budgetMessages = budgetMessagesRef.current;
  const conversationSummary = activeConversation?.summary;
  const tokenBudget = useMemo(
    () =>
      estimateAiRequestTokenBudget(
        buildAiConversationRequestMessages(budgetMessages, conversationSummary),
        question,
        contextPayload,
        settings.aiContextMaxChars,
      ),
    [budgetMessages, contextPayload, conversationSummary, question, settings.aiContextMaxChars],
  );
  const lastTelemetry = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.telemetry)?.telemetry;
  const selectedRemoteFiles = useMemo(
    () =>
      remoteFiles.filter((file) => selectedContextIds.includes(aiRemoteFileContextSource(file).id)),
    [remoteFiles, selectedContextIds],
  );
  const editableRemoteFiles = useMemo(
    () =>
      settings.aiFileProposalsEnabled && canInsertCommand
        ? selectedRemoteFiles.filter(
            (file) => !aiFileEditEligibilityError(file, context, settings.aiContextMaxChars),
          )
        : [],
    [
      canInsertCommand,
      context,
      selectedRemoteFiles,
      settings.aiContextMaxChars,
      settings.aiFileProposalsEnabled,
    ],
  );
  const currentRemoteDirectory =
    contextSources.find((source) => source.id === "sftp-path")?.content.trim() || null;
  const hasRecentTerminalOutput = Boolean(
    contextSources.find((source) => source.id === "terminal-output")?.content.trim(),
  );
  const operationDirectory =
    settings.aiFileProposalsEnabled && canInsertCommand && selectedContextIds.includes("sftp-path")
      ? currentRemoteDirectory
      : null;
  const fileEditEligibility = !settings.aiFileProposalsEnabled
    ? "文件变更提案权限已在设置中关闭"
    : !selectedRemoteFiles.length
      ? "请在输入框中提及远程文件后再生成修改建议"
      : !canInsertCommand
        ? "当前终端会话未连接，不能应用文件修改"
        : editableRemoteFiles.length === selectedRemoteFiles.length
          ? null
          : editableRemoteFiles.length
            ? `${editableRemoteFiles.length}/${selectedRemoteFiles.length} 个文件可生成修改建议，其余文件只能分析`
            : aiFileEditEligibilityError(
                selectedRemoteFiles[0] ?? null,
                context,
                settings.aiContextMaxChars,
              );

  const toggleToolRun = (key: string) => {
    setExpandedToolRuns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useAiTimelineAutoScroll(contentRef, {
    content: messages,
    conversationId: activeConversation?.id,
    messageCount: messages.length,
    visible,
  });

  useEffect(() => {
    if (visible) return;
    closeHistory();
    closeFileChangeReview();
  }, [fileEditApplying, visible]);

  const sendConversationMessage = (
    value: string,
    history: AiConversation["messages"] = messages,
    conversationSummary = activeConversation?.summary,
    verificationTarget: ReturnType<typeof captureVerificationTarget> = null,
    includeComposerContext = true,
    requestValue?: string,
    approvalModeOverride?: AgentApprovalMode,
  ) => {
    if (!hostId || !sessionId || !activeConversation) return;
    return sendMessage({
      approvalModeOverride,
      commandProposalEnabled: canInsertCommand && settings.aiCommandProposalsEnabled,
      conversationSummary,
      context: includeComposerContext ? context : "",
      contextLabels: includeComposerContext
        ? selectedContextSources.map(contextSourceDisplayLabel)
        : [],
      currentOperationDirectory: includeComposerContext ? operationDirectory : null,
      editableFiles: includeComposerContext ? editableRemoteFiles : [],
      history,
      targetConversationId: activeConversation.id,
      targetDirectory: currentRemoteDirectory,
      targetHostId: hostId,
      targetSessionId: sessionId,
      toolCurrentDirectory: currentRemoteDirectory,
      value,
      requestValue,
    }).then((completed) => {
      completeVerification(Boolean(completed), verificationTarget);
    });
  };

  const decideInterruptedTask = async (decision: AgentTaskRecoveryDecision) => {
    if (!activeTask || recoveryDecision) return;
    setRecoveryDecision(decision);
    try {
      const recovery = await resolveTaskInterruption(activeTask.id, decision);
      if (decision === "finish") return;
      if (!hostId || recovery.hostId !== hostId) {
        throw new Error("中断任务与当前主机不匹配，无法继续");
      }
      setApprovalMode("on_request");
      await sendConversationMessage(
        decision === "retry" ? "重新尝试" : "继续分析",
        messages,
        activeConversation?.summary,
        null,
        false,
        buildAgentRecoveryPrompt(recovery, decision, {
          remoteCommandMayBeRunning: agentTaskMayHaveRunningCommand(activeTask),
        }),
        "on_request",
      );
    } catch (error) {
      Message.error(commandErrorMessage(error));
    } finally {
      setRecoveryDecision(undefined);
    }
  };

  const send = () => {
    const verificationTarget = captureVerificationTarget(prompt);
    void sendConversationMessage(
      question,
      messages,
      activeConversation?.summary,
      verificationTarget,
    );
  };

  const reviseCommandProposal = async (
    messageId: string,
    proposal: AiCommandProposal,
    feedback: string,
  ) => {
    if (!feedback.trim()) return;
    await rejectCommandAndResume(messageId, proposal.id, {
      feedback: feedback.trim(),
      kind: "revision_requested",
    });
  };

  const retry = (assistantIndex: number) => {
    if (!hostId || !sessionId || !activeConversation || sending) return;
    const userMessage = messages[assistantIndex - 1];
    const assistantMessage = messages[assistantIndex];
    if (!userMessage || userMessage.role !== "user" || !assistantMessage?.failed) {
      return;
    }
    // Retrying the latest answer replaces it. For an earlier one, replacing
    // would discard everything after it, so ask the question again at the end.
    const latest = assistantIndex === messages.length - 1;
    if (!latest) {
      void sendMessage({
        commandProposalEnabled: canInsertCommand && settings.aiCommandProposalsEnabled,
        conversationSummary: activeConversation.summary,
        context: userMessage.context ?? "",
        contextLabels: userMessage.contextLabels ?? [],
        currentOperationDirectory: null,
        editableFiles: [],
        history: messages,
        targetConversationId: activeConversation.id,
        targetDirectory: currentRemoteDirectory,
        targetHostId: hostId,
        targetSessionId: sessionId,
        toolCurrentDirectory: currentRemoteDirectory,
        value: userMessage.content,
      });
      return;
    }
    void sendMessage({
      commandProposalEnabled: canInsertCommand && settings.aiCommandProposalsEnabled,
      conversationSummary:
        activeConversation.summary &&
        (messages
          .slice(0, assistantIndex - 1)
          .some((message) => message.id === activeConversation.summary?.throughMessageId) ||
          !messages.some((message) => message.id === activeConversation.summary?.throughMessageId))
          ? activeConversation.summary
          : undefined,
      context: userMessage.context ?? "",
      contextLabels: userMessage.contextLabels ?? [],
      currentOperationDirectory: null,
      editableFiles: [],
      history: messages.slice(0, assistantIndex - 1),
      targetConversationId: activeConversation.id,
      targetDirectory: currentRemoteDirectory,
      targetHostId: hostId,
      targetSessionId: sessionId,
      toolCurrentDirectory: currentRemoteDirectory,
      value: userMessage.content,
    });
  };

  const timelineActions = useMemo<AiMessageTimelineActions>(
    () => ({
      addToolRunToDraft,
      analyzeCommand: prepareCommandVerification,
      applyAllFileEdits: confirmApplyAllFileEdits,
      applyAllFileOperations: confirmApplyAllFileOperations,
      approveCommandProposal: approveCommandAndResume,
      cancelDiagnosticPlan,
      confirmDiagnosticPlan,
      copyCode,
      copyCommand: copyCommandProposal,
      copyCommands: copyAllCommandProposals,
      openFileEditReview,
      openFileOperationReview,
      rejectCommand: rejectCommandAndResume,
      rejectFileEdit: rejectFileEditProposal,
      rejectFileOperation: rejectFileOperationProposal,
      retryFileEdit: retryFileEditProposal,
      retryFileOperation: retryFileOperationProposal,
      retryMessage: retry,
      reviseCommand: reviseCommandProposal,
      reviseDiagnosticPlan,
      rollbackAllFileEdits: confirmRollbackAllFileEdits,
      rollbackAllFileOperations: confirmRollbackAllFileOperations,
      rollbackFileEdit: confirmRollbackAppliedFileEdit,
      rollbackFileOperation: confirmRollbackFileOperation,
      selectPreset: applyPromptPreset,
      stopDiagnosticPlan,
      toggleToolRun,
    }),
    [
      addToolRunToDraft,
      applyPromptPreset,
      approveCommandAndResume,
      cancelDiagnosticPlan,
      confirmApplyAllFileEdits,
      confirmApplyAllFileOperations,
      confirmDiagnosticPlan,
      confirmRollbackAllFileEdits,
      confirmRollbackAllFileOperations,
      confirmRollbackAppliedFileEdit,
      confirmRollbackFileOperation,
      copyAllCommandProposals,
      copyCommandProposal,
      openFileEditReview,
      openFileOperationReview,
      prepareCommandVerification,
      rejectCommandAndResume,
      rejectFileEditProposal,
      rejectFileOperationProposal,
      retry,
      retryFileEditProposal,
      retryFileOperationProposal,
      reviseCommandProposal,
      reviseDiagnosticPlan,
      stopDiagnosticPlan,
      toggleToolRun,
    ],
  );

  return (
    <aside className="panel ai-assistant-sidebar-panel">
      <AiAssistantHeader
        conversationSummarized={Boolean(activeConversation?.summary)}
        conversationSummarizing={Boolean(
          activeConversation && summarizingConversationIds.has(activeConversation.id),
        )}
        conversationTitle={activeConversation?.title ?? ""}
        disconnectedError={
          activeTask?.status === "paused_disconnected" ? (activeTask.error ?? "") : undefined
        }
        onNew={newConversation}
        onOpenHistory={openHistory}
        sending={sending}
        sessionAvailable={Boolean(sessionId)}
      />

      <div className="ai-assistant-layout">
        <AiTimelineSection
          recovery={
            activeTask
              ? {
                  busyDecision: recoveryDecision,
                  onDecision: (decision) => void decideInterruptedTask(decision),
                  sessionAvailable: Boolean(sessionId),
                  task: activeTask,
                }
              : undefined
          }
          timeline={{
            actions: timelineActions,
            activeConversationAvailable: Boolean(activeConversation),
            applyingFileChanges: fileEditApplying,
            canInsertCommand,
            dockedCommandProposalIds,
            dockedDiagnosticPlanIds,
            dockedFileEditProposalIds,
            dockedFileOperationProposalIds,
            expandedToolRuns,
            hasRecentTerminalOutput,
            hostName,
            loading: historyLoading,
            messages,
            scrollRef: contentRef,
            sending,
            sessionId,
          }}
        />
        {activeApproval && (
          <AiApprovalDock
            actions={{
              addToolRunToDraft,
              analyzeCommand: prepareCommandVerification,
              approveCommand: approveCommandAndResume,
              approveFileEdit: approveFileEditAndResume,
              approveFileOperation: approveFileOperationAndResume,
              cancelDiagnosticPlan,
              confirmDiagnosticPlan,
              copyCommand: copyCommandProposal,
              copyCommands: copyAllCommandProposals,
              openFileEditReview,
              openFileOperationReview,
              rejectCommand: rejectCommandAndResume,
              rejectFileEdit: rejectFileEditAndResume,
              rejectFileOperation: rejectFileOperationAndResume,
              reviseCommand: reviseCommandProposal,
              reviseDiagnosticPlan,
              reviseFileEdit: (messageId, proposalId, feedback) =>
                rejectFileEditAndResume(messageId, proposalId, {
                  feedback,
                  kind: "revision_requested",
                }),
              reviseFileOperation: (messageId, proposalId, feedback) =>
                rejectFileOperationAndResume(messageId, proposalId, {
                  feedback,
                  kind: "revision_requested",
                }),
              stopDiagnosticPlan,
              toggleToolRun,
            }}
            approval={activeApproval}
            canInsertCommand={canInsertCommand}
            expandedToolRuns={expandedToolRuns}
            fileEditApplying={fileEditApplying}
            hasRecentTerminalOutput={hasRecentTerminalOutput}
            hostName={hostName}
            queueCount={approvalQueue.length}
            sending={sending}
            sessionId={sessionId}
          />
        )}
        <AiComposer
          activeConversationAvailable={Boolean(activeConversation)}
          approvalMode={approvalMode}
          canInsertCommand={canInsertCommand}
          contextSources={availableContextSources}
          editableRemoteFileCount={editableRemoteFiles.length}
          fileEditEligibility={fileEditEligibility ?? undefined}
          lastTelemetry={lastTelemetry}
          model={settings.aiModel}
          onApprovalModeChange={setApprovalMode}
          onCancel={cancelRequest}
          onChange={updateDraft}
          onRemoveRemoteFile={removeRemoteFile}
          onSend={send}
          onToggleRemoteFile={updateRemoteFileMention}
          prompt={prompt}
          remoteFiles={remoteFiles}
          selectedContextIds={selectedContextIds}
          sendEnabled={Boolean(question && activeConversation)}
          sending={sending}
          tokenBudget={tokenBudget}
        />
      </div>
      <AiOverlayHost
        fileChangeReview={{
          activeKey: fileChangeReview?.activeKey,
          applying: fileEditApplying,
          editContent: reviewedFileEditContent,
          editError: reviewedFileEditError,
          items: fileChangeReviewItems,
          onApplyEdit: applyReviewedFileEditAndResume,
          onApplyOperation: applyReviewedFileOperationAndResume,
          onChangeEditContent: setFileEditReviewContent,
          onClose: closeFileChangeReview,
          onSelect: selectFileChangeReview,
          visible: Boolean(fileChangeReview),
        }}
        historyDrawer={{
          activeConversationId: activeConversationId ?? null,
          conversations: historyConversations,
          loading: historyLoading,
          onClose: closeHistory,
          onDelete: removeConversation,
          onExport: exportConversation,
          onRename: renameConversation,
          onSelect: selectConversation,
          visible: historyVisible,
        }}
      />
    </aside>
  );
}

export default AiAssistantPanel;
