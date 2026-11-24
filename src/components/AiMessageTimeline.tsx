import { isValidElement, memo, useEffect, useState, type ReactNode, type RefObject } from "react";
import { Button, Message, Space, Spin, Tag, Tooltip, Typography } from "@arco-design/web-react";
import {
  IconCloud,
  IconCode,
  IconCommand,
  IconCopy,
  IconDashboard,
  IconDown,
  IconRefresh,
  IconRight,
  IconRobot,
} from "@arco-design/web-react/icon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiCommandProposal } from "../ai-command-proposals";
import type { AiFileEditProposal } from "../ai-file-edits";
import type { AiFileOperationProposal } from "../ai-file-operations";
import { AI_PROMPT_PRESETS, type AiPromptPreset, type AiPromptPresetId } from "../ai-presets";
import type { AiToolRun } from "../ai-tools";
import type { AiMessage } from "../hooks/useAiConversations";
import { commandErrorMessage } from "../tauri-protocol";
import AiCommandProposalList from "./AiCommandProposalList";
import AiDiagnosticPlanList from "./AiDiagnosticPlanList";
import AiFileChangePanels from "./AiFileChangePanels";
import AiToolRunList from "./AiToolRunList";

export interface AiMessageTimelineActions {
  addToolRunToDraft: (run: AiToolRun) => void;
  analyzeCommand: (messageId: string, proposal: AiCommandProposal) => void;
  applyAllFileEdits: (messageId: string, proposals: AiFileEditProposal[]) => void;
  applyAllFileOperations: (messageId: string, proposals: AiFileOperationProposal[]) => void;
  copyCode: (value: string) => Promise<void>;
  copyCommand: (command: string) => void | Promise<void>;
  copyCommands: (proposals: AiCommandProposal[]) => void | Promise<void>;
  cancelDiagnosticPlan: (planId: string) => void;
  confirmDiagnosticPlan: (planId: string, selectedCallIds: string[]) => void;
  reviseDiagnosticPlan: (planId: string, feedback: string) => void;
  approveCommandProposal: (messageId: string, proposal: AiCommandProposal) => void | Promise<void>;
  openFileEditReview: (messageId: string, proposal: AiFileEditProposal) => void;
  openFileOperationReview: (messageId: string, proposal: AiFileOperationProposal) => void;
  rejectCommand: (messageId: string, proposalId: string) => unknown | Promise<unknown>;
  reviseCommand: (
    messageId: string,
    proposal: AiCommandProposal,
    feedback: string,
  ) => void | Promise<void>;
  rejectFileEdit: (messageId: string, proposalId: string) => void;
  rejectFileOperation: (messageId: string, proposalId: string) => void;
  retryFileEdit: (messageId: string, proposalId: string) => void;
  retryFileOperation: (messageId: string, proposalId: string) => void;
  retryMessage: (messageIndex: number) => void;
  rollbackAllFileEdits: (messageId: string, proposals: AiFileEditProposal[]) => void;
  rollbackAllFileOperations: (messageId: string, proposals: AiFileOperationProposal[]) => void;
  rollbackFileEdit: (messageId: string, proposal: AiFileEditProposal) => void;
  rollbackFileOperation: (messageId: string, proposal: AiFileOperationProposal) => void;
  selectPreset: (preset: AiPromptPreset) => void;
  stopDiagnosticPlan: (planId: string) => void;
  toggleToolRun: (key: string) => void;
}

export interface AiMessageTimelineProps {
  actions: AiMessageTimelineActions;
  activeConversationAvailable: boolean;
  applyingFileChanges: boolean;
  canInsertCommand: boolean;
  dockedCommandProposalIds?: ReadonlySet<string>;
  dockedDiagnosticPlanIds?: ReadonlySet<string>;
  dockedFileEditProposalIds?: ReadonlySet<string>;
  dockedFileOperationProposalIds?: ReadonlySet<string>;
  expandedToolRuns: ReadonlySet<string>;
  hasRecentTerminalOutput: boolean;
  hostName: string;
  loading: boolean;
  messages: AiMessage[];
  scrollRef: RefObject<HTMLDivElement>;
  sending: boolean;
  sessionId: string | null;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textContent(node.props.children);
  }
  return "";
}

function codeLanguage(node: ReactNode) {
  if (!isValidElement<{ className?: string }>(node)) return "";
  return node.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase() ?? "";
}

