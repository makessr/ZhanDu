# 架构说明

本文描述栈渡（ZhanDu）的进程结构、模块边界和主要数据流。安全假设与威胁模型见 [SECURITY.md](SECURITY.md)，发布流程见 [docs/release-pipeline.md](docs/release-pipeline.md)。

## 技术栈

| 层         | 技术                                                            |
| ---------- | --------------------------------------------------------------- |
| 桌面壳     | Tauri 2（Windows WebView2 / macOS WKWebView / Linux WebKitGTK） |
| 前端       | React 18、TypeScript、Vite、Arco Design、xterm.js、VChart       |
| 后端       | Rust（ssh2/libssh2、Tokio、serde）                              |
| 同步服务   | Node.js 26、SQLite（可选、自部署）                              |
| 测试与构建 | Bun、GitHub Actions（Linux / Windows / macOS 矩阵）             |

## 目录结构

```
src/                  前端：界面、hooks、AI 对话与风险分类、设置
src-tauri/src/        Rust 后端：SSH、SFTP、AI 任务、同步、凭据、本地文件
protocol/             IPC 契约：contract.json、command-risk.json 及其用例
sync-server/          可选的主机同步服务（Node.js + SQLite）
scripts/              发布、清单校验、覆盖率与冒烟脚本
docs/                 发布流程与截图
```

## 进程与信任边界

```
┌────────────────────────── 桌面进程 ──────────────────────────┐
│  WebView（React）  ── Tauri IPC ──►  Rust 后端               │
│        │                              │                      │
│   本地存储/IndexedDB             SSH/SFTP/凭据库/文件系统      │
└──────────────────────────────────────┼───────────────────────┘
                                       │ HTTPS（可选）
                              同步服务（零知识密文）
```

- **WebView 不可信假设**：前端只负责展示与交互；所有高风险动作（命令风险分类、审批凭证、路径令牌、文件写入上限）都在 Rust 侧重新校验。
- **Rust 后端**：持有到服务器的 SSH 连接、系统凭据库访问权限和 AI 任务状态机。凭据只经系统凭据库读写，不进入 WebView。
- **同步服务**：只接收设备端加密后的快照，无法解密主机数据。

## IPC 契约

- 命令与事件注册在 [`protocol/contract.json`](protocol/contract.json)，`PROTOCOL_VERSION` 定义在 `src-tauri/src/protocol.rs`。
- `protocol.rs` 中的契约一致性测试会比对 `tauri::generate_handler!` 注册的命令集合、事件名与错误码枚举；前端 `src/tauri-protocol.test.ts` 校验同一契约。
- 新增命令必须同时更新 Rust 注册表、契约 JSON 与前端调用点，否则两侧测试都会失败。
- 命令错误统一为 `CommandError { code, message, retryable, operation }`。命令边界使用具名构造器返回明确错误码；字符串归类函数 `from_message` 仅作为尚未迁移模块的兼容层，并标记为 `#[deprecated]`。
- 事件：`ssh-output`、`ssh-status`、`sftp-transfer`、`ai-stream`、`ai-complete`、`ai-task` 等；窗口间配置变化通过 `configuration:changed` 广播。

## 前端结构

- `src/App.tsx` 是窗口入口，负责加载配置、维护全局设置与布局；业务逻辑尽量下沉到 `src/hooks/` 与纯函数模块。
- AI 请求编排拆分为三个 hook：
  - `useAiRequestOrchestrator`：发送消息、会话切换、审批动作编排；
  - `useAiStreamBridge`：订阅 `ai-stream` 并把增量合并进消息；
  - `useAiTaskRecovery`：订阅 `ai-task`、恢复未完成任务、把计划状态投影到消息。
- 命令风险规则以 [`protocol/command-risk.json`](protocol/command-risk.json) 为单一事实来源，由 `src/ai-command-risk.ts` 与 `src-tauri/src/agent_command_risk.rs` 共同读取，前端提示与后端拦截保持一致。
- 大面板（`SftpPanel`、`AiAssistantPanel`、`ServerMonitorPanel`）按功能拆分子组件；`AiMessageTimeline` 对 Markdown 渲染做了 memo 化，避免流式输出时重解析历史消息。SFTP 面板拆为 `SftpBrowserPane`、`SftpOverlayHost`、`sftpTableColumns` 与领域 hook；AI 面板拆为 `AiTimelineSection`、`AiApprovalDock`、`AiOverlayHost` 与 `useAiAgentBridge`。
- 会话级高频状态（终端最近输出、监控快照、SFTP 当前目录与刷新请求、终端当前目录）存放在 `src/session-store.ts` 的按会话 store 中，视图通过 `useSessionField` 只订阅自己需要的字段；终端输出更新不再触发 `App.tsx` 重渲染，AI 上下文由 `AiContextSourcesBridge` 订阅组装。

