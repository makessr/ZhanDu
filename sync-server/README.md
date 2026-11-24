# 栈渡主机同步服务

栈渡桌面端通过 HTTPS 登录同步服务。SQLite 保存邮箱、登录密码的校验哈希、设备会话、加密的主机数据及被加密包裹的主密钥。用户的主密码或旧恢复密钥原文不上传，服务端数据库备份也不包含它。

## 部署安全基线

- **必须使用 HTTPS**。客户端只接受 `https://` 服务地址；仅当主机为 `localhost`、`127.0.0.1` 或 `[::1]` 时才允许明文 HTTP，用于本机开发。
- 同步服务只监听宿主机回环地址 `127.0.0.1:8787`，TLS 由同机反向代理终止。不要把 8787 直接暴露到公网。
- 数据库目录和 `sync.env` 仅服务账户可读写（`0700` / `0600`）；数据库备份包含账号与会话数据，按敏感文件保存。
- 公网部署建议把 `FINESHELL_SYNC_REGISTRATION` 设为 `invite` 或 `closed`，不要长期开放自助注册。
- 认证限流保存在单个进程的内存中，重启后清零，也不能在多个实例间共享；部署细节见[客户端来源限流](#客户端来源限流)。

## 选择部署方式

| 场景 | 从哪里开始 |
| --- | --- |
| Linux 服务器已有宝塔和 Nginx | [systemd](#systemd)，再配置[宝塔 Nginx 和 Cloudflare](#宝塔-nginx-和-cloudflare) |
| Linux 服务器主要用容器 | [Docker Compose](#docker-compose)，再配置同机 HTTPS 反向代理 |
| 服务已经上线，只更新程序 | [升级已有服务](#升级已有服务) |
| 只在本机试用 | [Windows 或本机开发](#windows-或本机开发) |

两种 Linux 安装方式选一种，都使用宿主机回环地址 `127.0.0.1:8787`。外部客户端访问域名的 HTTPS 端口，由同机 Nginx 转发到同步服务。下面用 `sync.example.com` 举例，配置时换成自己的同步域名。

## Linux 部署

### systemd

1. 安装 Node.js 26，确认 `/opt/fineshell-sync/node/bin/node --version` 显示 `v26.x`，同一目录下也应有 `npm`。如果使用系统安装的 Node.js，请用 `command -v node` 和 `command -v npm` 查到实际路径，相应调整下面的命令以及 [systemd 服务单元](deploy/zhandu.service) 的 `ExecStart`。
2. 从栈渡仓库根目录执行下面的命令。首次安装会从示例创建配置文件，已有配置会保留。

```bash
sudo install -d -m 0755 /opt/fineshell-sync
sudo install -d -m 0700 /etc/fineshell-sync
sudo install -m 0644 sync-server/server.mjs sync-server/onboarding.mjs sync-server/auth-v2.mjs \
  sync-server/package.json sync-server/package-lock.json /opt/fineshell-sync/
sudo install -m 0644 sync-server/deploy/backup-snapshot.mjs \
  sync-server/deploy/portable-backup.mjs /opt/fineshell-sync/
sudo test -e /etc/fineshell-sync/sync.env ||
  sudo install -m 0600 sync-server/deploy/sync.env.example /etc/fineshell-sync/sync.env
sudo env PATH=/opt/fineshell-sync/node/bin:/usr/bin:/bin \
  /opt/fineshell-sync/node/bin/npm ci --prefix /opt/fineshell-sync --omit=dev --ignore-scripts
sudo install -m 0644 sync-server/deploy/zhandu.service /etc/systemd/system/
sudo systemctl daemon-reload
```

3. 编辑 `/etc/fineshell-sync/sync.env`，根据[注册与邮件配置](#注册与邮件配置)选择注册模式。自用且暂时不创建账号时可设为 `closed`。首次建号可在开放注册期间完成，之后再改为 `closed`。文件保持 root 专用的 `0600` 权限。
4. 启动服务并确认本机探针返回 `{"service":"zhandu","status":"ok"}`。systemd 会管理数据库目录，默认数据库位于 `/var/lib/fineshell-sync/vault.sqlite`。

```bash
sudo systemctl enable --now zhandu
curl -fsS http://127.0.0.1:8787/healthz
```

### Docker Compose

从仓库的 `sync-server` 目录执行。创建或编辑权限为 `0600` 的 `.env`，字段见[配置示例](deploy/sync.env.example)。容器以普通用户运行，数据库位于容器内的 `/data/vault.sqlite`，由命名卷 `vault` 保存。

```bash
cd sync-server
(umask 077; set -C; [ -e .env ] || cat deploy/sync.env.example > .env)
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
```

以后从同一目录和同一 Compose 项目维护服务，以便继续使用原来的数据卷。

## 宝塔 Nginx 和 Cloudflare

1. **DNS**。在 Cloudflare 的 DNS 记录里添加 `A` 记录。若区域是 `example.com`，名称填 `sync`，IPv4 地址填 Linux 服务器公网地址。首次调通时可以选「仅 DNS（灰云）」，先直接验证宝塔的 HTTPS。如果已有指向该站点的记录，检查并使用现有记录。 [Cloudflare DNS 代理状态](https://developers.cloudflare.com/dns/proxy-status/)
2. **宝塔站点和证书**。在「网站」中打开该域名的站点，或为它创建一个 Nginx 站点。在站点的 SSL 设置中部署覆盖此域名的证书。灰云模式下，使用客户端信任的证书，例如 Let’s Encrypt。服务器对外提供 HTTPS 443，宝塔使用 HTTP 验证证书时还需开放 80 并保留验证路径。 [宝塔官方反向代理文档](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)
3. **配置反向代理**。在该站点的 HTTPS `server { ... }` 内添加下面两个 `location`，也可放进站点已有的扩展配置文件。如果宝塔已生成同一路径的规则，编辑原规则。保留现有证书、证书续期路径和其他站点配置。

```nginx
location = /healthz {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_cache off;
}

location ^~ /v1/ {
    client_max_body_size 8m;
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache off;
}
```

`proxy_pass` 的端口后保持无路径，Nginx 会将 `/v1/...` 原样转发。用宝塔所管理的 Nginx 执行 `nginx -t`，语法检查通过后重载。 [Nginx 反向代理指令](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

4. **可选的 Cloudflare 代理**。源站 HTTPS 验证通过后，可把 DNS 记录切到「已代理（橙云）」，并为该域名使用 `Full (strict)`。该模式需要源站 443 可达，且证书未过期、域名匹配，签发方为受信任的 CA 或 Cloudflare Origin CA。若已有全站缓存规则，为同步域名的 `/v1/*` 和 `/healthz` 配置绕过缓存。 [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

### 客户端来源限流

systemd 部署中，若 Nginx 通过回环连接服务，且使用上面的配置覆盖 `X-Real-IP`，可以在 `sync.env` 加上 `FINESHELL_SYNC_TRUST_LOOPBACK_PROXY=1` 并重启。仅 DNS 时，Nginx 的 `$remote_addr` 可直接用于来源限流。

开启 Cloudflare 代理后，Nginx 默认看到的是 Cloudflare 节点 IP。需要按访客 IP 限流时，先按 Cloudflare 的 Nginx 指南配置 `real_ip_header CF-Connecting-IP`，并用 `set_real_ip_from` 限定为 Cloudflare 官方地址段，验证后继续由 Nginx 将 `$remote_addr` 写入 `X-Real-IP`。Compose 使用桥接网络并发布宿主机的回环端口，容器收到的连接未必来自回环，保持 Compose 的默认设置即可。 [Cloudflare 恢复客户端 IP 指南](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)

#### 限流状态与多实例

认证尝试窗口（按邮箱，每分钟 8 次）和按来源的请求限流都保存在进程内存中：

- 服务重启后计数清零，攻击者可通过触发重启绕过窗口；
- 多个实例各自计数，无法共享额度；
- 需要更强的限流或水平扩容时，请在反向代理层增加 `limit_req` 等规则，或把限流迁到外部存储后再运行多个实例。

### 上线验证与排错

先在服务器上检查本机服务，再从另一台设备检查公开地址。把下面的域名换成你自己的域名。

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS https://sync.example.com/healthz
curl -fsS https://sync.example.com/v1/registration
curl -sS -o /dev/null -w '%{http_code}\n' https://sync.example.com/v1/vault
```

预期两次健康检查都返回 `status: ok`，注册接口返回 `open`、`invite` 或 `closed`，匿名访问仓库返回 `401`。桌面端在「设置 → 主机同步」填写 `https://sync.example.com`，域名后留空。

| 现象 | 优先检查 |
| --- | --- |
| 本机 8787 无法连接 | systemd 用 `sudo journalctl -u zhandu -n 50 --no-pager`，Compose 用 `docker compose logs --tail 50 sync` |
| 本机正常，公网返回 `404` 或 `502` | 确认请求命中正确的 HTTPS 站点、代理路径和目标 `127.0.0.1:8787` |
| Cloudflare 返回 `526` | 核对宝塔源站证书的有效期、域名与证书链 |
| 同步返回 `413` | 检查 Nginx 的 `client_max_body_size`；服务自身接受的同步请求体上限是 8 MiB |
| 多个人同时登录遇到 `429` | 检查 Nginx 是否识别真实访客 IP，并查看日志中的 `ZhanDu authentication activity` |

## 升级已有服务

- **systemd**。记录当前部署的源码版本，先做[在线快照](#异机备份与恢复)。从新的源码版本重新执行 [systemd 安装](#systemd)第 2 步，把程序和依赖更新到同一版本。如果修改过单元文件，安装前先合并本地调整。保留 `/etc/fineshell-sync/sync.env` 和 SQLite 数据。如果旧单元名称是 `fineshell-sync.service`，先执行 `sudo systemctl disable --now fineshell-sync.service`，再执行 `sudo systemctl enable --now zhandu.service`。已使用 `zhandu.service` 时，执行 `sudo systemctl restart zhandu.service`。按[上线验证](#上线验证与排错)检查本机和公网。
- **Docker Compose**。先备份现有数据卷中的数据库。从原 Compose 目录更新源码并运行 `docker compose up -d --build`。保留原项目名、`.env` 和现有命名卷，再检查服务日志和健康探针。

升级失败时，先查看服务日志。如果确认上一版程序兼容当前数据库，可用升级前记录的源码版本重新部署程序。需要回退数据时，按[切换到恢复后的数据库](#切换到恢复后的数据库)操作。

## 注册与邮件配置

### OPAQUE 登录和邮箱找回

客户端和服务端都升级后，在配置文件中启用 `FINESHELL_SYNC_OPAQUE_SETUP`。OPAQUE 注册、登录和重设账号密码使用协议消息，账号密码留在客户端。旧账号继续支持明确选择的兼容登录，可在新版客户端用旧账号密码验证一次并迁移，迁移会使其他设备重新登录。

systemd 部署可用下列命令生成一次配置。命令只把随机配置追加到已有的 root 专用文件，请在设置新的同步实例时运行。已有 OPAQUE 配置的服务器必须沿用原值。

```bash
sudo sh -eu -c '
  cd /opt/fineshell-sync
  config=/etc/fineshell-sync/sync.env
  test "$(stat -c %a "$config")" = 600
  if grep -Eq "^[[:space:]]*FINESHELL_SYNC_OPAQUE_SETUP(_FILE)?=" "$config"; then
    printf "%s\n" "已有 OPAQUE 配置，请沿用原值" >&2
    exit 1
  fi
  ./node/bin/node --input-type=module -e "
    import * as opaque from \"@serenity-kit/opaque\";
    await opaque.ready;
    process.stdout.write(\"\\nFINESHELL_SYNC_OPAQUE_SETUP=\" + opaque.server.createSetup() + \"\\n\");
  " >> "$config"
'
sudo systemctl restart zhandu
```

Docker Compose 部署可在权限为 `0600` 的 `.env` 中设置同一变量，再重建容器。把该配置作为密钥单独保护，并与对应数据库一同纳入异机恢复演练。已有数据库会校验配置指纹，缺少或使用了不同配置时会拒绝启动。

配置了 SMTP 或 Resend 后，客户端可在登录页请求一次性邮箱验证码并重设账号密码。重设会撤销旧会话，主密码和主机密文保留。已解锁设备可用系统凭据库里保存的主密钥重新登录。旧数据库备份仍可能包含迁移前的账号密码校验哈希。

| `FINESHELL_SYNC_REGISTRATION` | 新账号 | 已有账号 |
| --- | --- | --- |
| `open`（默认） | 自助注册 | 可登录、同步 |
| `invite` | 管理员发放邀请码，用户填写邮件验证码 | 可登录、同步 |
| `closed` | 暂停注册 | 可登录、同步 |

改完配置后，systemd 执行 `sudo systemctl restart zhandu`，Compose 执行 `docker compose up -d` 使新的环境变量生效。自建 SMTP 465 使用隐式 TLS，587 使用强制 STARTTLS。两种方式都校验证书。邀请注册发送「栈渡邮箱验证」，找回流程发送「栈渡账号密码重设」。

```dotenv
FINESHELL_SYNC_REGISTRATION=invite
FINESHELL_SYNC_MAIL_PROVIDER=smtp
FINESHELL_SYNC_MAIL_FROM=sync@example.com
FINESHELL_SYNC_SMTP_HOST=mail.example.com
FINESHELL_SYNC_SMTP_PORT=465
FINESHELL_SYNC_SMTP_USER=sync@example.com
FINESHELL_SYNC_SMTP_PASSWORD=<SMTP 密码>
```

用 Resend 时将 `FINESHELL_SYNC_MAIL_PROVIDER` 设为 `resend`，配置已验证的 `FINESHELL_SYNC_MAIL_FROM` 和 `FINESHELL_SYNC_RESEND_API_KEY`。待邮件配置生效后，选择与你部署方式对应的一条命令创建邀请码，私下发给对应邮箱的用户。邀请码绑定邮箱、有效期七天，注册成功后失效。邮箱验证码有效期为 15 分钟。

```bash
# systemd
sudo env FINESHELL_SYNC_DATABASE=/var/lib/fineshell-sync/vault.sqlite \
  /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/onboarding.mjs invite user@example.com

# Docker Compose，在 sync-server 目录运行
docker compose exec sync node onboarding.mjs invite user@example.com
```

## 跨设备使用

1. 在第一台设备的「主机同步」中创建账号，自行设定或生成主密码，并保存在密码管理器。旧版同步服务使用恢复密钥。
2. 在另一台设备中输入同一个服务地址、账号密码和主密码。旧账号也可以用原恢复密钥解锁。成功后凭据会写入设备的系统凭据库，私钥文件导入本机。首次连接时仍需按提示核对服务器指纹。SSH Agent 中的密钥要在对应设备配置。
3. 主窗口运行时会自动检查同步，新改动可在设置中点「立即同步」发起同步。不同主机的修改会合并。同一项在两台设备同时修改时，设置中可比较并逐项选择版本。本机找不到某个私钥文件时，其他主机仍会同步，设置会显示受影响条目并提供重新关联入口。
4. 一个栈渡本地配置绑定一个同步账号。退出登录会停止自动同步，已同步的连接仍保留在本机。同步设置可以查看账号的登录设备和最后同步时间，重命名当前设备，并撤销其他设备的登录。

同步包括已保存的主机、分组、关联代理与 SSH 密钥，以及已经保存的对应密码或口令。连接历史、服务器指纹信任、应用设置和终端记录保留在各设备。恢复密钥丢失后，账号密码无法解密远端主机数据。

## 异机备份与恢复

| 用途 | 方式 |
| --- | --- |
| 升级前留一份一致的 SQLite 快照 | 在线快照 |
| 换服务器，需要带走备份 | AES-256-GCM 可移植备份 |
| 在独立 Windows 电脑上定期备份 | PowerShell 脚本与当前 Windows 用户的 DPAPI |

### 在线快照

可以在服务运行时执行。脚本用 SQLite 的在线备份接口生成一致快照，并检查完整性。输出的 SQLite 文件仍包含账号和会话数据，按敏感文件保存。

```bash
# systemd
sudo env FINESHELL_SYNC_DATABASE=/var/lib/fineshell-sync/vault.sqlite \
  /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/backup-snapshot.mjs /var/backups/fineshell-sync

# Docker Compose，在 sync-server 目录运行
docker compose exec sync node backup-snapshot.mjs /data/backups
# 用上一条命令输出的实际文件名替换下例文件名
docker compose cp sync:/data/backups/vault-示例.sqlite ./
```

Compose 快照起初仍在同一个卷里。复制出来后，将它存放到独立的受控存储中。

### 可移植加密备份

以下以 systemd 的默认安装路径为例。首次创建一次专用的 32 字节随机备份密钥。若已持有密钥，请跳过生成命令。恢复时需要生成该备份的同一个密钥文件，平时与备份分开存放。

```bash
sudo install -d -m 0700 /etc/fineshell-sync/backup-keys /var/backups/fineshell-sync
sudo sh -c 'umask 077; set -C; openssl rand 32 > /etc/fineshell-sync/backup-keys/portable.key'
```

使用唯一的备份文件名，命令输出备份路径。把生成的加密文件复制到异机存储。

```bash
backup="/var/backups/fineshell-sync/vault-$(date -u +%Y%m%dT%H%M%SZ).backup"
sudo /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/portable-backup.mjs backup \
  /var/lib/fineshell-sync/vault.sqlite "$backup" /etc/fineshell-sync/backup-keys/portable.key
```

将备份复制到异机后，可以单独核对文件和密钥是否匹配。验收机器需要 Node.js 26，并把同一版本的 `portable-backup.mjs` 和 `backup-snapshot.mjs` 放在同一目录。

```bash
node /path/to/portable-backup.mjs verify /path/to/vault.backup /path/to/portable.key
```

校验检查加密认证标签、SQLite 完整性及恢复步骤，成功时输出 `Backup verification passed`。校验只读取备份和密钥，解密副本位于当前用户的临时目录内，正常结束或检测失败时都会清理。请在受控环境运行，并为临时目录预留足够空间。需要切换服务时，仍应执行下面的隔离实例恢复演练。

在新 Linux 实例上安装相同或兼容版本的服务。先把加密文件和对应密钥安全传到新实例，并将文件权限设为 `0600`。在下面的命令中换入实际路径。恢复目录需要支持硬链接，因为脚本在同一目录验证结果后才发布文件。输出目标须是新文件，脚本会拒绝覆盖已有数据库。

```bash
sudo install -d -m 0700 /var/backups/fineshell-sync/restore
sudo /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/portable-backup.mjs restore \
  /path/to/vault.backup /var/backups/fineshell-sync/restore/vault.sqlite /path/to/portable.key
```

恢复时会校验加密认证标签和 SQLite 完整性，并清除旧登录会话、邀请码及邮箱验证码。切换生产服务前，先在隔离实例用测试账号验证登录、读取和更新同步数据。如果备份早于最近一次恢复密钥更换，恢复后需用备份当时的恢复密钥解锁对应账号。

### Windows 异机备份

在独立 Windows 电脑上运行 PowerShell 7。任务账号需能通过 SSH 登录 Linux 服务器，并持有已核对的服务器主机指纹。脚本生成在线快照，用当前 Windows 用户的 DPAPI 加密后保存到本机。

```powershell
pwsh -File ./sync-server/deploy/backup-to-windows.ps1 `
  -SshTarget 'your-sync-host' -KnownHosts 'C:\path\known_hosts' `
  -Destination 'C:\path\FineShellSyncBackups' -RestoreDrill
```

`-RestoreDrill` 用 Node.js 26 在内存解密并检查快照，可通过 `-NodePath` 指定 Node.js。默认保留最近 30 天，只有备份成功后才清理旧快照。任务计划程序应使用同一 Windows 用户，恢复也需要该用户的 DPAPI 凭据。

### 切换到恢复后的数据库

1. 先验证恢复文件。使用原始 SQLite 快照时，在隔离的恢复副本中清空 `sessions`，如存在 `invites` 和 `email_verifications` 也一并清空。可移植恢复命令已经执行了这一步。
2. 停止目标同步服务。将原有 SQLite 数据库以及同目录下存在的 `-wal`、`-shm` 文件一起移到单独的归档目录。
3. 将验证后的恢复文件放到服务配置的数据库路径，确保服务用户对目录和数据库拥有读写权限。原实例上可以参照归档数据库的属主和权限来设置。
4. 启动服务，检查 `/healthz`，让客户端重新登录并核对同步。若客户端提示云端版本落后，可从持有较新且已验证快照的设备在同步设置中确认恢复。备份之后新建、且未被快照保留的账号需要单独找回。

## 账号注销与数据保留

当前版本没有自助注销入口。客户端「退出登录」只撤销本机保存的会话并停止自动同步，不会删除服务端账号或云端快照。运营者在收到注销请求后按以下步骤处理：

1. 先按[在线快照](#在线快照)备份数据库，确认待删除账号的邮箱；
2. 停止同步服务；
3. 用 SQLite 删除账号及其会话。`accounts` 与 `sessions` 均以账号主键关联，删除顺序如下：

```bash
sqlite3 /var/lib/fineshell-sync/vault.sqlite <<'SQL'
BEGIN IMMEDIATE;
DELETE FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE email = 'user@example.com');
DELETE FROM accounts WHERE email = 'user@example.com';
COMMIT;
SQL
```

4. 启动服务并检查 `/healthz`。剩余邀请码与邮箱验证记录不影响其他账号，可按需清理 `invites`、`email_verifications`。

数据保留说明：

- 删除账号不会清理已经生成的数据库快照、可移植备份和系统日志；这些副本按各自的保留策略（备份脚本默认保留最近 30 天）自然过期，需要立即清除时请同时处理归档目录。
- 服务端只保存密文快照与会话元数据，但删除动作本身可被流量日志（反向代理访问日志）记录；如需最小化元数据，请同步配置代理日志保留时间。

## Windows 或本机开发

在仓库根目录使用 Node.js 26 和 PowerShell 运行。桌面应用中填写 `http://127.0.0.1:8787`。发行构建可通过 `VITE_FINESHELL_SYNC_URL` 预填正式 HTTPS 地址。

```powershell
npm ci --prefix sync-server --omit=dev --ignore-scripts
$syncData = Join-Path $env:LOCALAPPDATA 'FineShellSyncDev'
New-Item -ItemType Directory -Force -Path $syncData | Out-Null
$env:FINESHELL_SYNC_DATABASE = Join-Path $syncData 'vault.sqlite'
$env:FINESHELL_SYNC_PORT = '8787'
node sync-server/server.mjs
```

## 服务测试

```powershell
npm ci --prefix sync-server --ignore-scripts
node --test sync-server/server.integration.mjs sync-server/portable-backup.integration.mjs
```
