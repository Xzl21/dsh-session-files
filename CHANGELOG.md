# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；版本号与 `package.json` 同步。

## [0.1.1] - 2026-11-11

### 修复

- **清理会误删仓库自己的文件**：分类器曾把「以 `.` 开头的文件」和「名字里含 `dump/tmp/probe` 等词的文件」一律判为临时文件，
  导致用户在多会话点「清理临时文件」时，`plugins/dsh-session-files/` 自己的 `.gitignore`、`.gitattributes`、
  `tools/layout-dump.mjs` 被移进回收站（共 4 个会话的 trash 里有这些文件，可从
  `$DSH_HOME/session-files/trash/` 手动恢复）。修复分三层：
  - 配置/plumbing 白名单（`.gitignore`/`.gitattributes`/`.editorconfig`/`package.json`/`LICENSE`/`pyproject.toml` 等）永不走临时规则；
  - 名字启发式（含 `dump/probe/tmp` 等词、只写一次且无引用）**只对本会话真正碰过的文件生效**，
    纯扫描到的历史文件不再被名字判成垃圾；
  - 位于**子目录项目**（任一层祖父目录含 `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod` 等 manifest）内的文件
    不走启发式，仓库工具与配置默认安全。
- 显式临时规则（`_`/`~` 开头、`.tmp/.bak/.log` 后缀、`.DS_Store` 等、`tmp_*`/`probe_*` 前缀、`.tmp*/scratch/cache/verify` 目录）保持原样。

### 新增

- `tools/publish.mjs`：零依赖、走 GitHub REST API 的增量发布脚本（`--dry-run`/`--tag`/`--message`），自动从
  `$DSH_HOME/.dsh-gitdeck/auth.json`、`GH_TOKEN` 或 `--token` 取凭据；`tools/publish-history.mjs` 用于首建仓逐提交重放。

### 工程

- 测试基线更新为 `ledger 62 / client 50 / integration 67`（新增 4 条防误删回归用例）。
- `CONTRACT.md` §4 重写分类分层规则，`info` 形状新增可选 `projectDir`。

## [0.1.0] - 2026-11-06

首个可用版本。

### 新增

- **会话文件台账**：从 live session 事件 + 多帧 zstd 会话日志 + 工作区扫描三路合并，得到「本会话碰过哪些文件」。
- **四道分类**：交付 / 过程 / 输入 / 临时，含 `present` 识别、preexisting 判定、临时文件模式（`_tmp*`、`debug.log`、`*.bak`、`verify/` 等）。
- **左 → 右树**：列 = 输入 + 每轮 + 交付；行 = 四道；卡片含动作、体积、判定原因、徽章、备注；连线含 derived / evolution / deliverable / origin。
- **交互**：全屏画布、0.4×–2× 缩放、道折叠、卡片抽屉（预览 / 改分类 / 备注）、`Esc` 逐层关闭。
- **未展开清单**：`workspace.tempPaths`（被判 temp 但树里没有节点的历史垃圾）+「另有 N 个未展开」chip/popover。
- **两步清理**：`dryRun` 拿权威清单 → 确认 → 移入 `$DSH_HOME/session-files/trash/<session>/<epochMs>/`，永不硬删。
- **agent 工具** `session_files`：`list` / `classify` / `cleanup`（含 `dryRun`）+ 4 行系统提示词。
- **HTTP 接口**：`/ledger`、`/classify`、`/delete`、`/preview`，仅回环可达。
- **持久化**：分类 override 与备注按会话存 `overrides/<sessionId>.json`（原子写 + 串行队列）。
- **工程**：`CONTRACT.md` 契约、三套测试（60 / 50 / 67）、离线渲染工具（ledger → PNG）、QA 报告。

### 已知限制

- UI 视觉未在真实浏览器验证（无浏览器控制），布局/渲染由单测与离线渲染保证。
- `exists` 不追踪工具调用之间被 shell 删除的文件。
- 工作区外路径只给 `outside-workspace` 警告，不建节点。
