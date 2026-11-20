use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use tauri::{AppHandle, Manager};

use crate::protocol::{CommandError, CommandResult};

const MANAGED_KEY_PREFIX: &str = "managed://";
const MAX_PRIVATE_KEY_BYTES: usize = 64 * 1024;
const MANAGED_KEY_DIRECTORY: &str = "ssh-keys";

static MANAGED_KEY_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedSshKeyImportResult {
    reference: String,
    key_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedSshKey {
    reference: String,
    public_key: String,
}

#[tauri::command]
pub(crate) fn managed_ssh_key_generate(key_id: String) -> CommandResult<GeneratedSshKey> {
    managed_key_root()
        .and_then(|root| generate_key(root, &key_id))
        .map_err(|error| CommandError::from_message("managed_ssh_key_generate", error))
}

#[tauri::command]
pub(crate) fn managed_ssh_key_public(reference: String) -> CommandResult<String> {
    let read = || {
        let path = resolve_reference(&reference)?
            .ok_or_else(|| "只支持读取栈渡托管密钥的公钥".to_string())?;
        let contents = read_key_file(&path)?;
        let private_key = PrivateKey::from_openssh(contents.as_bytes())
            .map_err(|_| "仅支持读取托管 OpenSSH 私钥的公钥".to_string())?;
        encode_public_key(&private_key)
    };
    read().map_err(|error| CommandError::from_message("managed_ssh_key_public", error))
}

fn generate_key(root: &Path, key_id: &str) -> Result<GeneratedSshKey, String> {
    validate_key_id(key_id)?;
    let private_key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519)
        .map_err(|_| "无法生成 Ed25519 密钥".to_string())?;
    let public_key = encode_public_key(&private_key)?;
    let contents = private_key
        .to_openssh(LineEnding::LF)
        .map_err(|_| "无法编码 OpenSSH 私钥".to_string())?;
    import_private_key(root, key_id, &contents)?;
    Ok(GeneratedSshKey {
        reference: format!("{MANAGED_KEY_PREFIX}{key_id}"),
        public_key,
    })
}

fn encode_public_key(private_key: &PrivateKey) -> Result<String, String> {
    let mut public_key = private_key.public_key().clone();
    public_key.set_comment("zhandu");
    public_key
        .to_openssh()
        .map_err(|_| "无法编码 OpenSSH 公钥".to_string())
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join(MANAGED_KEY_DIRECTORY);

    if let Some(existing) = MANAGED_KEY_ROOT.get() {
        if existing != &root {
            return Err("托管密钥目录已经初始化为其他路径".to_string());
        }
        return Ok(());
    }
    MANAGED_KEY_ROOT
        .set(root)
        .map_err(|_| "无法初始化托管密钥目录".to_string())
}

#[tauri::command]
pub(crate) fn managed_ssh_key_import(
    key_id: String,
    private_key: String,
) -> CommandResult<ManagedSshKeyImportResult> {
    let root = managed_key_root()
        .map_err(|error| CommandError::from_message("managed_ssh_key_import", error))?;
    import_private_key(root, &key_id, &private_key)
        .map(|key_type| ManagedSshKeyImportResult {
            reference: format!("{MANAGED_KEY_PREFIX}{key_id}"),
            key_type,
        })
        .map_err(|error| CommandError::from_message("managed_ssh_key_import", error))
}

#[tauri::command]
pub(crate) fn managed_ssh_key_delete(key_id: String) -> CommandResult<()> {
    let root = managed_key_root()
        .map_err(|error| CommandError::from_message("managed_ssh_key_delete", error))?;
    delete_private_key(root, &key_id)
        .map_err(|error| CommandError::from_message("managed_ssh_key_delete", error))
}

pub(crate) fn resolve_reference(reference: &str) -> Result<Option<PathBuf>, String> {
    let Some(key_id) = reference.strip_prefix(MANAGED_KEY_PREFIX) else {
        return Ok(None);
    };
    validate_key_id(key_id)?;
    Ok(Some(key_path(managed_key_root()?, key_id)))
}

pub(crate) fn read_sync_key(reference: &str) -> Result<String, String> {
    read_key_file(&resolve_private_key_path(reference)?)
}