function isShellLanguage(language: string) {
  return (
    !language ||
    ["bash", "bat", "cmd", "console", "fish", "powershell", "sh", "shell", "zsh"].includes(language)
  );
}

function promptPresetIcon(id: AiPromptPresetId) {
  switch (id) {
    case "explain-output":
      return <IconCode />;
    case "analyze-server":
      return <IconDashboard />;
    case "diagnose-network":
      return <IconCloud />;
    case "generate-command":
      return <IconCommand />;
  }
}

function containsOnlyDockedApproval(
  message: AiMessage,
  dockedCommandProposalIds?: ReadonlySet<string>,
  dockedDiagnosticPlanIds?: ReadonlySet<string>,
  dockedFileEditProposalIds?: ReadonlySet<string>,
  dockedFileOperationProposalIds?: ReadonlySet<string>,
) {
  if (message.role !== "assistant" || message.content || message.reasoning || message.failed) {
    return false;
  }
  const hasDockedCommand = message.commandProposals?.some((proposal) =>
    dockedCommandProposalIds?.has(proposal.id),
  );
  const hasDockedDiagnostic = message.diagnosticPlans?.some((plan) =>
    dockedDiagnosticPlanIds?.has(plan.id),
  );
  const hasDockedFileEdit = message.fileEditProposals?.some((proposal) =>
    dockedFileEditProposalIds?.has(proposal.id),
  );
  const hasDockedFileOperation = message.fileOperationProposals?.some((proposal) =>
    dockedFileOperationProposalIds?.has(proposal.id),
  );
  if (!hasDockedCommand && !hasDockedDiagnostic && !hasDockedFileEdit && !hasDockedFileOperation) {
    return false;
  }

  return !(
    message.commandProposals?.some((proposal) => !dockedCommandProposalIds?.has(proposal.id)) ||
    message.commandRecords?.length ||
    message.diagnosticPlans?.some((plan) => !dockedDiagnosticPlanIds?.has(plan.id)) ||
    message.toolRuns?.some((run) => !run.planId) ||
    message.fileEditProposals?.some((proposal) => !dockedFileEditProposalIds?.has(proposal.id)) ||
    message.fileOperationProposals?.some(
      (proposal) => !dockedFileOperationProposalIds?.has(proposal.id),
    ) ||
    message.fileChanges?.length
  );
}

