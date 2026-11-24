use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

use crate::protocol::{CommandError, CommandResult};

const GRANT_TTL: Duration = Duration::from_secs(300);
const MAX_PENDING_GRANTS: usize = 256;
const ALLOWED_WINDOW_LABELS: [&str; 2] = ["main", "settings"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathOperation {
    Read,
    Write,
}

struct PathGrant {
    path: PathBuf,
    operation: PathOperation,
    expires_at: Instant,
}

fn grants() -> &'static Mutex<HashMap<String, PathGrant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, PathGrant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn ensure_allowed_window(label: &str) -> Result<(), String> {
    if ALLOWED_WINDOW_LABELS.contains(&label) {
        Ok(())
    } else {
        Err("当前窗口无权访问本地文件".to_string())
    }
}

/// Issues a single-use token for a path the user just approved or the backend resolved.
pub(crate) fn grant(path: PathBuf, operation: PathOperation) -> String {
    grant_with_ttl(path, operation, GRANT_TTL)
}

fn grant_with_ttl(path: PathBuf, operation: PathOperation, ttl: Duration) -> String {
    let token = format!("{:032x}", rand::random::<u128>());
    let mut grants = grants().lock().unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    grants.retain(|_, grant| grant.expires_at > now);
    if grants.len() >= MAX_PENDING_GRANTS {
        if let Some(oldest) = grants
            .iter()
            .min_by_key(|(_, grant)| grant.expires_at)
            .map(|(token, _)| token.clone())
        {
            grants.remove(&oldest);
        }
    }
    grants.insert(
        token.clone(),
        PathGrant {
            path,
            operation,
            expires_at: now + ttl,
        },
    );
    token
}

/// Consumes a token, enforcing its operation scope and expiry exactly once.
pub(crate) fn consume(token: &str, operation: PathOperation) -> Result<PathBuf, String> {
    let mut grants = grants().lock().unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    grants.retain(|_, grant| grant.expires_at > now);
    let grant = grants
        .remove(token)
        .ok_or_else(|| "本地文件访问令牌无效或已过期".to_string())?;
    if grant.operation != operation {
        return Err("本地文件访问令牌与操作不匹配".to_string());
    }
    Ok(grant.path)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LocalPathPickMode {
    Open,
    Save,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalPathPickRequest {
    mode: LocalPathPickMode,
    title: String,
    #[serde(default)]
    default_path: Option<String>,
    #[serde(default)]
    filter_name: Option<String>,
    #[serde(default)]
    extensions: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedLocalPath {
    path: String,
    token: String,
}

#[tauri::command]
pub(crate) async fn pick_local_path(
    window: tauri::WebviewWindow,
    request: LocalPathPickRequest,
) -> CommandResult<Option<PickedLocalPath>> {
    ensure_allowed_window(window.label())
        .map_err(|error| CommandError::permission_denied("pick_local_path", error))?;

    let operation = match request.mode {
        LocalPathPickMode::Open => PathOperation::Read,
        LocalPathPickMode::Save => PathOperation::Write,
    };
    let mut builder = window.dialog().file().set_title(&request.title);
    if let Some(default_path) = request
        .default_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.set_file_name(default_path);
    }
    if let Some(extensions) = request.extensions.as_ref() {
        let extensions = extensions
            .iter()
            .map(|extension| extension.trim_start_matches('.'))
            .filter(|extension| !extension.is_empty())
            .collect::<Vec<_>>();
        if !extensions.is_empty() {
            let name = request.filter_name.as_deref().unwrap_or("文件");
            builder = builder.add_filter(name, &extensions);
        }
    }

    // Blocking dialogs must not run on the UI thread; async commands execute on the
    // async runtime, so the nested modal loop is safe here.
    let picked = match request.mode {
        LocalPathPickMode::Open => builder.blocking_pick_file(),
        LocalPathPickMode::Save => builder.blocking_save_file(),
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| {
        CommandError::invalid_request("pick_local_path", format!("无法解析所选路径：{error}"))
    })?;
    let path = path.to_str().ok_or_else(|| {
        CommandError::invalid_request("pick_local_path", "所选路径不是有效的 UTF-8 路径")
    })?;
    let token = grant(PathBuf::from(path), operation);
    Ok(Some(PickedLocalPath {
        path: path.to_string(),
        token,
    }))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{consume, grant_with_ttl, PathOperation};

    #[test]
    fn grants_are_single_use_and_operation_scoped() {
        let token = grant_with_ttl(
            std::path::PathBuf::from("/tmp/example"),
            PathOperation::Read,
            Duration::from_secs(60),
        );

        assert_eq!(
            consume(&token, PathOperation::Write),
            Err("本地文件访问令牌与操作不匹配".to_string())
        );
        assert!(consume(&token, PathOperation::Read).is_err());
    }

    #[test]
    fn consume_returns_path_once() {
        let token = grant_with_ttl(
            std::path::PathBuf::from("/tmp/example"),
            PathOperation::Write,
            Duration::from_secs(60),
        );

        assert_eq!(
            consume(&token, PathOperation::Write),
            Ok(std::path::PathBuf::from("/tmp/example"))
        );
        assert!(consume(&token, PathOperation::Write).is_err());
    }

    #[test]
    fn expired_tokens_are_rejected() {
        let token = grant_with_ttl(
            std::path::PathBuf::from("/tmp/example"),
            PathOperation::Read,
            Duration::ZERO,
        );

        assert!(consume(&token, PathOperation::Read).is_err());
    }

    #[test]
    fn unknown_tokens_are_rejected() {
        assert!(consume("not-a-token", PathOperation::Read).is_err());
    }
}
