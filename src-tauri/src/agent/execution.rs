use super::*;

struct PreparedActionExecution {
    arguments: serde_json::Value,
    tool: String,
    execution_kind: AgentActionExecutionKind,
    decision: PolicyDecision,
    reason: String,
    scope: ApprovalScope,
    has_content_override: bool,
}

impl AgentTaskManager {
    pub(crate) fn validate_action_execution_context(
        &self,
        task_id: &str,
        action_id: &str,
    ) -> Result<String, String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let tasks = self.lock_tasks()?;
        let task = tasks
            .get(task_id)
            .ok_or_else(|| "AI 任务不存在".to_string())?;
        if !task.actions.iter().any(|action| action.id == action_id) {
            return Err("AI 动作不存在".to_string());
        }
        Ok(task.validate_execution_context()?.to_string())
    }

    fn prepare_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        content_override: Option<String>,
    ) -> Result<PreparedActionExecution, String> {
        if !valid_identifier(task_id) || !valid_identifier(action_id) {
            return Err("AI 动作作用域无效".to_string());
        }
        let (
            mut arguments,
            tool,
            execution_kind,
            approval_mode,
            risk,
            host_id,
            session_id,
            current_directory,
        ) = {
            let tasks = self.lock_tasks()?;
            let task = tasks
                .get(task_id)
                .ok_or_else(|| "AI 任务不存在".to_string())?;
            if matches!(
                task.status,
                AgentTaskStatus::Failed | AgentTaskStatus::Cancelled
            ) {
                return Err("AI 任务已经结束".to_string());
            }
            let action = task
                .actions
                .iter()
                .find(|action| action.id == action_id)
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            let execution_kind = if action.tool == "execute_terminal_command" {
                AgentActionExecutionKind::TerminalCommand
            } else {
                AgentActionExecutionKind::TrustedExecutor
            };
            if rollback && execution_kind == AgentActionExecutionKind::TerminalCommand {
                return Err("终端命令不能通过文件回滚流程撤销".to_string());
            }
            if rollback {
                if action.status != AgentActionStatus::Succeeded {
                    return Err("AI 动作当前不能回滚".to_string());
                }
            } else if execution_kind == AgentActionExecutionKind::TerminalCommand {
                if action.status != AgentActionStatus::Pending {
                    return Err("AI 命令当前不能再次审批".to_string());
                }
            } else if !matches!(
                action.status,
                AgentActionStatus::Pending | AgentActionStatus::Approved
            ) {
                return Err("AI 动作当前不能执行".to_string());
            }
            let session_id = task
                .terminal_session_id
                .clone()
                .ok_or_else(|| "AI 动作缺少绑定会话".to_string())?;
            (
                action.arguments.clone(),
                action.tool.clone(),
                execution_kind,
                task.approval_mode,
                action.risk,
                task.host_id.clone(),
                session_id,
                task.current_directory.clone(),
            )
        };
        let has_content_override = if let Some(content) = content_override {
            if rollback || tool != "propose_file_edit" {
                return Err("只有待应用的文件修改可以调整最终内容".to_string());
            }
            if content.len() > MAX_AGENT_WRITABLE_FILE_BYTES || content.contains('\0') {
                return Err("AI 文件修改的最终内容无效".to_string());
            }
            let original = arguments
                .get("originalContent")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "AI 文件修改缺少可信原始快照".to_string())?;
            if content == original {
                return Err("AI 文件修改没有产生变化".to_string());
            }
            arguments["content"] = serde_json::Value::String(content);
            true
        } else {
            false
        };
        let policy = registered_action_policy(approval_mode, &tool, risk, &arguments);
        let direction = if rollback { "rollback" } else { "apply" };
        let fingerprint_arguments = serde_json::json!({
            "arguments": arguments.clone(),
            "direction": direction,
        });
        let scope = ApprovalScope {
            task_id: task_id.to_string(),
            plan_id: format!("action:{action_id}:{direction}"),
            call_id: action_id.to_string(),
            host_id,
            session_id: Some(session_id),
            current_directory,
            action_fingerprint: action_fingerprint(&tool, &fingerprint_arguments)?,
        };
        Ok(PreparedActionExecution {
            arguments,
            tool,
            execution_kind,
            decision: policy.decision,
            reason: policy.reason,
            scope,
            has_content_override,
        })
    }

    /// Issues a single-use credential for the user's approval of one action.
    /// Returns `None` when the approval policy allows the action without a prompt.
    pub(crate) fn approve_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        content_override: Option<String>,
    ) -> Result<Option<String>, String> {
        let prepared =
            self.prepare_action_execution(task_id, action_id, rollback, content_override)?;
        match prepared.decision {
            PolicyDecision::Deny => Err(prepared.reason),
            PolicyDecision::Allow => Ok(None),
            PolicyDecision::Prompt => self
                .approval_credentials
                .lock()
                .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                .issue(prepared.scope, timestamp_ms(), APPROVAL_CREDENTIAL_TTL_MS)
                .map(|credential| Some(credential.token().to_string())),
        }
    }

    pub(crate) fn authorize_action_execution(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        approval_credential: Option<&str>,
        content_override: Option<String>,
    ) -> Result<(AuthorizedAgentAction, Vec<AgentTaskEvent>), String> {
        let prepared =
            self.prepare_action_execution(task_id, action_id, rollback, content_override)?;
        match prepared.decision {
            PolicyDecision::Deny => return Err(prepared.reason),
            PolicyDecision::Prompt => {
                let token =
                    approval_credential.ok_or_else(|| "该 AI 动作需要本次用户审批".to_string())?;
                let credential =
                    ApprovalCredential::from_token(token.to_string(), action_id.to_string());
                self.approval_credentials
                    .lock()
                    .map_err(|_| "AI 审批凭证状态不可用".to_string())?
                    .consume(&credential, &prepared.scope, timestamp_ms())?;
            }
            PolicyDecision::Allow => {}
        }
        if prepared.has_content_override {
            let mut tasks = self.lock_tasks()?;
            let action = tasks
                .get_mut(task_id)
                .and_then(|task| {
                    task.actions
                        .iter_mut()
                        .find(|action| action.id == action_id)
                })
                .ok_or_else(|| "AI 动作不存在".to_string())?;
            action.arguments = prepared.arguments.clone();
        }
        let session_id = prepared
            .scope
            .session_id
            .clone()
            .ok_or_else(|| "AI 动作缺少绑定会话".to_string())?;
        let execution = AuthorizedAgentAction {
            task_id: task_id.to_string(),
            action_id: action_id.to_string(),
            tool: prepared.tool,
            arguments: prepared.arguments,
            session_id,
            host_id: prepared.scope.host_id,
            current_directory: prepared.scope.current_directory,
            rollback,
            execution_kind: prepared.execution_kind,
        };
        let transition = if rollback {
            AgentActionTransition::RollbackStart
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand {
            AgentActionTransition::Approve
        } else {
            AgentActionTransition::Start
        };
        let summary = if rollback {
            "用户确认回滚该动作"
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand
            && prepared.decision == PolicyDecision::Allow
        {
            "审批策略允许执行终端命令"
        } else if execution.execution_kind == AgentActionExecutionKind::TerminalCommand {
            "用户批准终端命令"
        } else if prepared.decision == PolicyDecision::Allow {
            "审批策略允许执行该动作"
        } else {
            "用户批准执行该动作"
        };
        let events = self.transition_action(AgentActionTransitionRequest {
            task_id: task_id.to_string(),
            action_id: action_id.to_string(),
            transition,
            summary: Some(summary.to_string()),
            error: None,
        })?;
        Ok((execution, events))
    }

    #[cfg(test)]
    pub(crate) fn authorize_action_execution_confirmed(
        &self,
        task_id: &str,
        action_id: &str,
        rollback: bool,
        content_override: Option<String>,
    ) -> Result<(AuthorizedAgentAction, Vec<AgentTaskEvent>), String> {
        let credential =
            self.approve_action_execution(task_id, action_id, rollback, content_override.clone())?;
        self.authorize_action_execution(
            task_id,
            action_id,
            rollback,
            credential.as_deref(),
            content_override,
        )
    }
}
