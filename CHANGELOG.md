# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；版本号与 `package.json` 同步。

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
