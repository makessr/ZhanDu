use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, PoisonError},
};

use crate::{
    local_paths,
    protocol::{CommandError, CommandResult},
};

const LOCAL_FILE_MISSING: &str = "本地文件不存在，可能已被移动或删除";
const LOCAL_FILE_NOT_DOWNLOADED: &str = "该路径不是由栈渡本次会话下载的文件";
const MAX_COMPLETED_TRANSFERS: usize = 512;

fn completed_transfers() -> &'static Mutex<VecDeque<PathBuf>> {
    static COMPLETED: OnceLock<Mutex<VecDeque<PathBuf>>> = OnceLock::new();
    COMPLETED.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Records a destination produced by an SFTP download so it can be opened afterwards.
pub(crate) fn record_completed_transfer(path: impl Into<PathBuf>) {
    let path = path.into();
    let path = path.canonicalize().unwrap_or(path);
    let mut completed = completed_transfers()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    completed.retain(|known| known != &path);
    while completed.len() >= MAX_COMPLETED_TRANSFERS {
        completed.pop_front();
    }
    completed.push_back(path);
}

fn is_completed_transfer(path: &Path) -> bool {
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    let completed = completed_transfers()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    completed
        .iter()
        .any(|known| canonical == *known || (known.is_dir() && canonical.starts_with(known)))
}

fn existing_local_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("本地文件路径不能为空".to_string());
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("本地文件路径无效".to_string());
    }
    if !path.exists() {
        return Err(LOCAL_FILE_MISSING.to_string());
    }
    Ok(path.to_path_buf())
}

fn map_local_file_error(operation: &'static str, error: String) -> CommandError {
    if error == LOCAL_FILE_MISSING {
        CommandError::not_found(operation, error)
    } else if error == LOCAL_FILE_NOT_DOWNLOADED {
        CommandError::permission_denied(operation, error)
    } else if error == "本地文件路径不能为空" || error == "本地文件路径无效" {
        CommandError::invalid_request(operation, error)
    } else {
        CommandError::io(operation, error)
    }
}

/// Opens the system file manager at the file's directory with the file selected.
#[tauri::command]
pub(crate) fn local_file_reveal(window: tauri::WebviewWindow, path: String) -> CommandResult<()> {
    local_paths::ensure_allowed_window(window.label())
        .map_err(|error| CommandError::permission_denied("local_file_reveal", error))?;
    let path = existing_local_path(&path)
        .map_err(|error| map_local_file_error("local_file_reveal", error))?;
    if !is_completed_transfer(&path) {
        return Err(CommandError::permission_denied(
            "local_file_reveal",
            LOCAL_FILE_NOT_DOWNLOADED,
        ));
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| {
        CommandError::io(
            "local_file_reveal",
            format!("无法打开本地文件所在位置：{error}"),
        )
    })
}

/// Opens the file with the system's default application.
#[tauri::command]
pub(crate) fn local_file_open(window: tauri::WebviewWindow, path: String) -> CommandResult<()> {
    local_paths::ensure_allowed_window(window.label())
        .map_err(|error| CommandError::permission_denied("local_file_open", error))?;
    let path = existing_local_path(&path)
        .map_err(|error| map_local_file_error("local_file_open", error))?;
    if !is_completed_transfer(&path) {
        return Err(CommandError::permission_denied(
            "local_file_open",
            LOCAL_FILE_NOT_DOWNLOADED,
        ));
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| CommandError::io("local_file_open", format!("无法打开本地文件：{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_relative_and_missing_paths() {
        assert!(existing_local_path("").is_err());
        assert!(existing_local_path("relative/file.txt").is_err());
        let missing = std::env::temp_dir().join("fineshell-missing-local-file-for-test");
        assert_eq!(
            existing_local_path(missing.to_str().unwrap()),
            Err(LOCAL_FILE_MISSING.to_string())
        );
    }

    #[test]
    fn classifies_missing_files_as_not_found() {
        let error = map_local_file_error("local_file_reveal", LOCAL_FILE_MISSING.to_string());
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "not_found");
    }

    #[test]
    fn accepts_existing_files() {
        let directory = std::env::temp_dir();
        assert_eq!(
            existing_local_path(directory.to_str().unwrap()),
            Ok(directory)
        );
    }

    #[test]
    fn only_recorded_transfers_may_be_opened() {
        let directory =
            std::env::temp_dir().join(format!("zhandu-local-file-open-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("download.txt");
        std::fs::write(&file, "data").unwrap();

        assert!(!is_completed_transfer(&file));
        record_completed_transfer(&file);
        assert!(is_completed_transfer(&file));

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recorded_directories_cover_extracted_contents() {
        let directory =
            std::env::temp_dir().join(format!("zhandu-local-dir-open-{}", std::process::id()));
        let nested = directory.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("entry.txt");
        std::fs::write(&file, "data").unwrap();

        assert!(!is_completed_transfer(&file));
        record_completed_transfer(&directory);
        assert!(is_completed_transfer(&file));

        std::fs::remove_dir_all(directory).unwrap();
    }
}