function AiReasoningDisclosure({ active, reasoning }: { active: boolean; reasoning: string }) {
  const [expanded, setExpanded] = useState(active);

  useEffect(() => {
    setExpanded(active);
  }, [active]);

  return (
    <div className={`ai-reasoning${active ? " ai-reasoning-active" : ""}`}>
      <Button
        aria-expanded={expanded}
        className="ai-reasoning-toggle"
        icon={expanded ? <IconDown /> : <IconRight />}
        onClick={() => setExpanded((current) => !current)}
        size="mini"
        type="text"
      >
        {active ? "正在思考..." : "思考过程"}
      </Button>
      {expanded && (
        <div className="ai-reasoning-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function messageIsActivelyThinking(
  message: AiMessage,
  index: number,
  messageCount: number,
  sending: boolean,
) {
  return (
    sending &&
    index === messageCount - 1 &&
    !message.content &&
    !message.failed &&
    !message.commandProposals?.length &&
    !message.fileEditProposals?.length &&
    !message.fileOperationProposals?.length &&
    !message.diagnosticPlans?.length &&
    !message.toolRuns?.length
  );
}

function messageHasActiveWorkflow(message: AiMessage) {
  return Boolean(
    message.commandProposals?.some(
      (proposal) =>
        proposal.status === "pending" ||
        proposal.status === "approved" ||
        proposal.status === "executed" ||
        proposal.executionPhase === "connecting" ||
        proposal.executionPhase === "running" ||
        proposal.executionPhase === "cancelling",
    ) ||
    message.diagnosticPlans?.some(
      (plan) => plan.status === "pending" || plan.status === "running",
    ) ||
    message.toolRuns?.some((run) => run.status === "pending" || run.status === "running") ||
    message.fileEditProposals?.some((proposal) => proposal.status === "pending") ||
    message.fileOperationProposals?.some((proposal) => proposal.status === "pending"),
  );
}

function messageIsActivelyStreaming(
  message: AiMessage,
  index: number,
  messageCount: number,
  sending: boolean,
) {
  if (
    !sending ||
    index !== messageCount - 1 ||
    message.role !== "assistant" ||
    message.failed ||
    messageHasActiveWorkflow(message)
  ) {
    return false;
  }
  return Boolean(message.content || !message.reasoning);
}

function AiStreamingIndicator() {
  return (
    <div aria-label="AI 正在生成" className="ai-streaming-indicator" role="status">
      <span>正在生成</span>
      <span aria-hidden="true" className="ai-streaming-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm];

// Parsing Markdown is the most expensive part of rendering the timeline.
// Re-render only when the text changes so streaming into the last message
// doesn't re-parse every earlier one. `onCopyCode` only copies text, so an
// earlier callback behaves the same as the latest one.
const AiMarkdown = memo(
  function AiMarkdown({
    children,
    onCopyCode,
  }: {
    children: string;
    onCopyCode: (value: string) => Promise<void>;
  }) {
    return (
      <ReactMarkdown
        components={{
          pre: ({ children: codeNode }) => {
            const command = textContent(codeNode).trim();
            const language = codeLanguage(codeNode);
            const isCommand = isShellLanguage(language);
            return (
              <div className="ai-code-block">
                <div className="ai-code-block-header">
                  <span className="ai-code-block-label">
                    {isCommand ? "命令建议" : "代码"}
                    <Tag size="small">{isCommand ? "仅供查看" : language || "代码"}</Tag>
                  </span>
                  <Space size="mini">
                    <Tooltip content="复制">
                      <Button
                        aria-label="复制代码"
                        icon={<IconCopy />}
                        onClick={() =>
                          void onCopyCode(command)
                            .then(() => Message.success("已复制"))
                            .catch((error) => Message.error(commandErrorMessage(error)))
                        }
                        size="mini"
                        type="text"
                      />
                    </Tooltip>
                  </Space>
                </div>
                <pre>{codeNode}</pre>
              </div>
            );
          },
        }}
        remarkPlugins={REMARK_PLUGINS}
      >
        {children}
      </ReactMarkdown>
    );
  },
  (previous, next) => previous.children === next.children,
);

function AiMessageTimeline({
  actions,
  activeConversationAvailable,
  applyingFileChanges,
  canInsertCommand,
  dockedCommandProposalIds,
  dockedDiagnosticPlanIds,
  dockedFileEditProposalIds,
  dockedFileOperationProposalIds,
  expandedToolRuns,
  hasRecentTerminalOutput,
  hostName,
  loading,
  messages,
  scrollRef,
  sending,
  sessionId,
}: AiMessageTimelineProps) {
  return (
    <div className="ai-assistant-messages" ref={scrollRef}>
      {loading && !activeConversationAvailable ? (
        <Spin />
      ) : messages.length ? (
        messages.map((message, index) => {
          if (
            containsOnlyDockedApproval(
              message,
              dockedCommandProposalIds,
              dockedDiagnosticPlanIds,
              dockedFileEditProposalIds,
              dockedFileOperationProposalIds,
            )
          ) {
            return null;
          }
          return (
            <div className={`ai-message ai-message-${message.role}`} key={message.id}>
              <div className="ai-message-role">
                {message.role === "assistant" ? <IconRobot /> : null}
                <Typography.Text type="secondary">
                  {message.role === "assistant" ? "AI" : "你"}
                </Typography.Text>
                {message.contextLabels?.map((label) => (
                  <Tag key={label} size="small">
                    {label}
                  </Tag>
                ))}
              </div>
              {message.role === "assistant" && message.reasoning && (
                <AiReasoningDisclosure
                  active={messageIsActivelyThinking(message, index, messages.length, sending)}
                  reasoning={message.reasoning}
                />
              )}
              {message.role === "assistant" &&
                Boolean(
                  message.diagnosticPlans?.some((plan) => !dockedDiagnosticPlanIds?.has(plan.id)),
                ) && (
                  <AiDiagnosticPlanList
                    expandedRuns={expandedToolRuns}
                    messageId={message.id}
                    onAddToDraft={actions.addToolRunToDraft}
                    onCancel={actions.cancelDiagnosticPlan}
                    onConfirm={actions.confirmDiagnosticPlan}
                    onRevise={actions.reviseDiagnosticPlan}
                    onStop={actions.stopDiagnosticPlan}
                    onToggleRun={actions.toggleToolRun}
                    plans={(message.diagnosticPlans ?? []).filter(
                      (plan) => !dockedDiagnosticPlanIds?.has(plan.id),
                    )}
                    runs={message.toolRuns ?? []}
                    sending={sending}
                  />
                )}
              {message.role === "assistant" &&
                Boolean(message.toolRuns?.some((run) => !run.planId)) && (
                  <AiToolRunList
                    expandedRuns={expandedToolRuns}
                    messageId={message.id}
                    onAddToDraft={actions.addToolRunToDraft}
                    onToggle={actions.toggleToolRun}
                    runs={message.toolRuns?.filter((run) => !run.planId) ?? []}
                    sending={sending}
                  />
                )}
              {message.role === "assistant" && (
                <AiCommandProposalList
                  canInsertCommand={canInsertCommand}
                  hasRecentTerminalOutput={hasRecentTerminalOutput}
                  hostName={hostName}
                  onApprove={(proposal) => actions.approveCommandProposal(message.id, proposal)}
                  onAnalyze={(proposal) => actions.analyzeCommand(message.id, proposal)}
                  onCopy={actions.copyCommand}
                  onCopyAll={actions.copyCommands}
                  onReject={(proposalId) => actions.rejectCommand(message.id, proposalId)}
                  onRevise={(proposal, feedback) =>
                    actions.reviseCommand(message.id, proposal, feedback)
                  }
                  proposals={message.commandProposals?.filter(
                    (proposal) => !dockedCommandProposalIds?.has(proposal.id),
                  )}
                  records={message.commandRecords}
                  sending={sending}
                  sessionId={sessionId}
                />
              )}
              {message.role === "assistant" && (
                <AiFileChangePanels
                  applying={applyingFileChanges}
                  changes={message.fileChanges}
                  editProposals={message.fileEditProposals?.filter(
                    (proposal) => !dockedFileEditProposalIds?.has(proposal.id),
                  )}
                  onApplyAllEdits={(proposals) => actions.applyAllFileEdits(message.id, proposals)}
                  onApplyAllOperations={(proposals) =>
                    actions.applyAllFileOperations(message.id, proposals)
                  }
                  onOpenEditReview={(proposal) => actions.openFileEditReview(message.id, proposal)}
                  onOpenOperationReview={(proposal) =>
                    actions.openFileOperationReview(message.id, proposal)
                  }
                  onRejectEdit={(proposalId) => actions.rejectFileEdit(message.id, proposalId)}
                  onRejectOperation={(proposalId) =>
                    actions.rejectFileOperation(message.id, proposalId)
                  }
                  onRetryEdit={(proposalId) => actions.retryFileEdit(message.id, proposalId)}
                  onRetryOperation={(proposalId) =>
                    actions.retryFileOperation(message.id, proposalId)
                  }
                  onRollbackAllEdits={(proposals) =>
                    actions.rollbackAllFileEdits(message.id, proposals)
                  }
                  onRollbackAllOperations={(proposals) =>
                    actions.rollbackAllFileOperations(message.id, proposals)
                  }
                  onRollbackEdit={(proposal) => actions.rollbackFileEdit(message.id, proposal)}
                  onRollbackOperation={(proposal) =>
                    actions.rollbackFileOperation(message.id, proposal)
                  }
                  operationProposals={message.fileOperationProposals?.filter(
                    (proposal) => !dockedFileOperationProposalIds?.has(proposal.id),
                  )}
                />
              )}
              <div className="ai-message-content">
                {message.role === "assistant" ? (
                  <>
                    {message.content && (
                      <AiMarkdown onCopyCode={actions.copyCode}>{message.content}</AiMarkdown>
                    )}
                    {messageIsActivelyStreaming(message, index, messages.length, sending) && (
                      <AiStreamingIndicator />
                    )}
                    {message.failed && (
                      <div className="ai-message-failure">
                        <Typography.Text type="error">{message.error}</Typography.Text>
                        <Button
                          icon={<IconRefresh />}
                          onClick={() => actions.retryMessage(index)}
                          size="mini"
                          type="text"
                        >
                          {index === messages.length - 1 ? "重试" : "重新提问"}
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  message.content
                )}
              </div>
            </div>
          );
        })
      ) : (
        <div className="ai-assistant-empty">
          <IconRobot className="ai-assistant-empty-icon" />
          <Typography.Text type="secondary">常用任务</Typography.Text>
          <div className="ai-prompt-presets">
            {AI_PROMPT_PRESETS.map((preset) => (
              <Button
                icon={promptPresetIcon(preset.id)}
                key={preset.id}
                onClick={() => actions.selectPreset(preset)}
                type="secondary"
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(AiMessageTimeline);
