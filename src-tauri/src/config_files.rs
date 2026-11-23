use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use crate::protocol::{CommandError, CommandResult};

const MAX_CONFIG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_THEME_FILE_BYTES: u64 = 64 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct GhosttyThemeFile {
    name: String,
    contents: String,
}

#[tauri::command]
pub(crate) async fn read_ghostty_themes(
    window: tauri::WebviewWindow,
) -> CommandResult<Vec<GhosttyThemeFile>> {
    if window.label() != "settings" {
        return Err(CommandError::from_message(
            "read_ghostty_themes",
            "仅设置窗口可读取终端主题",
        ));
    }
    tauri::async_runtime::spawn_blocking(|| collect_ghostty_themes(ghostty_theme_directories()))
        .await
        .map_err(|error| CommandError::from_message("read_ghostty_themes", error.to_string()))
}

fn ghostty_theme_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in [
        "XDG_CONFIG_HOME",
        if cfg!(windows) {
            "LOCALAPPDATA"
        } else {
            "HOME"
        },
    ] {
        if let Some(root) = std::env::var_os(variable).filter(|root| !root.is_empty()) {
            let root = PathBuf::from(root);
            if root.is_absolute() {
                roots.push(if variable == "HOME" {
                    root.join(".config")
                } else {
                    root
                });
            }
        }
    }
    if cfg!(windows) {
        if let Some(home) = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        {
            roots.push(home.join(".config"));
        }
    }
    roots
        .into_iter()
        .map(|root| root.join("ghostty").join("themes"))
        .collect()
}

fn collect_ghostty_themes(roots: Vec<PathBuf>) -> Vec<GhosttyThemeFile> {
    let mut files = std::collections::BTreeMap::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.take(512).flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || files.contains_key(&name) {
                continue;
            }
            let Ok(file) = fs::File::open(entry.path()) else {
                continue;
            };
            if file
                .metadata()
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_THEME_FILE_BYTES)
            {
                let mut contents = String::new();
                if file
                    .take(MAX_THEME_FILE_BYTES + 1)
                    .read_to_string(&mut contents)
                    .is_ok()
                    && contents.len() as u64 <= MAX_THEME_FILE_BYTES
                {
                    files.insert(name.clone(), GhosttyThemeFile { name, contents });
                }
            }
        }
    }
    files.into_values().collect()
}

#[tauri::command]
pub fn read_config_file(path: String) -> CommandResult<String> {
    read_config_file_inner(path)
        .map_err(|error| CommandError::from_message("read_config_file", error))
}

fn read_config_file_inner(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取配置文件: {error}"))?;
    if metadata.len() > MAX_CONFIG_FILE_BYTES {
        return Err("配置文件超过 5 MB 限制".to_string());
    }

    fs::read_to_string(path).map_err(|error| format!("无法读取配置文件: {error}"))
}

#[tauri::command]
pub fn ssh_config_include_files(root: String, pattern: String) -> CommandResult<Vec<String>> {
    resolve_ssh_config_include(&root, &pattern)
        .map_err(|error| CommandError::from_message("ssh_config_include_files", error))
}

fn resolve_ssh_config_include(root: &str, pattern: &str) -> Result<Vec<String>, String> {
    if pattern.is_empty() || pattern.contains(['%', '$']) {
        return Err("Include 路径包含不支持的占位符".into());
    }
    let path = Path::new(pattern);
    let expanded = if let Some(relative) = pattern
        .strip_prefix("~/")
        .or_else(|| pattern.strip_prefix("~\\"))
    {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or("无法确定用户的主目录")?;
        PathBuf::from(home).join(relative)
    } else if path.is_absolute() {
        path.to_path_buf()
    } else {
        if pattern.starts_with('~') {
            return Err("Include 仅支持当前用户的 ~/ 路径".into());
        }
        Path::new(root)
            .parent()
            .ok_or("无法确定配置文件目录")?
            .join(path)
    };
    let mut files = Vec::new();
    let pattern = expanded.to_str().ok_or("Include 路径不是 UTF-8")?;
    for result in glob::glob(pattern).map_err(|error| format!("Include 路径无效: {error}"))? {
        let path = result.map_err(|error| format!("无法读取 Include 路径: {error}"))?;
        if !path.is_file() {
            continue;
        }
        if files.len() >= 128 {
            return Err("Include 匹配的文件过多".into());
        }
        let path = path
            .canonicalize()
            .map_err(|error| format!("无法读取 Include 路径: {error}"))?;
        files.push(
            path.into_os_string()
                .into_string()
                .map_err(|_| "Include 路径不是 UTF-8")?,
        );
    }
    Ok(files)
}

