# AGENTS.md

- 构建：`pnpm build`；测试：`pnpm test`（Node/tsx 为准，`bun test` 有运行器差异不作为门禁）。
- 发版：默认只发 patch（`npm version patch` → `npm publish --access public` → push）。无明确要求不升 minor/major。
- 包名 `@akairos/code-deploy`，bin 名 `code-deploy`。发布内容由 `package.json` 的 `files: ["dist"]` 控制。
- 凭据必须用同步 `Entry`（`@napi-rs/keyring`）；`AsyncEntry` 在 Bun 下不可用。
