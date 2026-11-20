# 发布流水线

FineShell 将版本准备与跨平台构建拆成两个 GitHub Actions 工作流：

1. `Prepare Release` 根据 `patch`、`minor` 或 `major` 自动升级所有版本文件。
2. 工作流将 `CHANGELOG.md` 的 `Unreleased` 内容归档到新版本，并创建 `fix/release-vX.Y.Z` Pull Request。
3. 发布 PR 合并到 `main` 后，`Release` 自动校验版本和发布说明并创建 Draft Release。
4. 工作流并行构建 macOS、Linux 和 Windows 安装包及更新签名。
5. 工作流规范化并校验 `latest.json`，保存发布说明，并在运行摘要中提供草稿链接。
6. 维护者运行 `Audit release assets` 并完成客户端验收后，从 GitHub Releases 手动公开版本。

客户端通过 GitHub Releases 的 `latest.json` 检查更新，并由 Tauri Updater 校验安装包签名。

## 从 FineShell 过渡到栈渡

v0.6.2 已在栈渡仓库公开，v0.6.1 已在 FineShell 仓库公开。已安装的 v0.5.1 或 v0.6.0 客户端通过 v0.6.1 迁移更新渠道与验签公钥，随后由栈渡渠道交付 v0.6.2。这里的步骤也记录了此次迁移的交付顺序。

已安装的 FineShell v0.5.1 和栈渡 v0.6.0 从 `makessr/FineShell` 下载更新清单，只接受该仓库的 Release 安装包，并使用旧公钥验签。本仓库源码配置了栈渡独立渠道和新公钥。

1. 首个栈渡签名过渡版从 `makessr/FineShell` 发布，使用与已安装客户端公钥匹配的签名。保留安装标识、凭据存储和更新地址。
2. 从公开的 FineShell v0.5.1 安装包开始，验证应用内更新能自动下载、验签并安装过渡版，以及已有主机连接、密码和私钥仍可使用。
3. 先在本仓库准备独立首发 v0.6.2，当时从 `main` 手动运行 `Release` 并勾选 `draft_only`，核对了全平台产物、新签名和更新清单。获准后先公开独立渠道，确认客户端能读取 v0.6.2。
4. 旧仓库使用旧私钥签署切换版 v0.6.1。该版本内置栈渡渠道的更新地址和新公钥。两个候选版完成两段升级验收后，再从原渠道交付 v0.6.1。

常规 `Release` 会在创建草稿前检查应用更新地址是否属于发布仓库，并在公开前检查 `latest.json` 中每个安装包下载地址。迁移渠道时，须先设计和验收从旧渠道交付切换版的路径，再启用新仓库的常规发布。

