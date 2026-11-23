use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const HEADER_BYTES: u64 = 256;
const DATA_START: u64 = HEADER_BYTES + 256 * 256 * 8;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const SOURCE: &str = "https://api.github.com/repos/lionsoul2014/ip2region/contents/data";
const REVISION: &str = "cba49ef11b4051bc25334a3c5712715d636de90d";
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Serialize)]
pub(crate) struct RegionStatus {
    ipv4: bool,
    ipv6: bool,
}

fn database_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("ip-region"))
        .map_err(|error| error.to_string())
}

fn database_name(ipv6: bool) -> &'static str {
    if ipv6 {
        "ip2region_v6.xdb"
    } else {
        "ip2region_v4.xdb"
    }
}

fn status(dir: &Path) -> RegionStatus {
    RegionStatus {
        ipv4: dir.join(database_name(false)).is_file(),
        ipv6: dir.join(database_name(true)).is_file(),
    }
}

#[tauri::command]
pub(crate) async fn ip_region_status(app: AppHandle) -> Result<RegionStatus, String> {
    Ok(status(&database_dir(&app)?))
}

#[tauri::command]
pub(crate) async fn ip_region_update(
    app: AppHandle,
    ipv6: bool,
    remove: bool,
    import_path: Option<PathBuf>,
) -> Result<RegionStatus, String> {
    let dir = database_dir(&app)?;
    let name = database_name(ipv6);
    let path = dir.join(name);
    let _guard = INSTALL_LOCK.lock().await;
    if remove {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法删除 IP 归属地数据：{error}")),
        }
        return Ok(status(&dir));
    }
    if path.is_file() {
        return Ok(status(&dir));
    }

    let bytes = if let Some(source) = import_path {
        tauri::async_runtime::spawn_blocking(move || read_local_database(&source))
            .await
            .map_err(|error| error.to_string())??
    } else {
        download_database(name, ipv6).await?
    };
    validate_header(&bytes, bytes.len() as u64, ipv6)
        .ok_or("IP 归属地数据库格式无效、地址类型不符或文件不完整")?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let pending = dir.join(format!("{name}.partial"));
    let result = fs::write(&pending, &bytes).and_then(|_| fs::rename(&pending, &path));
    if let Err(error) = result {
        let _ = fs::remove_file(&pending);
        return Err(format!("保存 IP 归属地数据库失败：{error}"));
    }
    Ok(status(&dir))
}

fn read_local_database(source: &Path) -> Result<Vec<u8>, String> {
    if source.extension().and_then(|value| value.to_str()) != Some("xdb") || !source.is_file() {
        return Err("请选择 ip2region 的 .xdb 文件".into());
    }
    let file = File::open(source).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 IP 归属地数据库：{error}"))?;
    Ok(bytes)
}

