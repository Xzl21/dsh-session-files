# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；版本号与 `package.json` 同步。

## [0.1.4] - 2026-11-13

### 新增

- **回收站面板**：树右上角新增「回收站」按钮。按批次列出历史上被清理的文件（时间 / 来源会话 / 文件数 / 体积，
  可展开看清单），支持「恢复整批」与「删除整批」。恢复是**复制**，回收站里的原件保留，可以反复恢复；
  目标位置已有同名文件时跳过而不是覆盖。
- **自动清理（保留期）**：可选「关闭 / 7 天 / 30 天 / 90 天」，**默认关闭**。开启后，超过保留期的批次会在
  插件启动、打开回收站、修改设置这三个时机被自动永久删除；关闭时永远不自动删。设置存在
  `$DSH_HOME/session-files/config.json`。
- 新增 host 路由：`GET /api/session-files/trash`、`POST /api/session-files/trash/restore`、
  `POST /api/session-files/trash/empty`、`POST /api/session-files/config`。

### 说明

- 「删除整批」是插件里**唯一**真正删磁盘的操作（`fs.rm`），必须二次确认；`/trash/empty` 也要求显式给出
  `batch` 或 `olderThanDays >= 1`，避免误触「全删」。
- 之前「清理临时文件」的行为不变：仍然只移动到回收站，永不直接删除。

### 工程

- `CONTRACT.md` §6 增加 4 条路由、§7 增加回收站文案键、§10 增加 `config.json` 与保留期清扫语义。
- `test/integration.real.mjs`、`test/client-layout.test.mjs` 增加回收站相关用例。

## [0.1.3] - 2026-11-12

### 新增

- **文件卡片弹窗新增「打开文件所在文件夹」**：在系统文件管理器里定位该文件（Windows
  `explorer.exe /select,"<path>"`、macOS `open -R`、Linux 打开父目录）；文件已被清理时改为打开
  它原来所在的文件夹，客户端提示「文件已不在，已打开它原来所在的文件夹」。
- 新增 host 路由 `POST /api/session-files/reveal`（body `{ sessionId, path }` → `{ ok, path, exists, isDirectory }`）。

### 修复

- **「打开文件所在文件夹」弹出来的是「文档」**：Explorer 的 `/select,` 只认
  `/select,"C:\dir with spaces\file.ext"` 这种「引号只包路径」的写法。原来把
  `'/select,' + path` 当成一个 argv 交给 `spawn()`，libuv 会把整个 token 重新加引号，
  Explorer 解析失败后就退回到默认目录（文档）。现在改为自己拼命令行并经 `cmd.exe`（`shell: true`）启动，
  Explorer 收到的就是用户在命令行里手敲的那串参数；同时文件已不存在且其父目录也没了时回退到工作区根目录，
  避免再次落到「文档」。
- **预览失败的文案分不清原因**：`file-not-found` 之前也会显示「Host 半未生效或需要重启 DSH」。
  现在 `file-not-found` 显示「文件已不在工作区（可能已被清理到回收站）」，只有其它错误码才提示 Host 未就绪。

### 工程

- `CONTRACT.md` §6 增加 `/reveal` 路由与「预览错误码」说明。
- `test/integration.real.mjs` 的路由断言从 4 条更新为 5 条。

## [0.1.2] - 2026-11-12

### 修复

- **「显示有 N 个临时文件，清理却说没有需要清理的」**：temp 记账只增不减——文件早已被移进回收站
  （或被用户删掉）后，ledger 仍把它们算进 `counts.temp`，而清理命令只移动磁盘上真实存在的文件，
  于是面板显示 178、点清理却「没有临时文件需要清理」，数字永远不掉。现在三层都对上了：
  - host：重建 ledger 时对 temp 节点做磁盘核对（最多 400 条），已消失的节点 `exists:false`，
    并在 `counts.tempMissing` 报出失效记账条数；
  - host：`/delete` 把「文件早已不在」的候选变成 `pruned`（只忘记账、不动磁盘），写入
    `$DSH_HOME/session-files/gone/<sessionId>.json`，重建 ledger 时丢弃这些旧记录；
  - client：列表把 `exists:false` 的 temp 行标灰并显示「文件已不存在」；「清理全部临时文件」
    在无可删文件但存在失效记账时，仍会执行一次剪枝并提示「已清除 N 条失效记账」。

### 工程

- `CONTRACT.md` §5 补充 `counts.tempMissing` 与 `nodes[].exists` 的磁盘核对口径；
  §6 `/delete` 增加 `pruned` 字段与剪枝语义；§10 增加 `gone/` 存储说明。
- 新增 `test/cleanup-stale.test.mjs`（失效记账：核对 → 剪枝 → 计数归零 → 文件回归不会被误忘）。

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
