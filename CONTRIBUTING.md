# 贡献指南

感谢参与栈渡（ZhanDu）。本文说明开发环境、提交前检查和代码约定。安全问题请不要公开提交 Issue，按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

## 环境要求

- Rust stable（含 `rustfmt`、`clippy`）
- Bun `1.3.11`（与 CI 一致）
- Node.js 26（仅修改 `sync-server/` 时需要）
- 对应平台的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)
- **Windows**：额外安装 Perl（例如 Strawberry Perl）。`openssl-src` 在源码构建 OpenSSL 时需要它；如果不在 `PATH` 中，构建前设置 `OPENSSL_SRC_PERL` 指向 `perl.exe`。CI 通过 Chocolatey 安装 Strawberry Perl 并设置该变量。

## 本地开发

```bash
bun install --frozen-lockfile
bun run tauri dev
```

只改前端时可运行 `bun run dev`（Vite 端口 1420）；涉及 IPC、SSH、SFTP 或 AI 任务的改动必须用 `tauri dev` 验证。

## 提交前检查

```bash
bun run check                      # ESLint + Prettier + 单元测试 + App 黄金路径 + 生产构建
bun run test:coverage              # 单独运行测试并校验覆盖率（函数 68%、行 73%）
bun run test:app                   # 仅运行 App 级黄金路径测试（独立进程）
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
```

修改同步服务时：

```bash
npm ci --prefix sync-server --ignore-scripts
node --test sync-server/*.integration.mjs
```

修改发布脚本时至少运行 `bun test scripts/`。

## 代码约定

- **IPC 契约**：新增或修改 Tauri 命令必须同步更新 `src-tauri/src/protocol.rs` 的命令注册、`protocol/contract.json` 与前端调用点。两侧都有契约一致性测试，缺一项 CI 会失败。
- **命令风险规则**：破坏性命令规则维护在 `protocol/command-risk.json`，Rust 与 TypeScript 两侧共用。正则必须同时兼容 Rust `regex`（不支持 lookaround / 反向引用），并在 `protocol/command-risk-cases.json` 中补充正反例。
- **错误模型**：命令边界使用 `CommandError` 的具名构造器返回明确错误码；不要新增字符串归类（`from_message`）用法。
- **本地文件能力**：前端不要直接传路径给后端。使用后端文件对话框签发的 `pick_local_path` 令牌，`read_config_file` / `write_config_file` 只接受一次性令牌。
- **AI 审批**：任何绕过审批凭证的后端路径都视为安全缺陷；执行入口必须消费 `ai_task_action_approve` 签发的凭证。
- **界面文案**：面向用户的文本使用简体中文；代码标识符、日志与协议字段使用英文。
- **注释**：只在原因不直观的地方写一行注释，避免复述代码。
- **依赖**：新增前端或 Rust 依赖时说明用途；CI 会运行 `cargo audit` 与 `npm audit`，不要为此降低审计级别。

## Pull Request

1. 从 `main` 建立分支，标题使用中文简述改动目的。
2. 描述中说明：改了什么、为什么改、如何验证（命令或截图）；涉及界面时附截图。
3. 保持提交聚焦，一个 PR 只做一件事；发布相关改动（版本号、CHANGELOG）交由 `Prepare Release` 工作流处理。
4. 涉及安全边界的改动（审批、路径令牌、凭据、同步加密）请在描述中单独说明威胁模型影响。
5. 确保 CI 全绿后再请求评审；不要在 `main` 上直接提交。

## 发布

发布流程见 [docs/release-pipeline.md](docs/release-pipeline.md)。签名密钥只存在于 `release` Environment，不在本地或仓库中保存。