fn read_key_file(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let file = fs::File::open(path).map_err(|_| "无法读取 SSH 私钥".to_string())?;
    if !file.metadata().map_err(|_| "无法检查 SSH 私钥")?.is_file() {
        return Err("SSH 私钥必须是普通文件".to_string());
    }
    let mut contents = String::new();
    file.take(MAX_PRIVATE_KEY_BYTES as u64 + 1)
        .read_to_string(&mut contents)
        .map_err(|_| "无法读取 SSH 私钥".to_string())?;
    validate_private_key(&contents).map(|(normalized, _)| normalized)
}

pub(crate) fn install_sync_key(key_id: &str, contents: &str) -> Result<String, String> {
    validate_key_id(key_id)?;
    let root = managed_key_root()?;
    let reference = format!("{MANAGED_KEY_PREFIX}{key_id}");
    write_private_key(root, key_id, contents, true)?;
    Ok(reference)
}

pub(crate) fn resolve_private_key_path(path: &str) -> Result<PathBuf, String> {
    if let Some(path) = resolve_reference(path)? {
        return Ok(path);
    }
    let Some(relative) = path.strip_prefix("~/") else {
        return Ok(PathBuf::from(path));
    };
    Ok(std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(relative))
        .unwrap_or_else(|| PathBuf::from(path)))
}

fn managed_key_root() -> Result<&'static Path, String> {
    MANAGED_KEY_ROOT
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| "托管密钥目录尚未初始化".to_string())
}

fn validate_key_id(key_id: &str) -> Result<(), String> {
    if key_id.is_empty()
        || key_id.len() > 160
        || !key_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err("托管密钥标识无效".to_string());
    }
    Ok(())
}

fn key_path(root: &Path, key_id: &str) -> PathBuf {
    root.join(format!("{key_id}.key"))
}

fn prepare_directory(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建托管密钥目录：{error}"))?;
    set_directory_permissions(root)?;
    Ok(())
}

#[cfg(unix)]
fn set_directory_permissions(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法设置托管密钥目录权限：{error}"))
}

#[cfg(not(unix))]
fn set_directory_permissions(_root: &Path) -> Result<(), String> {
    Ok(())
}

fn validate_private_key(private_key: &str) -> Result<(String, &'static str), String> {
    if private_key.len() > MAX_PRIVATE_KEY_BYTES {
        return Err("SSH 私钥内容无效：超过 64 KB 限制".to_string());
    }
    if private_key.contains('\0') {
        return Err("SSH 私钥内容无效".to_string());
    }

    let normalized_line_endings = private_key.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized_line_endings
        .trim_start_matches('\u{feff}')
        .trim();
    if trimmed.is_empty() {
        return Err("SSH 私钥内容不能为空".to_string());
    }

    const FORMATS: [(&str, &str, &str); 6] = [
        (
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----END OPENSSH PRIVATE KEY-----",
            "OpenSSH",
        ),
        (
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----END RSA PRIVATE KEY-----",
            "RSA",
        ),
        (
            "-----BEGIN EC PRIVATE KEY-----",
            "-----END EC PRIVATE KEY-----",
            "EC",
        ),
        (
            "-----BEGIN DSA PRIVATE KEY-----",
            "-----END DSA PRIVATE KEY-----",
            "DSA",
        ),
        (
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----END ENCRYPTED PRIVATE KEY-----",
            "PKCS#8（加密）",
        ),
        (
            "-----BEGIN PRIVATE KEY-----",
            "-----END PRIVATE KEY-----",
            "PKCS#8",
        ),
    ];

    for (header, footer, key_type) in FORMATS {
        if !trimmed.starts_with(header) {
            continue;
        }
        if !trimmed.ends_with(footer) {
            return Err("SSH 私钥内容无效：头部和尾部不匹配".to_string());
        }
        let body = trimmed[header.len()..trimmed.len() - footer.len()].trim();
        if body.is_empty() || body.contains("-----BEGIN ") || body.contains("-----END ") {
            return Err("SSH 私钥内容无效".to_string());
        }
        return Ok((format!("{trimmed}\n"), key_type));
    }

    Err("SSH 私钥内容无效：无法识别格式，请粘贴完整的私钥".to_string())
}

fn import_private_key(root: &Path, key_id: &str, private_key: &str) -> Result<String, String> {
    write_private_key(root, key_id, private_key, false)
}

