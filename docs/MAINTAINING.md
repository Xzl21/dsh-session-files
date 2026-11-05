# 维护与开发

## 0. 一句话架构

会话日志是唯一真相 → `host/ledger.mjs` 把事件折叠成台账（纯函数）→ `index.js` 用台账回答 HTTP 与 agent 工具 → `client.js` 把台账画成左→右树。**没有数据库、没有新 Session 事件类型**，所有状态要么可从日志重建，要么在 `$DSH_HOME/session-files/` 下按会话存覆盖。

```
会话日志(多帧 zstd JSONL)
   └─ host/logreader.mjs ──┐
   └─ live session events ─┴→ host/ledger.mjs → index.js ──HTTP──→ client.js
                                        └──────→ session_files 工具（agent）
                         overrides/trash ←── host/store.mjs
```

## 1. 环境

- DSH 桌面版（打包 app.asar）。改的是**工作区里的插件源码**，通过 `plugin_manager action=install_bundle` 装进 profile。
- **node 不在 PATH** 时用 DSH 自带运行时：
  `C:\Users\xzl\AppData\Local\Programs\DSH NEXT\resources\runtime\x64\primary-runtime\dependencies\node\bin\node.exe`
- profile 里 `node_modules/dsh-session-files` 是**指向本仓库的 Junction**（不是拷贝）→ 改源码不需要重装，但：**host 半改动必须重启 DSH 进程**；client 半刷新页面/HMR 即可。

## 2. 改代码的规矩

1. **先改契约**：行为/字段/路由有任何变化，先改 `CONTRACT.md`，再改代码和测试。契约是唯一真相。
2. **文件边界**（避免并行改同一文件）：
   - `host/ledger.mjs` + `test/ledger.test.mjs` —— 台账与分类，纯函数，禁止 IO/时钟（不许 `Date.now()`、不许 `node:fs`）。
   - `client.js` + `test/client-layout.test.mjs` —— UI 与布局，单文件 ES module，无构建、无 import、无 JSX。
   - `index.js` + `host/store.mjs` + `host/logreader.mjs` + `test/integration.real.mjs` —— 接线、持久化、日志读取、路由、工具。
3. 只用 `--dsw-alias-*` 主题 token 和 `var(--sf-*, fallback)` 自定义变量；不 require Harness 的 client 包；不写 iframe；不 append 新类型 Session 事件。
4. tool body 返回**裸 value**（见 `docs/USAGE.md` §2 的坑），失败用 `throw`。

## 3. 测试

```bash
NODE="C:/Users/xzl/AppData/Local/Programs/DSH NEXT/resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe"
"$NODE" test/ledger.test.mjs          # 台账/分类/树，纯函数
"$NODE" test/client-layout.test.mjs   # 布局算法 + 最小 hooks 运行时真渲染
"$NODE" test/integration.real.mjs     # 起假 ctx + 真 loopback HTTP + 真 index.js
```

三者当前基线：**ledger 60 / client 50 / integration 67，全绿**。
集成测试的铁律：**真实工作区一个文件都不许真删**——真删只在 `os.tmpdir()` 造的一次性 workspace 里做，结束时断言 `real <home>/session-files untouched: true`。`dryRun` 金丝雀（造一个探针文件 → 断言 dryRun 后它还在）必须保留。

## 4. 本地联调

```bash
# 导出真实会话台账（不经过浏览器）
"$NODE" test/integration.real.mjs --dump-ledger .ledger.json
# 让它指向指定会话
"$NODE" test/integration.real.mjs --session session-xxxx --dump-ledger .ledger.json

# 把台账画成 PNG（离线看布局效果）
"$NODE" tools/layout-dump.mjs .ledger.json layout.json
python tools/render-tree.py layout.json preview.png
```

`tools/layout-dump.mjs` 会真的加载 `client.js`（假 `window.__ModuleLoader__` + react stub），所以它验证的是**线上同一份布局函数**；`tools/render-tree.py` 只用 Pillow 画图。

## 5. 安装 / 升级 / 卸载

```text
plugin_manager action=install_bundle target=D:\...\dsh-session-files
```

- 幂等：重复执行会重新 link 并应用补丁；返回 `{"stage":"enable","changed":true,"application":"applied"}` 才算生效。
- 升级：改 `package.json` 的 `version`，重启 DSH，再确认插件行 `active`。
- 卸载：`plugin_manager action=remove_bundle target=dsh-session-files`（或用 profile 的插件管理器）。
- 回滚：`git tag vX.Y.Z` + 重新 install_bundle 旧 tag 的检出。

## 6. 发布检查单

1. 三套测试全绿；`node --check` 干净。
2. `CONTRACT.md` 与实现一致（新增字段/路由已回写）。
3. `docs/USAGE.md` 更新截图/交互（如界面有变）。
4. `CHANGELOG.md` 增加条目。
5. `package.json` 的 `version` 升位（语义化版本）：修 bug → patch，新交互/字段 → minor，破坏契约 → major。
6. `README.md` / `README.en.md` 的功能列表同步。
7. `git commit && git tag vX.Y.Z && git push --tags`。
8. （可选）`npm publish` —— 需要先移除 `"private": true`。

## 7. 版本策略

- 插件跟随 DSH 的 host API；若 `@deepseek-ai/dsh-tools` 改变 tool body 返回值约定，改 `index.js` 的 `createToolExecute` 并补集成测试。
- 会话日志格式升级（`session.v5.jsonl.zstd` 之类）时，`host/logreader.mjs` 需要同时支持新旧格式，并在 `warnings` 里标注降级。
