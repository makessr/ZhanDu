## 改动说明

<!-- 改了什么、为什么改 -->

## 验证方式

<!-- 执行的命令、手动验证步骤、截图 -->

- [ ] `bun run check` 通过
- [ ] Rust：`cargo fmt --check`、`cargo test --locked`、`cargo clippy -- -D warnings` 通过
- [ ] 涉及 IPC 时已同步 `protocol/contract.json` 与两侧契约测试
- [ ] 涉及命令风险规则时已补充 `protocol/command-risk-cases.json`
- [ ] 涉及界面时已在 `tauri dev` 中实际验证并附截图
- [ ] 日志、截图与代码中不含密码、密钥或服务器敏感信息

## 安全影响

<!-- 是否触及审批凭证、路径令牌、凭据存储、同步加密；没有则写「无」 -->
