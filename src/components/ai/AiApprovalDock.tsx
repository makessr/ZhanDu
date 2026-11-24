import type { AiApprovalQueueItem } from "../../ai-approval-queue";
import type { AiCommandProposal } from "../../ai-command-proposals";
import type { AiFileEditProposal } from "../../ai-file-edits";
import type { AiFileOperationProposal } from "../../ai-file-operations";
import type { AiToolRun } from "../../ai-tools";
import AiCommandProposalList from "../AiCommandProposalList";
import AiDiagnosticPlanList from "../AiDiagnosticPlanList";
import AiFileApprovalCard from "../AiFileApprovalCard";

export interface AiApprovalDockActions {
  addToolRunToDraft: (run: AiToolRun) => void;
  analyzeCommand: (messageId: string, proposal: AiCommandProposal) => void;
  approveCommand: (messageId: string, proposal: AiCommandProposal) => void | Promise<void>;
  approveFileEdit: (messageId: string, proposal: AiFileEditProposal) => unknown | Promise<unknown>;
  approveFileOperation: (
    messageId: string,
    proposal: AiFileOperationProposal,
  ) => unknown | Promise<unknown>;
  cancelDiagnosticPlan: (planId: string) => void;
  confirmDiagnosticPlan: (planId: string, selectedCallIds: string[]) => void;
  copyCommand: (command: string) => void | Promise<void>;
  copyCommands: (proposals: AiCommandProposal[]) => void | Promise<void>;
  openFileEditReview: (messageId: string, proposal: AiFileEditProposal) => void;
  openFileOperationReview: (messageId: string, proposal: AiFileOperationProposal) => void;
  rejectCommand: (messageId: string, proposalId: string) => unknown | Promise<unknown>;
  rejectFileEdit: (messageId: string, proposalId: string) => unknown | Promise<unknown>;
  rejectFileOperation: (messageId: string, proposalId: string) => unknown | Promise<unknown>;
  reviseCommand: (
    messageId: string,
    proposal: AiCommandProposal,
    feedback: string,
  ) => void | Promise<void>;
  reviseDiagnosticPlan: (planId: string, feedback: string) => void;
  reviseFileEdit: (
    messageId: string,
    proposalId: string,
    feedback: string,
  ) => unknown | Promise<unknown>;
  reviseFileOperation: (
    messageId: string,
    proposalId: string,
    feedback: string,
  ) => unknown | Promise<unknown>;
  stopDiagnosticPlan: (planId: string) => void;
  toggleToolRun: (key: string) => void;
}

interface AiApprovalDockProps {
  actions: AiApprovalDockActions;
  approval: AiApprovalQueueItem;
  canInsertCommand: boolean;
  expandedToolRuns: ReadonlySet<string>;
  fileEditApplying: boolean;
  hasRecentTerminalOutput: boolean;
  hostName: string;
  queueCount: number;
  sending: boolean;
  sessionId: string | null;
}

export default function AiApprovalDock({
  actions,
  approval,
  canInsertCommand,
  expandedToolRuns,
  fileEditApplying,
  hasRecentTerminalOutput,
  hostName,
  queueCount,
  sending,
  sessionId,
}: AiApprovalDockProps) {
  return (
    <section aria-label="AI 操作审批" className="ai-approval-dock">
      {approval.kind === "command" ? (
        <AiCommandProposalList
          canInsertCommand={canInsertCommand}
          hasRecentTerminalOutput={hasRecentTerminalOutput}
          hostName={hostName}
          key={approval.proposal.id}
          onAnalyze={(proposal) => actions.analyzeCommand(approval.messageId, proposal)}
          onApprove={(proposal) => actions.approveCommand(approval.messageId, proposal)}
          onCopy={actions.copyCommand}
          onCopyAll={actions.copyCommands}
          onReject={(proposalId) => actions.rejectCommand(approval.messageId, proposalId)}
          onRevise={(proposal, feedback) =>
            actions.reviseCommand(approval.messageId, proposal, feedback)
          }
          presentation="approval"
          proposals={[approval.proposal]}
          queueCount={queueCount}
          sending={sending}
          sessionId={sessionId}
        />
      ) : approval.kind === "diagnostic" ? (
        <AiDiagnosticPlanList
          expandedRuns={expandedToolRuns}
          key={approval.plan.id}
          messageId={approval.messageId}
          onAddToDraft={actions.addToolRunToDraft}
          onCancel={actions.cancelDiagnosticPlan}
          onConfirm={actions.confirmDiagnosticPlan}
          onRevise={actions.reviseDiagnosticPlan}
          onStop={actions.stopDiagnosticPlan}
          onToggleRun={actions.toggleToolRun}
          plans={[approval.plan]}
          presentation="approval"
          queueCount={queueCount}
          runs={approval.runs}
          sending={sending}
        />
      ) : approval.kind === "file-edit" ? (
        <AiFileApprovalCard
          applying={fileEditApplying}
          editProposal={approval.proposal}
          key={approval.proposal.id}
          onApprove={() => void actions.approveFileEdit(approval.messageId, approval.proposal)}
          onOpenReview={() => actions.openFileEditReview(approval.messageId, approval.proposal)}
          onReject={() => void actions.rejectFileEdit(approval.messageId, approval.proposal.id)}
          onRevise={(feedback) =>
            void actions.reviseFileEdit(approval.messageId, approval.proposal.id, feedback)
          }
          queueCount={queueCount}
        />
      ) : (
        <AiFileApprovalCard
          applying={fileEditApplying}
          key={approval.proposal.id}
          onApprove={() => void actions.approveFileOperation(approval.messageId, approval.proposal)}
          onOpenReview={() =>
            actions.openFileOperationReview(approval.messageId, approval.proposal)
          }
          onReject={() =>
            void actions.rejectFileOperation(approval.messageId, approval.proposal.id)
          }
          onRevise={(feedback) =>
            void actions.reviseFileOperation(approval.messageId, approval.proposal.id, feedback)
          }
          operationProposal={approval.proposal}
          queueCount={queueCount}
        />
      )}
    </section>
  );
}