async fn download_database(name: &str, ipv6: bool) -> Result<Vec<u8>, String> {
    let expected_hash = if ipv6 {
        "1f0be1ffbbc3e4eeef10f354e01355f22f57ec649a496a17fd602539f3d384c1"
    } else {
        "4ed5d3398f0a72346a6cec780c57601bb6977fa4f29e9682cd60a66e3478c542"
    };
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(12))
        .read_timeout(Duration::from_secs(45))
        .timeout(Duration::from_secs(1200))
        .user_agent(concat!("ZhanDu/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(format!("{SOURCE}/{name}?ref={REVISION}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github.raw+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("下载 IP 归属地数据失败：{error}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("IP 归属地数据库超出支持的大小".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
        return Err("IP 归属地数据库校验失败，请重新下载".into());
    }
    Ok(bytes)
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn read_pointer(bytes: &[u8]) -> u64 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u64
}

// ip2region XDB uses a two-byte address prefix to locate a sorted range of segments.
fn validate_header(header: &[u8], len: u64, ipv6: bool) -> Option<(u64, u64)> {
    if header.len() < 20 || len <= DATA_START || len > MAX_BYTES as u64 {
        return None;
    }
    let expected_family = if ipv6 { 6 } else { 4 };
    let version = read_u16(header);
    let supported = (version == 2 && !ipv6)
        || (version == 3
            && read_u16(&header[16..]) == expected_family
            && read_u16(&header[18..]) == 4);
    let first = read_pointer(&header[8..]);
    let last = read_pointer(&header[12..]);
    let stride = if ipv6 { 38 } else { 14 };
    (supported
        && read_u16(&header[2..]) == 1
        && first >= DATA_START
        && last >= first
        && (last - first).is_multiple_of(stride)
        && last + stride <= len)
        .then_some((first, last))
}

struct Database {
    file: File,
    first: u64,
    last: u64,
}

impl Database {
    fn open(path: &Path, ipv6: bool) -> Option<Self> {
        let mut file = File::open(path).ok()?;
        let mut header = [0; 20];
        file.read_exact(&mut header).ok()?;
        let (first, last) = validate_header(&header, file.metadata().ok()?.len(), ipv6)?;
        Some(Self { file, first, last })
    }

    fn read(&mut self, offset: u64, output: &mut [u8]) -> Option<()> {
        self.file.seek(SeekFrom::Start(offset)).ok()?;
        self.file.read_exact(output).ok()
    }

    fn lookup(&mut self, address: &[u8]) -> Option<String> {
        let mut vector = [0; 8];
        let prefix = u16::from_be_bytes([address[0], address[1]]) as u64;
        self.read(HEADER_BYTES + 8 * prefix, &mut vector)?;
        let start = read_pointer(&vector);
        let end = read_pointer(&vector[4..]);
        let address_len = address.len();
        let stride = (2 * address_len + 6) as u64;
        if start < self.first
            || end > self.last
            || end < start
            || !(start - self.first).is_multiple_of(stride)
            || !(end - start).is_multiple_of(stride)
        {
            return None;
        }
        let mut low = 0;
        let mut high = (end - start) / stride + 1;
        while low < high {
            let middle = (low + high) / 2;
            let mut record = [0; 38];
            self.read(start + middle * stride, &mut record[..stride as usize])?;
            let (range, data) = record.split_at_mut(2 * address_len);
            let (first, last) = range.split_at_mut(address_len);
            if address_len == 4 {
                first.reverse();
                last.reverse();
            }
            if address < &*first {
                high = middle;
            } else if address > &*last {
                low = middle + 1;
            } else {
                let size = read_u16(data) as usize;
                let offset = read_pointer(&data[2..]);
                if offset < DATA_START || offset + size as u64 > self.first || size > 4096 {
                    return None;
                }
                let mut text = vec![0; size];
                self.read(offset, &mut text)?;
                let region = std::str::from_utf8(&text)
                    .ok()?
                    .split('|')
                    .take(4)
                    .filter(|part| !part.is_empty() && *part != "0")
                    .collect::<Vec<_>>()
                    .join(" · ");
                return (!region.is_empty()).then_some(region);
            }
        }
        None
    }
}

#[tauri::command]
pub(crate) async fn ip_region_lookup(
    app: AppHandle,
    addresses: Vec<String>,
    include_ipv6: bool,
) -> Result<BTreeMap<String, String>, String> {
    let dir = database_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut v4 = Database::open(&dir.join(database_name(false)), false);
        let mut v6 = include_ipv6
            .then(|| Database::open(&dir.join(database_name(true)), true))
            .flatten();
        addresses
            .into_iter()
            .take(1024)
            .filter_map(|address| {
                let ip = address
                    .split('%')
                    .next()?
                    .parse::<IpAddr>()
                    .ok()?
                    .to_canonical();
                let region = match ip {
                    IpAddr::V4(ip) => v4.as_mut()?.lookup(&ip.octets()),
                    IpAddr::V6(ip) => v6.as_mut()?.lookup(&ip.octets()),
                }?;
                Some((address, region))
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_address_families_and_ignores_unindexed_prefixes() {
        for address in [
            vec![8, 8, 8, 8],
            vec![0x20, 1, 0xdb, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        ] {
            let ipv6 = address.len() == 16;
            let mut bytes = vec![0; DATA_START as usize];
            bytes[..4].copy_from_slice(&[3, 0, 1, 0]);
            bytes[16] = if ipv6 { 6 } else { 4 };
            bytes[18] = 4;
            let location = "测试国家|测试省|测试市|0|TT";
            bytes.extend_from_slice(location.as_bytes());
            let segment = (bytes.len() as u32).to_le_bytes();
            bytes[8..12].copy_from_slice(&segment);
            bytes[12..16].copy_from_slice(&segment);
            let prefix = u16::from_be_bytes([address[0], address[1]]) as usize;
            let offset = HEADER_BYTES as usize + 8 * prefix;
            bytes[offset..offset + 4].copy_from_slice(&segment);
            bytes[offset + 4..offset + 8].copy_from_slice(&segment);
            let mut endpoint = address.clone();
            if !ipv6 {
                endpoint.reverse();
            }
            bytes.extend_from_slice(&endpoint);
            bytes.extend_from_slice(&endpoint);
            bytes.extend_from_slice(&(location.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&(DATA_START as u32).to_le_bytes());

            let path = std::env::temp_dir().join(format!(
                "zhandu-ip-region-test-{}-{ipv6}.xdb",
                std::process::id()
            ));
            fs::write(&path, &bytes).unwrap();
            let mut database = Database::open(&path, ipv6).unwrap();
            assert!(Database::open(&path, !ipv6).is_none());
            assert_eq!(
                database.lookup(&address).as_deref(),
                Some("测试国家 · 测试省 · 测试市")
            );
            let mut unindexed = address;
            unindexed[0] += 1;
            assert_eq!(database.lookup(&unindexed), None);
            drop(database);
            fs::remove_file(path).unwrap();
        }
    }
}