#[tauri::command]
pub fn write_config_file(path: String, contents: String) -> CommandResult<()> {
    write_config_file_inner(path, contents)
        .map_err(|error| CommandError::from_message("write_config_file", error))
}

fn write_config_file_inner(path: String, contents: String) -> Result<(), String> {
    if contents.len() as u64 > MAX_CONFIG_FILE_BYTES {
        return Err("配置文件超过 5 MB 限制".to_string());
    }
    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录: {error}"))?;
        }
    }

    fs::write(path, contents).map_err(|error| format!("无法写入配置文件: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::{
        collect_ghostty_themes, read_config_file, resolve_ssh_config_include, write_config_file,
        MAX_CONFIG_FILE_BYTES, MAX_THEME_FILE_BYTES,
    };

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fineshell-config-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn ssh_include_matches_only_files_in_lexical_order() {
        let directory = temporary_directory("ssh-include");
        let includes = directory.join("config.d");
        fs::create_dir_all(includes.join("directory.conf")).unwrap();
        fs::write(includes.join("20.conf"), "Host second").unwrap();
        fs::write(includes.join("10.conf"), "Host first").unwrap();
        fs::write(includes.join("ignored.txt"), "ignored").unwrap();

        let root = directory.join("config");
        let files = resolve_ssh_config_include(root.to_str().unwrap(), "config.d/*.conf").unwrap();
        let names: Vec<_> = files
            .iter()
            .map(|path| {
                std::path::Path::new(path)
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(names, ["10.conf", "20.conf"]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ghostty_theme_scan_uses_directory_precedence_and_skips_non_theme_candidates() {
        let directory = temporary_directory("ghostty-themes");
        let primary = directory.join("primary");
        let secondary = directory.join("secondary");
        fs::create_dir_all(primary.join("nested")).unwrap();
        fs::create_dir_all(&secondary).unwrap();
        fs::write(primary.join("Custom"), "background = #101010").unwrap();
        fs::write(secondary.join("Custom"), "background = #202020").unwrap();
        fs::write(secondary.join("Another"), "palette = 2=#40ff40").unwrap();
        fs::write(primary.join(".hidden"), "background = #ffffff").unwrap();
        fs::write(primary.join("binary"), [0xff]).unwrap();
        fs::write(
            primary.join("large"),
            vec![b'a'; MAX_THEME_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let files = collect_ghostty_themes(vec![primary, secondary]);
        let entries: Vec<_> = files
            .iter()
            .map(|file| (file.name.as_str(), file.contents.as_str()))
            .collect();
        assert_eq!(
            entries,
            [
                ("Another", "palette = 2=#40ff40"),
                ("Custom", "background = #101010")
            ]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn command_boundary_writes_and_reads_nested_configuration() {
        let directory = temporary_directory("round-trip");
        let path = directory.join("nested/config.json");
        let path_value = path.to_string_lossy().into_owned();

        write_config_file(path_value.clone(), "{\"version\":1}".to_string()).unwrap();
        assert_eq!(read_config_file(path_value).unwrap(), "{\"version\":1}");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn command_boundary_returns_structured_not_found_errors() {
        let path = temporary_directory("missing").join("config.json");
        let error = read_config_file(path.to_string_lossy().into_owned()).unwrap_err();
        let serialized = serde_json::to_value(error).unwrap();

        assert_eq!(serialized["code"], "not_found");
        assert_eq!(serialized["operation"], "read_config_file");
        assert_eq!(serialized["retryable"], false);
        assert!(serialized["message"]
            .as_str()
            .unwrap()
            .contains("无法读取配置文件"));
    }

    #[test]
    fn command_boundary_rejects_oversized_configuration_before_writing() {
        let path = temporary_directory("oversized").join("config.json");
        let error = write_config_file(
            path.to_string_lossy().into_owned(),
            "x".repeat(MAX_CONFIG_FILE_BYTES as usize + 1),
        )
        .unwrap_err();
        let serialized = serde_json::to_value(error).unwrap();

        assert_eq!(serialized["code"], "invalid_request");
        assert!(!path.exists());
    }
}
