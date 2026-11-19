# 发布流水线

FineShell 将版本准备与跨平台构建拆成两个 GitHub Actions 工作流：

1. `Prepare Release` 根据 `patch`、`minor` 或 `major` 自动升级所有版本文件。
2. 工作流将 `CHANGELOG.md` 的 `Unreleased` 内容归档到新版本，并创建 `fix/release-vX.Y.Z` Pull Request。
3. 发布 PR 合并到 `main` 后，`Release` 自动校验版本和发布说明并创建 Draft Release。
4. 工作流并行构建 macOS、Linux 和 Windows 安装包及更新签名。
5. 工作流规范化并校验 `latest.json`，写入发布说明后公开 GitHub Release。

客户端通过 GitHub Releases 的 `latest.json` 检查更新，并由 Tauri Updater 校验安装包签名。

## 从 FineShell 过渡到栈渡

FineShell v0.5.1 从 `makessr/FineShell` 下载更新清单，只接受该仓库的 Release 安装包，并使用已内置的公钥验签。栈渡目前仍配置这个渠道。

1. 首个栈渡签名过渡版从 `makessr/FineShell` 发布，使用与已安装客户端公钥匹配的签名。保留安装标识、凭据存储和更新地址。
2. 从公开的 FineShell v0.5.1 安装包开始，验证应用内更新能自动下载、验签并安装过渡版，以及已有主机连接、密码和私钥仍可使用。
3. 将更新渠道迁移到 `makessr/ZhanDu` 作为独立变更处理。先验证旧渠道交付的客户端可以读取新渠道，再验证该客户端能从新渠道安装下一版。切换签名时，分别核对每一跳的安装包和前一版客户端所信任的公钥。

常规 `Release` 会在创建草稿前检查应用更新地址是否属于发布仓库，并在公开前检查 `latest.json` 中每个安装包下载地址。迁移渠道时，须先设计和验收从旧渠道交付切换版的路径，再启用新仓库的常规发布。

## GitHub 配置

GitHub Actions 需要配置仓库密钥 `TAURI_SIGNING_PRIVATE_KEY`，用于生成可由客户端验证的更新签名。工作流使用仓库提供的 `GITHUB_TOKEN` 创建发布 PR、Release 和构建产物，无需额外访问令牌。

如果签名私钥受密码保护，同时配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。仓库变量 `FINESHELL_RELEASE_PLATFORMS` 可设为 `windows`，仅发布 Windows x64 和 ARM64，校验阶段也会使用相同的平台范围。默认值 `all` 保留完整平台矩阵。

仓库的 Actions 设置需要允许 GitHub Actions 创建 Pull Request。`main` 分支保护继续负责审核发布 PR，工作流不会直接向 `main` 提交。

## 日常准备

开发过程中只需将面向用户的变更记录到 `CHANGELOG.md` 顶部的 `Unreleased` 区域，不要提前修改应用版本或创建版本标签。

## 正常发布

1. 在 GitHub Actions 中运行 `Prepare Release`。
2. 选择 `patch`、`minor` 或 `major`。
3. 检查工作流创建的发布 PR，确认版本和更新日志后合并。
4. 合并会自动触发 `Release`；所有平台构建通过后 Release 自动公开。

发布 PR 会同步更新：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `CHANGELOG.md`
- `README.md`

本地可以使用 `bun run release:prepare -- patch` 验证版本准备脚本。该命令会直接修改当前工作区，因此只能在干净的非 `main` 分支执行。

## Windows 桌面验收

在安装了 WebView2、Node.js 26、Bun、Rust MSVC 工具链和 Windows 原生 Perl（如 Strawberry Perl）的测试机上运行。Perl 用于编译随 Windows 客户端构建的 OpenSSL。先在仓库安装 Bun 前端依赖和 `sync-server` 的 npm 依赖。为 SSH 测试另装 `ssh2`，传入其入口文件，测试会使用本地回环地址和合成凭据。

```powershell
npm ci --prefix sync-server --ignore-scripts
npm install --prefix "$env:TEMP/FineShellSmokeDeps" --ignore-scripts ssh2
pwsh -File ./scripts/windows-smoke/sync.ps1 -Ssh2Module "$env:TEMP/FineShellSmokeDeps/node_modules/ssh2/lib/index.js"
```

脚本在临时目录编译测试应用，为两台模拟设备使用独立的 WebView2 配置、应用标识和系统凭据库命名空间。它通过实际设置界面注册、登录，并验证第二台设备自动收到主机、能用同步的密码和私钥打开 SSH 终端、能读取 SFTP 测试目录，以及更换恢复密钥后旧设备会话失效。正式构建不含测试配置。

OTA 验收需在未安装 FineShell 的独立 Windows 测试用户或虚拟机上跑。从前一版 Release 下载并验签 x64 NSIS 安装包，等待目标版 Release 已公开，再运行以下命令。脚本通过应用内更新下载安装包，确认版本和本地测试数据，并卸载本次测试安装。

```powershell
pwsh -File ./scripts/windows-smoke/ota.ps1 -VerifiedInstaller ./FineShell_0.4.0_windows_x64-setup.exe -Baseline 0.4.0 -Target 0.4.1
```

## 手动恢复

正常流程不需要手动创建 tag。自动发布未触发时，可以在 GitHub Actions 中从 `main` 手动运行 `Release` 并填写与应用版本一致的 `vX.Y.Z`；发布提交必须属于 `main`。

## 失败重试

- `Prepare Release` 失败：修正 `Unreleased` 内容或清理同名远程分支后重新运行。
- 创建发布 PR 失败：确认仓库已允许 GitHub Actions 创建 Pull Request；工作流推送的发布分支可用于手动创建 PR。
- 单个平台偶发失败：在 GitHub Actions 中重跑失败任务。
- 发布构建失败：修复后发布新版本；未公开的 Draft Release 可以手动删除。
- 更新清单校验失败：检查构建矩阵是否生成全部平台包，以及下载地址是否指向当前版本的 GitHub Release。