fn write_private_key(root: &Path, key_id: &str, private_key: &str, replace: bool) -> Result<String, String> {
    validate_key_id(key_id)?;
    let (normalized, key_type) = validate_private_key(private_key)?;
    prepare_directory(root)?;

    let target = key_path(root, key_id);
    if !replace && target.exists() {
        return Err("同名托管密钥已经存在".to_string());
    }

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = root.join(format!(".{key_id}-{}-{unique}.tmp", std::process::id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("无法创建托管密钥临时文件：{error}"))?;
        file.write_all(normalized.as_bytes())
            .map_err(|error| format!("无法写入托管密钥：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步托管密钥：{error}"))?;
        drop(file);

        if replace {
            fs::rename(&temporary, &target)
                .map_err(|error| format!("无法保存同步私钥：{error}"))?;
            return Ok(key_type.to_string());
        }

        if target.exists() {
            return Err("同名托管密钥已经存在".to_string());
        }
        fs::hard_link(&temporary, &target).map_err(|error| format!("无法保存托管密钥：{error}"))?;
        if let Err(error) = fs::remove_file(&temporary) {
            let _ = fs::remove_file(&target);
            return Err(format!("无法清理托管密钥临时文件：{error}"));
        }
        Ok(key_type.to_string())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn delete_private_key(root: &Path, key_id: &str) -> Result<(), String> {
    validate_key_id(key_id)?;
    match fs::remove_file(key_path(root, key_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除托管密钥：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::{
        delete_private_key, encode_public_key, generate_key, import_private_key, key_path,
        read_key_file, validate_key_id, validate_private_key,
    };

    const OPENSSH_KEY: &str = concat!(
        "-----BEGIN OPENSSH PRIVATE KEY-----\r\n",
        "b3BlbnNzaC1rZXktdjEAAAAA\r\n",
        "-----END OPENSSH PRIVATE KEY-----"
    );

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fineshell-managed-key-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn accepts_supported_private_key_and_normalizes_line_endings() {
        let (normalized, key_type) = validate_private_key(OPENSSH_KEY).unwrap();
        assert_eq!(key_type, "OpenSSH");
        assert!(!normalized.contains('\r'));
        assert!(normalized.ends_with('\n'));
    }

    #[test]
    fn rejects_public_keys_and_mismatched_pem_boundaries() {
        assert!(validate_private_key("ssh-ed25519 AAAAC3Nza demo@example.com").is_err());
        assert!(validate_private_key(concat!(
            "-----BEGIN RSA PRIVATE KEY-----\n",
            "AAAA\n",
            "-----END PRIVATE KEY-----"
        ))
        .is_err());
        assert!(validate_private_key(&"x".repeat(64 * 1024 + 1)).is_err());
    }

    #[test]
    fn rejects_unsafe_key_identifiers() {
        for key_id in ["", "../escape", "nested/key", "key.key", "密钥"] {
            assert!(validate_key_id(key_id).is_err(), "accepted {key_id}");
        }
        assert!(validate_key_id("ssh-key_2026-07").is_ok());
    }

    #[test]
    fn imports_with_restricted_permissions_and_deletes_idempotently() {
        let root = temporary_directory("round-trip");
        let key_id = "ssh-key-test";
        assert_eq!(
            import_private_key(&root, key_id, OPENSSH_KEY).unwrap(),
            "OpenSSH"
        );
        let path = key_path(&root, key_id);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            OPENSSH_KEY.replace("\r\n", "\n") + "\n"
        );
        assert!(import_private_key(&root, key_id, OPENSSH_KEY).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        delete_private_key(&root, key_id).unwrap();
        delete_private_key(&root, key_id).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generates_matching_ed25519_keys_without_overwriting() {
        let root = temporary_directory("generate");
        let generated = generate_key(&root, "example").unwrap();
        let contents = read_key_file(&key_path(&root, "example")).unwrap();
        let private = ssh_key::PrivateKey::from_openssh(contents.as_bytes()).unwrap();
        assert_eq!(private.algorithm(), ssh_key::Algorithm::Ed25519);
        assert_eq!(generated.reference, "managed://example");
        assert_eq!(generated.public_key, encode_public_key(&private).unwrap());
        assert!(generate_key(&root, "example").is_err());
        assert_eq!(read_key_file(&key_path(&root, "example")).unwrap(), contents);
        fs::remove_dir_all(root).unwrap();
    }
}