## Rust 后端结构

| 模块              | 职责                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `ssh/`            | 会话管理、认证、主机密钥校验、端口转发、健康检查                      |
| `sftp/`           | 远端路径解析、传输队列、压缩包、文本编辑                              |
| `agent/`          | AI 任务状态机、动作执行、审批凭证、计划与持久化                       |
| `ai/`             | 模型提供商适配（OpenAI/DeepSeek/Ollama/兼容服务）、流式输出、工具定义 |
| `host_sync.rs`    | 与同步服务交互、端到端加密、冲突检测                                  |
| `cloud_backup/`   | 云备份仓库加密与快照                                                  |
| `credentials.rs`  | 系统凭据库封装                                                        |
| `local_paths.rs`  | 一次性路径令牌与后端文件对话框                                        |
| `local_files.rs`  | 仅允许打开本次会话下载过的本地文件                                    |
| `config_files.rs` | 受令牌约束的配置文件读写、Ghostty 主题读取                            |

### AI 审批闭环

1. 前端提交审批 → `ai_task_action_approve`。
2. 后端按任务、计划、动作、主机、会话、当前目录与动作参数指纹生成作用域，签发一次性凭证（TTL 10 分钟）。
3. `ai_task_action_execute` 必须携带凭证；消费成功才执行，参数或作用域变化会直接失败。
4. `full_access` 只跳过常规确认；管道到 shell、解释器内联代码、命令替换、下载后执行、base64 解码执行仍逐条确认。

## 数据存储

- 配置数据库与 AI 对话历史：WebView 的 IndexedDB（位于系统应用数据目录）。默认明文；启用「本地数据加密」后，配置记录和 AI 对话以 AES-256-GCM 密文保存，密钥由解锁密码经 PBKDF2-SHA-256 派生，只保留在当前进程内存。加密状态与盐存放在独立的 `fineshell.security` 数据库。
- 凭据：Windows Credential Manager、macOS Keychain、Linux Secret Service。
- 终端日志：用户指定目录，主动开启时写入，不参与本地加密。
- 同步数据：设备端加密后上传；主密钥由主密码经 Argon2id 派生。
- 本地明文范围、加密实现与残余风险见 [SECURITY.md](SECURITY.md#本地数据与本地加密) 和设置中的「数据与隐私 → 隐私与清理」。

## 构建与发布

- `bun run check` 依次执行 ESLint、Prettier、单元测试（含覆盖率门槛）与生产构建。
- Rust 侧 CI 在 Linux 上执行格式化、测试与 Clippy，并在 Windows 与 macOS 上执行 `cargo check --locked`。
- 发布由 `release` GitHub Environment 手动或版本变更触发，构建草稿版本、校验资产摘要与更新清单后才能验收。
- Windows 源码构建需要 Perl（`openssl-src` 使用 vendored OpenSSL）；CI 安装 Strawberry Perl 并通过 `OPENSSL_SRC_PERL` 指定。

## 明确的范围边界

以下内容不在当前版本范围内，避免在 Issue 中重复讨论：

- **界面语言**：当前只提供简体中文界面，没有 i18n 框架；英文文档仅用于代码注释与发布资产命名。
- **macOS 公证**：macOS 包使用临时签名，尚未通过 Apple 公证；首次打开需在系统设置中手动放行。
- **第三方客户端导入**：不解析 PuTTY、Termius 等专有配置格式；仅支持 OpenSSH 配置导入。
- **内部标识冻结**：crate 名 `fineshell`、应用标识 `com.fineshell.app`、Windows 资产前缀 `FineShell` 与部分环境变量（`FINESHELL_*`）保持现状，避免破坏自动更新链、系统凭据存储键和同步服务兼容性；新代码引入对外名称时统一使用「栈渡 / ZhanDu」。
- **应用层静态加密的范围**：可选加密覆盖配置与 AI 对话历史，不覆盖终端日志、手动导出文件和 WebView localStorage；不提供密码找回、密钥轮换或解锁状态跨窗口共享。解锁后的进程内存与全盘加密仍由操作系统和用户负责。
