use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};

use super::types::WrappedMasterKey;

const MASTER_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

pub(crate) fn random_master_key() -> [u8; MASTER_KEY_LEN] {
    let mut key = [0_u8; MASTER_KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

pub(crate) fn generate_recovery_key() -> String {
    let mut bytes = [0_u8; MASTER_KEY_LEN];
    OsRng.fill_bytes(&mut bytes);
    let raw = bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    raw.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_secret(secret: &str, recovery_key: bool) -> String {
    if recovery_key {
        secret
            .chars()
            .filter(|character| !character.is_ascii_whitespace() && *character != '-')
            .collect::<String>()
            .to_ascii_uppercase()
    } else {
        secret.to_string()
    }
}

fn derive_key(argon: Argon2<'_>, secret: &str, salt: &[u8]) -> Result<[u8; MASTER_KEY_LEN], String> {
    let mut key = [0_u8; MASTER_KEY_LEN];
    argon
        .hash_password_into(secret.as_bytes(), salt, &mut key)
        .map_err(|error| format!("生成备份加密密钥失败：{error}"))?;
    Ok(key)
}

pub(crate) fn wrap_master_key(
    master_key: &[u8; MASTER_KEY_LEN],
    secret: &str,
    recovery_key: bool,
) -> Result<WrappedMasterKey, String> {
    let normalized = normalize_secret(secret, recovery_key);
    if normalized.len() < 8 {
        return Err(if recovery_key {
            "恢复密钥格式无效".to_string()
        } else {
            "备份密码至少需要 8 个字符".to_string()
        });
    }
    wrap_with_argon2(master_key, &normalized, "Argon2id", Argon2::default())
}

pub(crate) const SYNC_PASSWORD_KDF: &str = "Argon2id-sync-password-v1";

fn sync_password_argon2() -> Argon2<'static> {
    let params = Params::new(65_536, 3, 4, Some(MASTER_KEY_LEN))
        .expect("fixed sync master password parameters");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub(crate) fn wrap_sync_password(master_key: &[u8; MASTER_KEY_LEN], password: &str) -> Result<WrappedMasterKey, String> {
    if password.trim().chars().count() < 16 || password.len() > 1024 {
        return Err("主密码至少需要 16 个字符，最多 1024 字节".into());
    }
    wrap_with_argon2(master_key, password, SYNC_PASSWORD_KDF, sync_password_argon2())
}

pub(crate) fn unwrap_sync_password(wrapped: &WrappedMasterKey, password: &str) -> Result<[u8; MASTER_KEY_LEN], String> {
    if wrapped.kdf != SYNC_PASSWORD_KDF || password.len() > 1024 || password.is_empty() {
        return Err("主密码或加密格式无效".into());
    }
    unwrap_with_argon2(wrapped, password, sync_password_argon2())
}

fn wrap_with_argon2(
    master_key: &[u8; MASTER_KEY_LEN], secret: &str, kdf: &str, argon: Argon2<'_>,
) -> Result<WrappedMasterKey, String> {
    let mut salt = [0_u8; SALT_LEN];
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let wrap_key = derive_key(argon, secret, &salt)?;
    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), master_key.as_slice())
        .map_err(|_| "加密备份主密钥失败".to_string())?;
    Ok(WrappedMasterKey {
        algorithm: "XChaCha20-Poly1305".to_string(),
        kdf: kdf.to_string(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

pub(crate) fn unwrap_master_key(
    wrapped: &WrappedMasterKey,
    secret: &str,
    recovery_key: bool,
) -> Result<[u8; MASTER_KEY_LEN], String> {
    let normalized = normalize_secret(secret, recovery_key);
    unwrap_with_argon2(wrapped, &normalized, Argon2::default())
}

fn unwrap_with_argon2(
    wrapped: &WrappedMasterKey, secret: &str, argon: Argon2<'_>,
) -> Result<[u8; MASTER_KEY_LEN], String> {
    let salt = STANDARD
        .decode(&wrapped.salt)
        .map_err(|_| "云端仓库的密钥盐值无效".to_string())?;
    let nonce = STANDARD
        .decode(&wrapped.nonce)
        .map_err(|_| "云端仓库的密钥随机数无效".to_string())?;
    let ciphertext = STANDARD
        .decode(&wrapped.ciphertext)
        .map_err(|_| "云端仓库的加密主密钥无效".to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("云端仓库的密钥随机数长度无效".to_string());
    }
    let wrap_key = derive_key(argon, secret, &salt)?;
    let cipher = XChaCha20Poly1305::new((&wrap_key).into());
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "备份密码或恢复密钥不正确".to_string())?;
    plaintext
        .try_into()
        .map_err(|_| "云端仓库的主密钥长度无效".to_string())
}

pub(crate) fn encrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    plaintext: &[u8],
) -> Result<(String, String), String> {
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(master_key.into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| "加密云备份失败".to_string())?;
    Ok((STANDARD.encode(nonce), STANDARD.encode(ciphertext)))
}

pub(crate) fn decrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    nonce: &str,
    ciphertext: &str,
) -> Result<Vec<u8>, String> {
    let nonce = STANDARD
        .decode(nonce)
        .map_err(|_| "备份随机数无效".to_string())?;
    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|_| "备份密文无效".to_string())?;
    if nonce.len() != NONCE_LEN {
        return Err("备份随机数长度无效".to_string());
    }
    XChaCha20Poly1305::new(master_key.into())
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "云备份解密失败，请重新解锁仓库".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        decrypt_payload, encrypt_payload, generate_recovery_key, random_master_key,
        unwrap_master_key, unwrap_sync_password, wrap_master_key, wrap_sync_password, SYNC_PASSWORD_KDF,
    };

    #[test]
    fn wraps_and_unwraps_master_key_with_password() {
        let master = random_master_key();
        let wrapped = wrap_master_key(&master, "a-strong-password", false).unwrap();
        assert_eq!(
            unwrap_master_key(&wrapped, "a-strong-password", false).unwrap(),
            master
        );
        assert!(unwrap_master_key(&wrapped, "wrong-password", false).is_err());
    }

    #[test]
    fn sync_password_preserves_case_and_spacing_and_has_a_distinct_kdf() {
        let master = random_master_key();
        let password = "  坚果 Harbor Beacon 17  ";
        let wrapped = wrap_sync_password(&master, password).unwrap();
        assert_eq!(wrapped.kdf, SYNC_PASSWORD_KDF);
        assert_eq!(unwrap_sync_password(&wrapped, password).unwrap(), master);
        assert!(unwrap_sync_password(&wrapped, password.trim()).is_err());
        assert!(wrap_sync_password(&master, "too short").is_err());
    }

    #[test]
    fn recovery_key_is_human_grouped_and_normalized() {
        let master = random_master_key();
        let recovery_key = generate_recovery_key();
        let wrapped = wrap_master_key(&master, &recovery_key, true).unwrap();
        assert_eq!(
            unwrap_master_key(&wrapped, &recovery_key.to_ascii_lowercase(), true).unwrap(),
            master
        );
    }

    #[test]
    fn encrypts_and_decrypts_snapshot_payload() {
        let master = random_master_key();
        let (nonce, encrypted) = encrypt_payload(&master, b"configuration").unwrap();
        assert_eq!(
            decrypt_payload(&master, &nonce, &encrypted).unwrap(),
            b"configuration"
        );
    }
}