从公开 v0.5.1 安装包起步的验收已覆盖 Windows x64 和 ARM64、macOS Apple Silicon 和 Intel、Ubuntu x64 和 ARM64。六个架构均通过应用内更新直接安装 v0.6.1，再安装 v0.6.2，并保留本地配置目录的测试标记。Windows 双架构另外用升级前保存的密码和加密私钥连接了 SSH 测试主机。[v0.5.1 两段升级验收](https://github.com/makessr/ZhanDu/actions/runs/44652450745)

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
4. `Release` 工作流启用时，版本变更合入 `main` 会触发构建。所有平台构建和清单检查通过后，打开运行摘要中的草稿链接。
5. 运行下文的草稿产物验收，完成适用的安装或升级测试。在 GitHub Releases 打开草稿，确认正式版本或预发行版本的设置，再选择 `Publish release`。

发布 PR 会同步更新：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `CHANGELOG.md`
- `README.md`

本地可以使用 `bun run release:prepare -- patch` 验证版本准备脚本。该命令会直接修改当前工作区，因此只能在干净的非 `main` 分支执行。

## 草稿产物验收

每次发布构建会在 GitHub Actions 运行的 Artifacts 中提供各架构的 `cargo-timings-*` 报告，保留七天。用报告对比各 Rust crate 的编译耗时，并用任务步骤的时间核对缓存恢复、前端依赖安装和安装包生成耗时。

Windows ARM64 的实测比较了三套独立运行器。恢复 Bun 软件包缓存并安装依赖的两次耗时约 90 秒和 123 秒，直接安装约 100 秒。发布流程继续使用冻结锁文件安装依赖。[Windows ARM64 缓存对照](https://github.com/makessr/ZhanDu/actions/runs/44758275558)

在 GitHub Actions 打开 `Audit release assets`，选择 `main` 分支运行。

| 输入 | 填写方式 |
| --- | --- |
| `release_tag` | 草稿版本标签，例如 `v0.6.3` |
| `release_commit` | 对应该草稿的 Release 构建运行所使用的完整 Git 提交 SHA |
| `signer_tag` | 构建时线上客户端使用的正式版本标签。验收草稿时填写当前最新正式版 |
| `platforms` | 与构建时的 `FINESHELL_RELEASE_PLATFORMS` 一致，完整平台选 `all`，仅 Windows 选 `windows` |
| `visibility` | 草稿选 `draft`。复核已公开版本时选 `public`，并填该版本升级来源的正式版标签 |

流程核对发布提交及客户端公钥，逐件计算 SHA-256，验证更新包的 Tauri 签名和 `latest.json` 的平台、下载地址及签名，并检查 Debian 包的架构、版本与 CA 证书依赖。macOS 的 DMG 参与哈希核对，Tauri 签名验收使用实际 OTA 下载的 `.app.tar.gz`。

验收仅访问现有发布数据。草稿的说明、产物或目标提交在验收后有改动时，公开前重新运行。签名轮换需要单独验证过渡路径。发布仍由维护者手动操作。

## macOS 首次安装验收

发布流水线使用 Apple Silicon 运行器分别编译 `aarch64-apple-darwin` 和 `x86_64-apple-darwin`。Intel 目标使用专用 Rust 缓存。每次打包后验证二进制架构和动态库路径，实际启动与升级在对应架构的运行器上验证。

用栈渡 v0.8.0 的同一提交对照，在未恢复 Rust 构建缓存的情况下，Intel 目标的编译和打包从 Intel 运行器的约 19 分 16 秒降到 Apple Silicon 运行器的约 14 分 03 秒。实际发布时间还受排队和缓存影响。[冷构建对照](https://github.com/makessr/ZhanDu/actions/runs/44758159145)

v0.6.2 的公开 DMG 已在 Apple Silicon（macOS 26.7.2）和 Intel（macOS 15.7.9）的 GitHub 托管运行器上验证。两份 DMG 的 SHA-256、应用版本、CPU 架构和临时签名均通过检查。在没有旧版 WebKit 配置的运行器上，从 DMG 复制出的应用成功打开桌面窗口。

Gatekeeper 处于启用状态。两台运行器都拒绝了手动赋予下载标记的单独应用副本，评估命令是 `spctl --assess --type execute`。从浏览器下载后的提示、是否显示「仍要打开」以及手动确认后的启动仍需在个人 Mac 上验收。[首次安装工作流](https://github.com/makessr/ZhanDu/actions/runs/44650481203)

从 v0.6.0 经 v0.6.1 到 v0.6.2 的应用内升级已分别在 macOS Apple Silicon、macOS Intel、Ubuntu x64 和 Ubuntu ARM64 上跑通。每个阶段都检查了版本、窗口和本地配置目录中的测试标记。[两段升级工作流](https://github.com/makessr/ZhanDu/actions/runs/44649992142)

## Debian XFCE 安装验收

v0.6.2 的正式 Debian 安装包已在 Debian 12（Bookworm）和 Debian 13（Trixie）中各验证 x64 和 ARM64。测试在对应 CPU 架构的 GitHub 托管运行器上使用 Debian 容器和 Xvfb，核对了 SHA-256、APT 依赖安装、软件包架构与版本，并在干净的 XFCE 会话内以普通用户通过已安装的桌面入口打开应用窗口。[四项安装及启动记录](https://github.com/makessr/ZhanDu/actions/runs/44655325742)

同样的四个组合均通过应用内升级。从公开的 v0.5.1 安装包起步，在 XFCE 会话内确认更新，依次安装 v0.6.1 和 v0.6.2。每次确认软件包版本、架构、应用自动重启后的可见窗口和本地配置目录中的测试标记。精简 Debian 镜像需提供 `ca-certificates`，供应用验证更新地址的 TLS 证书。本次使用容器与虚拟显示，实体机上的图形驱动及系统提权交互仍待验证。[四项应用内升级记录](https://github.com/makessr/ZhanDu/actions/runs/44662958965)

## v0.6.3 正式升级验收

v0.6.3 已在栈渡独立渠道公开。公开更新清单与签名草稿的 SHA-256 一致，七种更新包均可下载。[正式发布页](https://github.com/makessr/ZhanDu/releases/tag/v0.6.3)

从公开的 v0.6.2 安装包起步，Windows x64 和 ARM64、macOS Apple Silicon 和 Intel，以及 Debian 12、13 XFCE 的 x64 和 ARM64 均通过应用内升级。各环境均检查重启后的版本和测试配置标记。Windows 双架构还能用原先保存的密码和加密私钥重新连接本地 SSH 测试主机。Debian 容器核对了更新后安装包的 CA 证书依赖。[八项正式渠道升级记录](https://github.com/makessr/ZhanDu/actions/runs/44673891037)

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

正常流程由 Release 创建版本标签。工作流已启用但自动构建未触发时，可以在 GitHub Actions 中从 `main` 手动运行 `Release`，并填写与应用版本一致的 `vX.Y.Z`。手动运行也会生成待验收草稿。

## 失败重试

- `Prepare Release` 失败：修正 `Unreleased` 内容或清理同名远程分支后重新运行。
- 创建发布 PR 失败：确认仓库已允许 GitHub Actions 创建 Pull Request；工作流推送的发布分支可用于手动创建 PR。
- 单个平台偶发失败：在 GitHub Actions 中重跑失败任务。
- 发布构建失败：修复后发布新版本；未公开的 Draft Release 可以手动删除。
- 更新清单校验失败：检查构建矩阵是否生成全部平台包，以及下载地址是否指向当前版本的 GitHub Release。
