use std::{collections::BTreeMap, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{Client, Method, StatusCode, Url};
use chacha20poly1305::{aead::{Aead, AeadCore, OsRng, Payload}, KeyInit, XChaCha20Poly1305, XNonce};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use crate::{
    cloud_backup::{
        crypto::{decrypt_payload, encrypt_payload, generate_recovery_key, random_master_key, unwrap_master_key, unwrap_sync_password, wrap_master_key, wrap_sync_password, SYNC_PASSWORD_KDF},
        types::WrappedMasterKey,
    },
    credentials::{delete_backup_credential, read_backup_credential, restore_backup_credential, sync_credential_generation},
    managed_keys::{install_sync_key, read_sync_key},
    protocol::{CommandError, CommandResult},
};

const SERVICE: &str = "com.fineshell.app.host-sync";
const MAX_RESPONSE: usize = 8 * 1024 * 1024 + 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    account_id: String,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Vault {
    version: u8,
    wrapped_key: WrappedMasterKey,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct RemoteVault {
    revision: u64,
    vault: Option<Vault>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    server: String,
    email: String,
    account_id: String,
    token: String,
    key: [u8; 32],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_key: Option<[u8; 32]>,
    wrapped_key: WrappedMasterKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    server: String,
    email: String,
    account_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceInfo {
    id: String,
    name: String,
    current: bool,
    last_sync_at: Option<u64>,
    expires_at: u64,
}

impl Device {
    fn account(&self) -> Account {
        Account {
            server: self.server.clone(),
            email: self.email.clone(),
            account_id: self.account_id.clone(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Record {
    metadata: Value,
    secret: Option<String>,
    private_key: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
struct Records {
    hosts: BTreeMap<String, Record>,
    keys: BTreeMap<String, Record>,
    proxies: BTreeMap<String, Record>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Configuration {
    hosts: Vec<Value>,
    keys: Vec<Value>,
    proxies: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    kind: &'static str,
    owner_id: String,
    exists: bool,
}

#[derive(Serialize)]
pub(crate) struct AppliedConfiguration {
    #[serde(flatten)]
    configuration: Configuration,
    credentials: Vec<CredentialStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncResult {
    base: Vault,
    inspection: Option<SyncInspection>,
    expected_local: Option<Vault>,
    conflict_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    conflicts: Vec<Conflict>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    blocked: Vec<BlockedRecord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncInspection {
    revision: u64,
    fingerprint: String,
    credential_generation: u64,
}

#[derive(Deserialize)]
struct VaultStatus {
    revision: u64,
    fingerprint: Option<String>,
}

fn inspection(vault: &Vault, revision: u64, credential_generation: u64) -> Result<SyncInspection, String> {
    let bytes = serde_json::to_vec(vault).map_err(|_| "无法编码同步仓库")?;
    Ok(SyncInspection {
        revision,
        fingerprint: format!("{:x}", Sha256::digest(bytes)),
        credential_generation,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockedRecord {
    kind: &'static str,
    id: String,
    name: String,
    preserve: bool,
    relink: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Conflict {
    id: String,
    local: Option<Value>,
    cloud: Option<Value>,
    credential_changed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resolution {
    snapshot: String,
    choices: BTreeMap<String, bool>,
}

fn error(operation: &'static str, message: impl Into<String>) -> CommandError {
    CommandError::from_message(operation, message.into())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "device").map_err(|e| format!("无法访问系统凭据库：{e}"))
}

fn load_device() -> Result<Option<Device>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "同步登录信息无效".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("无法读取同步登录信息：{e}")),
    }
}

fn require_device(account_id: &str) -> Result<Device, String> {
    load_device()?
        .filter(|device| device.account_id == account_id)
        .ok_or_else(|| "请先登录栈渡账号".to_string())
}

fn server_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "同步服务地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("请输入 HTTPS 同步服务地址，本机开发可用 HTTP".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

async fn request<T: DeserializeOwned>(
    server: &str,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<T, String> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    let client = CLIENT.get_or_init(|| Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()).as_ref().map_err(|_| "无法初始化同步客户端")?;
    let mut request = client.request(method, format!("{server}/v1/{path}"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request.send().await.map_err(|_| "同步服务连接失败")?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err("账号、密码或登录状态无效，请重新登录".into()),
        StatusCode::FORBIDDEN if matches!(path, "register" | "registration/verify") => {
            return Err("邀请码、邮箱或验证码无效，请核对后重试".into());
        }
        StatusCode::SERVICE_UNAVAILABLE if path == "registration/verify" => {
            return Err("邮件发送暂不可用，请稍后重试".into());
        }
        StatusCode::CONFLICT => return Err("资源发生冲突，请重试或检查账号是否已注册".into()),
        StatusCode::TOO_MANY_REQUESTS => return Err("请求过于频繁，请稍后再试".into()),
        status => return Err(format!("同步服务返回 HTTP {status}")),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取同步响应失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("同步数据超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "同步服务响应无效".into())
}

fn seal(device: &Device, revision: u64, records: &Records) -> Result<Vault, String> {
    // Bind the encrypted content to this protocol and account.
    let bytes = serde_json::to_vec(&("fineshell-host-sync-v1", &device.account_id, revision, records))
        .map_err(|_| "无法编码主机数据")?;
    let (nonce, ciphertext) = encrypt_payload(&device.key, &bytes)?;
    Ok(Vault {
        version: 1,
        wrapped_key: device.wrapped_key.clone(),
        nonce,
        ciphertext,
    })
}

fn open(device: &Device, vault: &Vault) -> Result<(u64, Records), String> {
    open_with_key(device, &device.key, vault)
}

fn open_local_base(device: &Device, vault: &Vault) -> Result<(u64, Records), String> {
    open(device, vault).or_else(|error| match &device.previous_key {
        Some(key) => open_with_key(device, key, vault),
        None => Err(error),
    })
}

fn open_with_key(device: &Device, key: &[u8; 32], vault: &Vault) -> Result<(u64, Records), String> {
    if vault.version != 1 {
        return Err("主机同步数据版本不受支持".into());
    }
    let bytes = decrypt_payload(key, &vault.nonce, &vault.ciphertext)
        .map_err(|_| "无法解密同步数据，请重新登录并检查恢复密钥")?;
    let (format, account, revision, records): (String, String, u64, Records) =
        serde_json::from_slice(&bytes).map_err(|_| "主机同步数据无效")?;
    if format != "fineshell-host-sync-v1" || account != device.account_id {
        return Err("同步数据账号不匹配".into());
    }
    Ok((revision, records))
}

fn conflict_snapshot_data(
    device: &Device, vault: &Vault, local: &Records, base: &Records,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&("fineshell-host-sync-conflict-v1", &device.account_id, vault, local, base))
        .map_err(|_| "无法记录同步冲突".to_string())
}

fn conflict_snapshot(
    device: &Device, vault: &Vault, local: &Records, base: &Records,
) -> Result<String, String> {
    let bytes = conflict_snapshot_data(device, vault, local, base)?;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let cipher = XChaCha20Poly1305::new((&device.key).into());
    let tag = cipher.encrypt(&nonce, Payload { msg: &[], aad: &bytes })
        .map_err(|_| "无法验证同步冲突")?;
    Ok(URL_SAFE_NO_PAD.encode([&nonce[..], &tag].concat()))
}

fn verifies_conflict(
    device: &Device, vault: &Vault, local: &Records, base: &Records, snapshot: &str,
) -> Result<bool, String> {
    if snapshot.len() != 54 {
        return Ok(false);
    }
    let token = match URL_SAFE_NO_PAD.decode(snapshot) {
        Ok(token) if token.len() == 40 => token,
        _ => return Ok(false),
    };
    let (nonce, tag) = token.split_at(24);
    let bytes = conflict_snapshot_data(device, vault, local, base)?;
    let cipher = XChaCha20Poly1305::new((&device.key).into());
    Ok(cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: tag, aad: &bytes }).is_ok())
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value[name]
        .as_str()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| format!("同步记录缺少字段 {name}"))
}

fn insert_records(
    values: Vec<Value>,
    mut build: impl FnMut(Value, &str) -> Result<Record, String>,
) -> Result<BTreeMap<String, Record>, String> {
    values.into_iter().map(|value| {
        let id = field(&value, "id")?.to_string();
        let record = build(value, &id)?;
        Ok((id, record))
    }).collect()
}

fn portable_key(metadata: &mut Value) -> Result<String, String> {
    let key = read_sync_key(field(metadata, "privateKeyPath")?)?;
    metadata.as_object_mut().ok_or("SSH 密钥配置无效")?.remove("privateKeyPath");
    Ok(key)
}

fn capture(configuration: Configuration, blocked: &mut Vec<BlockedRecord>) -> Result<Records, String> {
    let mut read_key = |kind, id: &str, value: &mut Value| {
        let key = portable_key(value).ok();
        if key.is_none() {
            value.as_object_mut().unwrap().remove("privateKeyPath");
            blocked.push(BlockedRecord {
                kind,
                id: id.to_string(),
                name: value["name"].as_str().unwrap_or(id).to_string(),
                preserve: false,
                relink: true,
            });
        }
        key
    };
    let hosts = insert_records(configuration.hosts, |mut metadata, id| {
        let fields = metadata.as_object_mut().ok_or("主机配置无效")?;
        fields.remove("lastConnectedAt");
        fields.remove("hostFingerprint");
        let (secret, private_key) = match field(&metadata, "authMethod")? {
            "password" => (read_backup_credential("hostPassword", id)?, None),
            "privateKey" if metadata["sshKeyId"].is_null() => (
                read_backup_credential("privateKeyPassphrase", id)?,
                read_key("hosts", id, &mut metadata),
            ),
            "privateKey" | "agent" => (None, None),
            _ => return Err("不支持的 SSH 认证类型".into()),
        };
        Ok(Record { metadata, secret, private_key })
    })?;
    let keys = insert_records(configuration.keys, |mut metadata, id| {
        let private_key = read_key("keys", id, &mut metadata);
        metadata.as_object_mut().ok_or("SSH 密钥配置无效")?.remove("source");
        Ok(Record {
            metadata,
            secret: read_backup_credential("privateKeyPassphrase", id)?,
            private_key,
        })
    })?;
    let proxies = insert_records(configuration.proxies, |metadata, id| {
        Ok(Record {
            metadata,
            secret: read_backup_credential("proxyPassword", id)?,
            private_key: None,
        })
    })?;
    Ok(Records { hosts, keys, proxies })
}

fn prepare_capture(
    mut local: Records, base: &Records, cloud: &Records, blocked: &mut Vec<BlockedRecord>,
) -> Records {
    for issue in blocked.iter_mut() {
        let (records, previous, remote) = if issue.kind == "keys" {
            (&mut local.keys, &base.keys, &cloud.keys)
        } else {
            (&mut local.hosts, &base.hosts, &cloud.hosts)
        };
        if let Some(fallback) = previous.get(&issue.id).or_else(|| remote.get(&issue.id)) {
            issue.preserve = records.get(&issue.id).is_some_and(|record| {
                record.metadata != fallback.metadata || record.secret != fallback.secret
            });
            records.insert(issue.id.clone(), fallback.clone());
        } else {
            issue.preserve = true;
            records.remove(&issue.id);
        }
    }
    for _ in 0..local.hosts.len() {
        let missing: Vec<_> = local.hosts.iter().filter(|(_, host)| {
            host.metadata["sshKeyId"].as_str().is_some_and(|id| {
                !local.keys.contains_key(id) && !base.keys.contains_key(id) && !cloud.keys.contains_key(id)
            }) || host.metadata["jumpHostId"].as_str().is_some_and(|id| {
                !local.hosts.contains_key(id) && !base.hosts.contains_key(id) && !cloud.hosts.contains_key(id)
            })
        }).map(|(id, _)| id.clone()).collect();
        if missing.is_empty() {
            break;
        }
        for id in missing {
            let Some(host) = local.hosts.remove(&id) else { continue };
            let fallback = base.hosts.get(&id).or_else(|| cloud.hosts.get(&id));
            if let Some(issue) = blocked.iter_mut().find(|issue| issue.kind == "hosts" && issue.id == id) {
                issue.preserve = true;
            } else {
                blocked.push(BlockedRecord {
                    kind: "hosts",
                    name: host.metadata["name"].as_str().unwrap_or(&id).to_string(),
                    id: id.clone(),
                    preserve: true,
                    relink: false,
                });
            }
            if let Some(fallback) = fallback {
                local.hosts.insert(id, fallback.clone());
            }
        }
    }
    local
}

fn validate_links(records: &Records) -> Result<(), String> {
    for (id, host) in &records.hosts {
        if let Some(key_id) = host.metadata["sshKeyId"].as_str() {
            if !records.keys.contains_key(key_id) {
                return Err("同步后的主机缺少关联的 SSH 密钥".into());
            }
        }
        if let Some(proxy_id) = host.metadata["proxyId"].as_str() {
            if !records.proxies.contains_key(proxy_id) {
                return Err("同步后的主机缺少关联的代理".into());
            }
        }
        if let Some(jump_id) = host.metadata["jumpHostId"].as_str() {
            let jump = records.hosts.get(jump_id).ok_or("同步后的主机缺少关联的跳板机")?;
            if id == jump_id || !jump.metadata["jumpHostId"].is_null() {
                return Err("同步后的跳板机设置不支持多级引用".into());
            }
        }
    }
    Ok(())
}

fn merge_map(
    base: &BTreeMap<String, Record>,
    local: BTreeMap<String, Record>,
    cloud: &BTreeMap<String, Record>,
    kind: &str,
    choices: Option<&BTreeMap<String, bool>>,
    conflicts: &mut Vec<Conflict>,
) -> BTreeMap<String, Record> {
    let mut merged = BTreeMap::new();
    let ids: std::collections::BTreeSet<_> =
        base.keys().chain(local.keys()).chain(cloud.keys()).collect();
    for id in ids {
        let previous = base.get(id);
        let here = local.get(id);
        let there = cloud.get(id);
        let conflict_id = format!("{kind}/{id}");
        let resolved = if here == there || there == previous {
            here
        } else if here == previous {
            there
        } else if let Some(local_wins) = choices.and_then(|choices| choices.get(&conflict_id)).copied() {
            if local_wins { here } else { there }
        } else {
            conflicts.push(Conflict {
                id: conflict_id,
                local: here.map(|record| record.metadata.clone()),
                cloud: there.map(|record| record.metadata.clone()),
                credential_changed: here.and_then(|record| record.secret.as_ref())
                    != there.and_then(|record| record.secret.as_ref())
                    || here.and_then(|record| record.private_key.as_ref())
                        != there.and_then(|record| record.private_key.as_ref()),
            });
            continue;
        };
        if let Some(record) = resolved {
            merged.insert(id.clone(), record.clone());
        }
    }
    merged
}

fn put_secret(kind: &str, id: &str, secret: Option<&str>) -> Result<(), String> {
    if read_backup_credential(kind, id)?.as_deref() == secret {
        return Ok(());
    }
    match secret {
        Some(secret) => restore_backup_credential(kind, id, secret),
        None => delete_backup_credential(kind, id),
    }
}

fn install_key(
    key: &str,
    old: Option<&Value>,
    stable_id: Option<&str>,
) -> Result<String, String> {
    if let Some(path) = old.and_then(|value| value["privateKeyPath"].as_str()) {
        if read_sync_key(path).is_ok_and(|contents| contents == key) {
            return Ok(path.to_string());
        }
    }
    let id = stable_id.map(str::to_owned)
        .unwrap_or_else(|| format!("sync-{}", URL_SAFE_NO_PAD.encode(random_master_key())));
    install_sync_key(&id, key)
}

fn apply_records(
    mut records: Records, current: Configuration, preserve_hosts: &[String], preserve_keys: &[String],
) -> Result<AppliedConfiguration, String> {
    validate_links(&records)?;
    records.hosts.retain(|id, _| !preserve_hosts.contains(id));
    records.keys.retain(|id, _| !preserve_keys.contains(id));
    let old_hosts = current.hosts.iter().filter_map(|host| Some((host["id"].as_str()?, host))).collect::<BTreeMap<_, _>>();
    let old_keys = current.keys.iter().filter_map(|key| Some((key["id"].as_str()?, key))).collect::<BTreeMap<_, _>>();
    let mut result = Configuration { hosts: Vec::new(), keys: Vec::new(), proxies: Vec::new() };

    // Install key files before changing any keyring entries.
    let mut pending_secrets = Vec::new();
    for (id, mut record) in records.keys {
        let old = old_keys.get(id.as_str()).copied();
        if let Some(key) = &record.private_key {
            let path = install_key(key, old, Some(&id))?;
            record.metadata["source"] = json!(if path.starts_with("managed://") { "managed" } else { "file" });
            record.metadata["privateKeyPath"] = json!(path);
        }
        pending_secrets.push(("privateKeyPassphrase", id, record.secret));
        result.keys.push(record.metadata);
    }
    for (id, record) in records.proxies {
        pending_secrets.push(("proxyPassword", id, record.secret));
        result.proxies.push(record.metadata);
    }
    for (id, mut record) in records.hosts {
        let old = old_hosts.get(id.as_str()).copied();
        if let Some(key) = &record.private_key {
            record.metadata["privateKeyPath"] = json!(install_key(key, old, None)?);
            pending_secrets.push(("privateKeyPassphrase", id, record.secret));
        } else if record.metadata["authMethod"] == "password" {
            pending_secrets.push(("hostPassword", id, record.secret));
        }
        result.hosts.push(record.metadata);
    }
    let mut undo = Vec::new();
    let mut credentials = Vec::new();
    for (kind, id, secret) in pending_secrets {
        let outcome = (|| {
            let previous = read_backup_credential(kind, &id)?;
            put_secret(kind, &id, secret.as_deref())?;
            Ok::<_, String>(previous)
        })();
        match outcome {
            Ok(previous) => {
                credentials.push(CredentialStatus {
                    kind,
                    owner_id: id.clone(),
                    exists: secret.is_some(),
                });
                undo.push((kind, id, previous));
            }
            Err(failure) => {
                for (kind, id, previous) in undo.into_iter().rev() {
                    if put_secret(kind, &id, previous.as_deref()).is_err() {
                        return Err(format!("{failure}；部分系统凭据无法恢复，请重试同步"));
                    }
                }
                return Err(failure);
            }
        }
    }
    Ok(AppliedConfiguration { configuration: result, credentials })
}

#[tauri::command]
pub(crate) fn host_sync_recovery_key() -> String {
    generate_recovery_key()
}

#[tauri::command]
pub(crate) fn host_sync_account() -> CommandResult<Option<Account>> {
    load_device().map(|device| device.map(|device| device.account()))
        .map_err(|e| error("host_sync_account", e))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistrationProof {
    invite_code: String,
    verification_code: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerificationRequest {
    email: String,
    invite_code: String,
}

#[tauri::command]
pub(crate) async fn host_sync_registration(
    server: String,
    verification: Option<VerificationRequest>,
) -> CommandResult<Value> {
    let result = async {
        let server = server_url(&server)?;
        if let Some(verification) = verification {
            request(&server, Method::POST, "registration/verify", None, Some(json!(verification))).await
        } else {
            match request(&server, Method::GET, "registration", None, None).await {
                Err(message) if message.starts_with("同步服务返回 HTTP 404") => Ok(json!({ "mode": "open" })),
                result => result,
            }
        }
    }.await;
    result.map_err(|e| error("host_sync_registration", e))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn host_sync_login(
    server: String, email: String, password: String, recovery_key: String, register: bool,
    bound_account: Option<String>, device_name: Option<String>, proof: Option<RegistrationProof>,
    use_master_password: Option<bool>, registration_id: Option<String>,
) -> CommandResult<Account> {
    let result = async {
        let server = server_url(&server)?;
        let email = email.trim().to_ascii_lowercase();
        if password == recovery_key {
            return Err("账号密码与主密码或恢复密钥必须不同".into());
        }
        let normalized: String = recovery_key.chars().filter(|ch| *ch != '-' && !ch.is_ascii_whitespace()).collect();
        let master_password = use_master_password == Some(true);
        if register && !master_password && !legacy_recovery_key(&normalized) {
            return Err("请输入完整的 64 位十六进制恢复密钥".into());
        }
        if register && bound_account.is_some() {
            return Err("此栈渡配置已绑定同步账号".into());
        }
        let path = if register { "register" } else { "login" };
        let mut body = json!({ "email": email, "password": password, "deviceName": device_name });
        if let Some(proof) = proof.filter(|_| register) {
            body["inviteCode"] = json!(proof.invite_code);
            body["verificationCode"] = json!(proof.verification_code);
        }
        if register {
            // The original recovery key makes retries after a lost response identify the same account.
            let account_id = if master_password {
                registration_id.filter(|id| id.len() == 32 &&
                    id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
                    .ok_or("无法创建同步账号标识")?
            } else {
                let identity = serde_json::to_vec(&("fineshell-sync-registration-v1",
                    &server, &email, normalized.to_ascii_lowercase()))
                    .map_err(|_| "无法创建同步账号标识")?;
                format!("{:x}", Sha256::digest(identity))[..32].to_owned()
            };
            let key = random_master_key();
            let wrapped_key = if master_password {
                wrap_sync_password(&key, &recovery_key)?
            } else {
                wrap_master_key(&key, &recovery_key, true)?
            };
            let initial = Device {
                server: server.clone(), email: email.clone(), account_id: account_id.clone(),
                token: String::new(), key, previous_key: None, wrapped_key,
            };
            body["accountId"] = json!(account_id);
            body["vault"] = json!(seal(&initial, 1, &Records::default())?);
        }
        let login: Login = request(&server, Method::POST, path, None, Some(body)).await?;
        let finished = complete_login(&server, email, &login, &recovery_key, bound_account).await;
        if finished.is_err() {
            let _ = request::<Value>(&server, Method::POST, "logout", Some(&login.token), None).await;
        }
        finished
    }.await;
    result.map_err(|e: String| error("host_sync_login", e))
}

fn legacy_recovery_key(normalized: &str) -> bool {
    normalized.len() == 64 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unlock_sync_key(wrapped: &WrappedMasterKey, secret: &str) -> Result<[u8; 32], String> {
    if wrapped.algorithm != "XChaCha20-Poly1305" {
        return Err("同步仓库版本不受支持".into());
    }
    match wrapped.kdf.as_str() {
        "Argon2id" => {
            let normalized: String = secret.chars().filter(|ch| *ch != '-' && !ch.is_ascii_whitespace()).collect();
            if !legacy_recovery_key(&normalized) {
                return Err("该账号需要完整的旧恢复密钥".into());
            }
            unwrap_master_key(wrapped, secret, true).map_err(|_| "恢复密钥不正确".into())
        }
        SYNC_PASSWORD_KDF => unwrap_sync_password(wrapped, secret).map_err(|_| "主密码不正确".into()),
        _ => Err("同步仓库版本不受支持".into()),
    }
}

async fn complete_login(
    server: &str, email: String, login: &Login, recovery_key: &str, bound_account: Option<String>,
) -> Result<Account, String> {
    if bound_account.as_ref().is_some_and(|id| id != &login.account_id) {
        return Err("此栈渡配置已绑定另一个同步账号".into());
    }
    let remote: RemoteVault = request(server, Method::GET, "vault", Some(&login.token), None).await?;
    let (key, wrapped_key) = if let Some(vault) = &remote.vault {
        if vault.version != 1 {
            return Err("同步仓库版本不受支持".into());
        }
        let key = unlock_sync_key(&vault.wrapped_key, recovery_key)?;
        (key, vault.wrapped_key.clone())
    } else {
        if bound_account.is_some() {
            return Err("已绑定账号的同步仓库不存在，请检查同步服务".into());
        }
        let normalized: String = recovery_key.chars().filter(|ch| *ch != '-' && !ch.is_ascii_whitespace()).collect();
        if !legacy_recovery_key(&normalized) {
            return Err("首次初始化旧同步仓库需要旧恢复密钥".into());
        }
        let key = random_master_key();
        let wrapped = wrap_master_key(&key, recovery_key, true)?;
        (key, wrapped)
    };
    let previous_key = load_device().ok().flatten()
        .filter(|device| device.server == server && device.account_id == login.account_id)
        .and_then(|device| if device.key == key { device.previous_key } else { Some(device.key) });
    let device = Device {
        server: server.to_owned(), email, account_id: login.account_id.clone(), token: login.token.clone(),
        key, previous_key, wrapped_key,
    };
    // Establish the recovery key before another device can initialize the same account.
    if let Some(vault) = &remote.vault {
        if open(&device, vault)?.0 != remote.revision {
            return Err("云端同步版本异常".into());
        }
    } else if remote.revision == 0 {
        let vault = seal(&device, 1, &Records::default())?;
        request::<Value>(&device.server, Method::PUT, "vault", Some(&device.token), Some(json!({ "revision": 0, "vault": vault }))).await?;
    } else {
        return Err("云端同步仓库数据不完整".into());
    }
    let encoded = serde_json::to_string(&device).map_err(|_| "无法保存同步登录信息")?;
    entry()?.set_password(&encoded).map_err(|_| "无法保存同步登录信息到系统凭据库")?;
    Ok(device.account())
}

#[tauri::command]
pub(crate) async fn host_sync_logout() -> CommandResult<()> {
    let result = async {
        if let Some(device) = load_device()? {
            // Clear device credentials even when the service is offline.
            entry()?.delete_credential().map_err(|_| "无法清除同步登录信息")?;
            let _ = request::<Value>(&device.server, Method::POST, "logout", Some(&device.token), None).await;
        }
        Ok(())
    }.await;
    result.map_err(|e: String| error("host_sync_logout", e))
}

#[tauri::command]
pub(crate) async fn host_sync_devices(
    account_id: String,
    revoke: Option<String>,
    mark_synced: Option<bool>,
    rename: Option<String>,
) -> CommandResult<Vec<DeviceInfo>> {
    let result = async {
        let device = require_device(&account_id)?;
        if mark_synced == Some(true) {
            request::<Value>(&device.server, Method::POST, "devices/synced", Some(&device.token), None).await?;
            return Ok(Vec::new());
        }
        if let Some(name) = rename {
            request::<Value>(&device.server, Method::POST, "devices/name", Some(&device.token),
                Some(json!({ "name": name }))).await?;
        }
        if let Some(id) = revoke {
            if id.len() != 32 || !id.bytes().all(|ch| ch.is_ascii_hexdigit()) {
                return Err("设备标识无效".into());
            }
            request::<Value>(&device.server, Method::DELETE, &format!("devices/{id}"), Some(&device.token), None).await?;
        }
        request(&device.server, Method::GET, "devices", Some(&device.token), None).await
    }.await;
    result.map_err(|e: String| error("host_sync_devices", e))
}

#[tauri::command]
pub(crate) async fn host_sync_probe(
    account_id: String,
    known: SyncInspection,
) -> CommandResult<Option<bool>> {
    let result = async {
        if known.credential_generation != sync_credential_generation() {
            return Ok(Some(false));
        }
        let device = require_device(&account_id)?;
        let status: VaultStatus = match request(&device.server, Method::GET, "vault/status", Some(&device.token), None).await {
            Err(message) if message.starts_with("同步服务返回 HTTP 404") => return Ok(None),
            result => result?,
        };
        Ok(Some(status.revision == known.revision
            && status.fingerprint.as_deref() == Some(known.fingerprint.as_str())
            && known.credential_generation == sync_credential_generation()))
    }.await;
    result.map_err(|e: String| error("host_sync_probe", e))
}

#[tauri::command]
pub(crate) async fn host_sync_rotate_key(
    account_id: String, base: Vault, recovery_key: String, account_password: Option<String>,
) -> CommandResult<Vault> {
    let result = async {
        let mut device = require_device(&account_id)?;
        let RemoteVault { revision, vault } =
            request(&device.server, Method::GET, "vault", Some(&device.token), None).await?;
        let vault = vault.ok_or("同步账号尚未初始化")?;
        let (signed_revision, records) = open(&device, &vault)?;
        let (base_revision, base_records) = open(&device, &base)?;
        if signed_revision != revision || base_revision != revision || base_records != records {
            return Err("请先完成一次同步，再更换主密码".into());
        }
        if unlock_sync_key(&vault.wrapped_key, &recovery_key).is_ok() {
            return Err("请使用不同的主密码".into());
        }
        let next = revision.checked_add(1).ok_or("同步版本超出范围")?;
        let key = random_master_key();
        device.wrapped_key = if let Some(password) = account_password {
            if password == recovery_key {
                return Err("账号密码和主密码必须不同".into());
            }
            let wrapped = wrap_sync_password(&key, &recovery_key)?;
            let check: Login = request(&device.server, Method::POST, "login", None,
                Some(json!({ "email": device.email, "password": password }))).await?;
            let _: Value = request(&device.server, Method::POST, "logout", Some(&check.token), None).await?;
            if check.account_id != device.account_id {
                return Err("当前账号无法验证".into());
            }
            wrapped
        } else {
            let normalized: String = recovery_key.chars().filter(|ch| *ch != '-' && !ch.is_ascii_whitespace()).collect();
            if !legacy_recovery_key(&normalized) || vault.wrapped_key.kdf != "Argon2id" {
                return Err("请更新客户端并使用主密码".into());
            }
            wrap_master_key(&key, &recovery_key, true)?
        };
        device.previous_key = Some(device.key);
        device.key = key;
        let replacement = seal(&device, next, &records)?;

        #[derive(Deserialize)]
        struct Rotation {
            revision: u64,
            token: String,
        }
        let rotated: Rotation = request(&device.server, Method::POST, "vault/rotate-key",
            Some(&device.token), Some(json!({ "revision": revision, "vault": replacement }))).await?;
        if rotated.revision != next || rotated.token.is_empty() {
            return Err("无法确认密钥更换，请使用新主密码或恢复密钥重新登录".into());
        }
        device.token = rotated.token;
        let encoded = serde_json::to_string(&device).map_err(|_| "无法保存同步登录信息")?;
        entry()?.set_password(&encoded)
            .map_err(|_| "无法保存同步登录信息，请使用新主密码或恢复密钥重新登录")?;
        Ok(replacement)
    }.await;
    result.map_err(|e: String| error("host_sync_rotate_key", e))
}

#[tauri::command]
pub(crate) async fn host_sync_exchange(
    account_id: String, configuration: Configuration, base: Option<Vault>, resolution: Option<Resolution>,
    recover: Option<bool>,
) -> CommandResult<SyncResult> {
    let result = async {
        let device = require_device(&account_id)?;
        let mut blocked = Vec::new();
        let generation = sync_credential_generation();
        let raw_local = capture(configuration, &mut blocked)?;
        let RemoteVault { revision, vault } =
            request(&device.server, Method::GET, "vault", Some(&device.token), None).await?;
        let vault = vault.ok_or("同步账号尚未初始化")?;
        let (signed_revision, cloud) = open(&device, &vault)?;
        let (previous_revision, previous) = base.as_ref().map(|vault| open_local_base(&device, vault))
            .transpose()?.unwrap_or_default();
        if signed_revision != revision || (revision == previous_revision && previous != cloud) {
            return Err("云端同步版本异常，请检查同步服务的数据".into());
        }
        if revision < previous_revision {
            if recover != Some(true) {
                return Err("云端快照落后于本机已验证版本，请在设置中确认恢复".into());
            }
            let next = previous_revision.checked_add(1).ok_or("同步版本超出范围")?;
            let repaired = seal(&device, next, &previous)?;
            request::<Value>(&device.server, Method::POST, "vault/recover", Some(&device.token), Some(json!({
                "revision": revision, "nextRevision": next, "vault": repaired,
            }))).await?;
            return Ok(SyncResult { base: repaired, inspection: None, expected_local: None, conflict_snapshot: None, conflicts: Vec::new(), blocked });
        }
        if recover == Some(true) {
            return Err("云端版本已更新，请重新同步".into());
        }
        let choices = if let Some(resolution) = &resolution {
            verifies_conflict(&device, &vault, &raw_local, &previous, &resolution.snapshot)?
                .then_some(&resolution.choices)
        } else {
            None
        };
        let local = prepare_capture(raw_local.clone(), &previous, &cloud, &mut blocked);
        let unavailable_keys: std::collections::BTreeSet<_> = blocked.iter()
            .filter(|issue| issue.kind == "keys")
            .map(|issue| issue.id.clone()).collect();
        for (id, host) in &raw_local.hosts {
            if host.metadata["sshKeyId"].as_str().is_some_and(|key| unavailable_keys.contains(key))
                && !blocked.iter().any(|issue| issue.kind == "hosts" && issue.id == *id)
            {
                blocked.push(BlockedRecord {
                    kind: "hosts", id: id.clone(),
                    name: host.metadata["name"].as_str().unwrap_or(id).to_string(),
                    preserve: false, relink: false,
                });
            }
        }
        let Records { hosts, keys, proxies } = local;
        let mut conflicts = Vec::new();
        let combined = Records {
            hosts: merge_map(&previous.hosts, hosts, &cloud.hosts, "hosts", choices, &mut conflicts),
            keys: merge_map(&previous.keys, keys, &cloud.keys, "keys", choices, &mut conflicts),
            proxies: merge_map(&previous.proxies, proxies, &cloud.proxies, "proxies", choices, &mut conflicts),
        };
        if !conflicts.is_empty() {
            return Ok(SyncResult {
                conflict_snapshot: Some(conflict_snapshot(&device, &vault, &raw_local, &previous)?),
                base: vault, inspection: None, expected_local: None, conflicts, blocked,
            });
        }
        validate_links(&combined)?;
        let repairable = blocked.iter().any(|issue| issue.relink && !issue.preserve && {
            let records = if issue.kind == "keys" { &combined.keys } else { &combined.hosts };
            records.get(&issue.id).is_some_and(|record| record.private_key.is_some())
        });
        let expected_local = (previous != cloud || repairable)
            .then(|| seal(&device, revision, &raw_local)).transpose()?;
        let (base, current_revision) = if combined == cloud {
            (vault, revision)
        } else {
            let next = revision.checked_add(1).ok_or("同步版本超出范围")?;
            let vault = seal(&device, next, &combined)?;
            request::<Value>(&device.server, Method::PUT, "vault", Some(&device.token), Some(json!({ "revision": revision, "vault": vault }))).await?;
            (vault, next)
        };
        let inspection = inspection(&base, current_revision, generation)?;
        Ok(SyncResult { base, inspection: Some(inspection), expected_local, conflict_snapshot: None, conflicts, blocked })
    }.await;
    result.map_err(|e: String| error("host_sync_exchange", e))
}

#[tauri::command]
pub(crate) fn host_sync_apply(
    account_id: String, vault: Vault, expected_local: Vault, configuration: Configuration,
    preserve_hosts: Vec<String>, preserve_keys: Vec<String>,
) -> CommandResult<AppliedConfiguration> {
    (|| {
        let device = require_device(&account_id)?;
        let (_, records) = open(&device, &vault)?;
        if open(&device, &expected_local)?.1 != capture(Configuration {
            hosts: configuration.hosts.clone(),
            keys: configuration.keys.clone(),
            proxies: configuration.proxies.clone(),
        }, &mut Vec::new())? {
            return Err("本机 SSH 凭据刚发生变化，将在下一次同步时重试".into());
        }
        apply_records(records, configuration, &preserve_hosts, &preserve_keys)
    })().map_err(|e| error("host_sync_apply", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> (String, Record) {
        ("host".into(), Record {
            metadata: json!({ "id": "host", "name": name }),
            secret: None,
            private_key: None,
        })
    }

    #[test]
    fn merges_remote_delete_and_detects_concurrent_edits() {
        let base = BTreeMap::from([host("original")]);
        let cloud = BTreeMap::new();
        let mut conflicts = Vec::new();
        let removed = merge_map(&base, BTreeMap::from([host("original")]), &cloud, "hosts", None, &mut conflicts);
        assert!(removed.is_empty());
        assert!(conflicts.is_empty());
        merge_map(&base, BTreeMap::from([host("edited")]), &cloud, "hosts", None, &mut conflicts);
        assert_eq!(conflicts[0].id, "hosts/host");
        let choices = BTreeMap::from([("hosts/host".into(), true)]);
        conflicts.clear();
        let kept = merge_map(&base, BTreeMap::from([host("edited")]), &cloud, "hosts", Some(&choices), &mut conflicts);
        assert_eq!(kept["host"].metadata["name"], "edited");
        assert!(conflicts.is_empty());
    }

    #[test]
    fn resolves_conflicts_per_record() {
        let version = |name: &str| {
            let (_, mut other) = host(name);
            other.metadata["id"] = json!("another");
            BTreeMap::from([host(name), ("another".into(), other)])
        };
        let choices = BTreeMap::from([("hosts/host".into(), true), ("hosts/another".into(), false)]);
        let mut conflicts = Vec::new();
        let result = merge_map(
            &version("base"), version("local"), &version("cloud"), "hosts",
            Some(&choices), &mut conflicts,
        );
        assert!(conflicts.is_empty());
        assert_eq!(result["host"].metadata["name"], "local");
        assert_eq!(result["another"].metadata["name"], "cloud");
    }

    #[test]
    fn missing_keys_defer_only_records_that_need_them() {
        let (_, mut blocked_host) = host("blocked");
        blocked_host.metadata["sshKeyId"] = json!("missing");
        let broken_key = Record {
            metadata: json!({"id": "missing", "name": "Missing key"}),
            secret: None,
            private_key: None,
        };
        let local = Records {
            hosts: BTreeMap::from([host("healthy"), ("blocked".into(), blocked_host)]),
            keys: BTreeMap::from([("missing".into(), broken_key)]),
            ..Records::default()
        };
        let empty = Records::default();
        let mut blocked = vec![BlockedRecord {
            kind: "keys",
            id: "missing".into(),
            name: "Missing key".into(),
            preserve: false,
            relink: true,
        }];
        let prepared = prepare_capture(local, &empty, &empty, &mut blocked);
        assert_eq!(prepared.hosts.len(), 1);
        assert!(prepared.hosts.contains_key("host"));
        assert!(prepared.keys.is_empty());
        assert_eq!(blocked.len(), 2);
        assert!(blocked.iter().all(|record| record.preserve));
    }

    #[test]
    fn vault_binds_revision_and_account() {
        let recovery = generate_recovery_key();
        let key = random_master_key();
        let mut device = Device {
            server: "http://localhost".into(),
            email: "test@example.com".into(),
            account_id: "first".into(),
            token: String::new(),
            key,
            previous_key: None,
            wrapped_key: wrap_master_key(&key, &recovery, true).unwrap(),
        };
        let empty = Records::default();
        let vault = seal(&device, 17, &empty).unwrap();
        let snapshot = conflict_snapshot(&device, &vault, &empty, &empty).unwrap();
        assert!(verifies_conflict(&device, &vault, &empty, &empty, &snapshot).unwrap());
        let advanced = seal(&device, 18, &empty).unwrap();
        assert!(!verifies_conflict(&device, &advanced, &empty, &empty, &snapshot).unwrap());
        assert_eq!(open(&device, &vault).unwrap().0, 17);
        device.previous_key = Some(device.key);
        device.key = random_master_key();
        assert!(open(&device, &vault).is_err());
        assert_eq!(open_local_base(&device, &vault).unwrap().0, 17);
        device.account_id = "second".into();
        assert!(open_local_base(&device, &vault).is_err());
    }
}
