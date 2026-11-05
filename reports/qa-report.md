# dsh-session-files 集成 QA 报告

审阅时间：2026-11-06 00:55 +08:00（UTC 2026-11-05T16:55Z）
角色：ledger-core（真值提供方 + 审阅者）。只读审阅，未修改任何被审文件。

## 结论

**需先修 1 项 P0（A 侧 `host/ledger.mjs` 缺少 §5 `ledger.workspace` 块）后才能集成；C 侧此前两个 P0 级缺陷已在当前版本修复并复测通过。** 其余为 P1/P2 与契约缺口，不阻塞集成。

- 删除链路“永远删 0 个”的 P0（原 `index.js` 用 `stat(resolveWorkspacePath(...))`）已修复：现为 `index.js:640-641`（`const resolved = resolveWorkspacePath(...); stat(resolved.absolute)`），动态复测 dryRun 与真实删除均生效。
- 无文件可删时 dryRun 响应缺 `dryRun:true` 的 P0 已修复：现为 `index.js:731` 早期 return 带 `dryRun: dryRun ? true : undefined`。
- 仍阻塞集成的一条：`ledger.workspace` 从未生成，导致「扫描到但没有任何 tool call 触达的 temp 文件（历史遗留探针/log）」永远无法清理、client 的「展开历史遗留」区恒为空。这是本报告唯一 P0。
- `test/integration.real.mjs` 实跑：**PASS 45 / FAIL 2**，两处 FAIL 均直接由该 P0 导致（throwaway ledger finds temp files、throwaway dry run lists temp files）。
- 规范合规：client.js 只 `require('react')`、无 JSX、无 iframe、无 document.body 外 DOM；slot 名与 slot props 已在 shell 侧核实正确。仅 1 条 P1（slot 注册未包 `ctx.effect`）。

**基于 mtime 的版本**（文件仍可能被 owner 继续修改；以上结论仅对下列版本负责）：

| 文件 | 大小 | 行数 | mtime (UTC) |
| --- | --- | --- | --- |
| CONTRACT.md | 19013B | 301 | 2026-11-05T16:48:43Z |
| index.js | 47414B | 1182 | 2026-11-05T16:51:35Z |
| client.js | 99434B | 2368 | 2026-11-05T16:50:24Z |
| host/ledger.mjs | 43098B | 1331 | 2026-11-05T16:40:56Z |
| host/store.mjs | 12498B | 360 | 2026-11-05T16:38:05Z |
| test/integration.real.mjs | 27542B | — | 2026-11-05T16:51:19Z |
| test/ledger.test.mjs | 27044B | — | 2026-11-05T16:40:57Z |
| test/client-layout.test.mjs | 53500B | — | 2026-11-05T16:51:21Z |
| test/mock-ledger.json | 12824B | — | 2026-11-05T16:33:51Z |
| package.json | 814B | — | 2026-11-05T16:46:11Z |

验证方式：①静态审阅全部源码；②Node 动态 harness（`node -` 从 stdin 建 mock ctx / live session / 临时 workspace 与临时 DSH_HOME，直接调用注册出来的 route.handler 与 tool.execute）；③实跑 `test/integration.real.mjs`（真实会话日志 + 真实 workspace 只读，破坏性步骤只在 os.tmpdir() 副本上做）；④asar 字符串与内嵌 slot 契约文档核对 shell API。未运行 plugin_manager、未安装、未重启任何东西。

## 必修（P0）

| # | 文件:行 | 问题 | 依据 | 建议修法 |
| --- | --- | --- | --- | --- |
| 1 | host/ledger.mjs:801（buildTree）、1251（buildLedger）、1323（返回值）；消费方 index.js:661-682（ledgerTempPaths）、1040、1095，client.js:1514-1526（collectBacklog）、1790-1807（展开计数）、1801-1807（tempPathCount/truncated） | CONTRACT §5 要求的可选顶层 `ledger.workspace = {scanned, tempPathCount, tempPaths(≤500), truncated}` 从未生成（ledger.mjs 全文无 `tempPaths`，当前 GET /ledger 响应无 `workspace` 键）。后果：被判 temp 但没有任何节点（无 tool call 触达）的扫描文件成为「清理黑洞」——`/delete scope=all`、`session_files cleanup`、client「清理全部临时文件」都只能清 nodes 里的 temp，历史遗留的 temp 文件永远清不掉，client 展开区与 `workspaceRemaining` 恒为 0。 | 动态实测：workspace 仅含 session 开始后创建、无 tool call 的 `debug.log` → GET /ledger 返回 `counts {temp:1,files:1}`、`nodes: []`、无 `workspace` 键；POST /delete `{scope:'all'}` → 200 `{deleted:[],skipped:[]}` 且文件仍在；tool cleanup → `nothing to clean up; files 1 (...); workspaceRemaining 0`。`test/integration.real.mjs` 实跑 FAIL 2 条（`throwaway ledger finds temp files`、`throwaway dry run lists temp files`），根因均为 backlog=0。真实 workspace 会话（`fb1ae744-…`）GET /ledger：counts temp=219、nodes 仅 54 路径 → 缺块时这 200+ 个 temp 文件不可见、不可清。 | 在 `buildTree` 的返回值中加 `workspace`（或由 `buildLedger` 组装后透传）：`scanned = scanFiles.length`；`tempPaths = scanFiles` 中「最终分类为 temp 且不在 nodes 的 path 集合里」的相对路径，按 toLowerCase 去重、保留首次大小写、确定性排序（码点序）；`tempPathCount = tempPaths.length`；`tempPaths` 截断到 500 条并置 `truncated = tempPathCount > 500`；仅当 `tempPathCount > 0` 时输出该键（空时省略或输出 `{scanned, tempPathCount:0, tempPaths:[], truncated:false}` 均可，index.js 的 spread 会自动透传，无需改 index.js）。同时补 `test/ledger.test.mjs` 用例（含 `debug.log` 仅扫描场景、>500 截断场景、确定性重复调用）并更新 `test/mock-ledger.json` 夹具。 |

## 建议（P1）

1. **index.js:441、447、459（scanWorkspace 的 symlink 处理自相矛盾）**：`if (!entry.isFile() && !entry.isSymbolicLink()) continue;` 把 symlink 收进 collected，随后 `stat(absolute)` 跟随目标读取 size/mtime，但同时又 push warning `'scan-symlink-skipped'`（实际没跳过）。若 symlink 指向 workspace 外，ledger 会登记外部路径、`/preview` 能读外部文件（越界风险）。建议直接跳过 symlink，或 `realpath` 后校验仍在 workspace 内；至少把 warning 改成 `'scan-symlink-followed'` 或删除。
2. **index.js:482（scan 排序无 tie-break）**：`files.sort((a, b) => b.mtime - a.mtime)` 且 records 由 8 个并发 worker 乱序 push（`SCAN_CONCURRENCY=8`）→ mtime 相同的文件顺序不稳定，600 条截断边界跨请求可能不同，破坏「同样输入逐字节相同」的目标。建议 `files.sort((a,b) => b.mtime - a.mtime || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))`。
3. **client.js:2318-2332（slot 注册未包 ctx.effect）**：`slots.inject('conversation.input.right', () => slots.register(...))` 与 `slots.inject('shell.overlay', () => slots.register(...))` 的 disposer 被丢弃（卸载/热重载时无法移除）。参考已装 `dsh-session-remover` 的写法：`ctx.effect(() => slots.inject(SLOT, () => slots.register(entryOptions(...), Component)))`。另外 client.js:2315 只取 `ctx.slots`，无 `ctx.get('slots')` 回退（参考插件为 `ctx.slots || ctx.get("slots")`）。
4. **client.js:2248（空态与 header 计数矛盾）**：`else if (nodes.length === 0) bodyContent = renderEmpty()` → 当 nodes=0 但 counts.files>0（典型：只有扫描 temp 文件、无 tool call）时，抽屉显示「这个会话还没有产生文件」，而 header 的 countsRow（client.js:2023-2031）同时显示「工作区 1 文件 · 树中 0 节点」。建议空态按 `counts.files > 0` 分支，展示「本会话没有触碰文件，但工作区扫描到 N 个文件（其中 M 个 temp 可清理）」。
5. **client.js:1290-1304 + index.js:796（onReset 会丢用户刚输入的备注）**：`onReset` 调 `onClassify(node.path, null, draftNote)`；index.js `const cls = value.cls === undefined ? null : value.cls;` 使 `cls=null` 进入 `store.setOverride` 的「删除整条 override」分支（store.mjs:184-219），刚输入的 note 也一起丢失。若「恢复自动分类 + 保留备注」是期望语义，client 应发 `cls` 省略与 note 分开的语义，host 端省略 cls 时保留原 override/只更新 note。
6. **client.js:1316（skipped 显示风格）**：`if (skipped.length > 0) setOpError('skipped');` 用错误样式显示「已跳过 N 项」而非常规 toast（对比 cleanup 走 `toast.skipped`）。建议统一为 info toast。
7. **index.js:796（note-only 请求清空 override）**：body 只有 `{sessionId, path, note}`（省略 cls）时 cls 被当成 null → 整条 override 被删。§6 未规定省略 cls 的语义；client 不会这样发（reset 是显式 cls:null+note，属有意清除），但 HTTP API 语义应明确。建议省略 cls 时保留既有 cls 只更新 note，或契约写明「省略=null」。
8. **test/mock-ledger.json / test/ledger.test.mjs 未覆盖 `workspace` 块**：P0 修复时同步更新夹具（mock-ledger.json 当前 12824B 不含 workspace 字段）。
9. **P2：client.js:1498-1511（collectTempPaths 不排除已删节点）**：只按 `node.lane === 'temp'` 收集，不过滤 `node.exists === false`，二次清理时本地估算会带上已移走的路径；当前有 host dryRun authoritative 兜底，实际影响小。

## 硬编码色值清单

以下均为 `var(--dsw-alias-*, fallback)` 的兜底值（client.js 2368 行版），非 `--dsw-alias-*` 硬编码；建议后续统一到主题 token 或补暗色兜底。共 41 处 hex、18 处 rgba：

- LANE_FALLBACK（465-468）：`#2f6fe4` `#0e9f8a` `#8a8f9a` `#d1862b`
- ACTION_FALLBACK（472-477）：`#4f7ee0` `#12946f` `#c98a1b` `#9a5cd0` `#d6538a` `#d93025`
- 中性兜底：482 `#838893`；1152 `#9aa0aa`；1161 `#838893`；2070 `#9aa0aa`；2075 `#838893`
- CSS 基础兜底（777-786）：`#ffffff` `#f5f6f8` `#1b1d22` `#4a4f59` `#838893` `#9aa0aa` `#2f6fe4` `#d93025`
- CSS lane 变量（794-797）：`#2f6fe4` `#0e9f8a` `#8a8f9a` `#d1862b`
- CSS act 变量（802-807）：`#4f7ee0` `#12946f` `#c98a1b` `#9a5cd0` `#d6538a` `#d93025`
- 白色：#fff（865、866、961、963）
- 边/图例内联兜底：1157 `#2f6fe4`；1166 `#2f6fe4`；2071 `#2f6fe4`；2078 `#2f6fe4`
- rgba 边框/阴影/底色：779 `rgba(0,0,0,.12)`、780 `rgba(0,0,0,.22)`、787 `rgba(0,0,0,.05)`、791 `rgba(0,0,0,.28)`、798 `rgba(47,111,228,.055)`、799 `rgba(14,159,138,.055)`、800 `rgba(138,143,154,.065)`、801 `rgba(209,134,43,.065)`、825 `rgba(9,11,16,.46)`、850 `rgba(209,134,43,.1)`、851 `rgba(209,134,43,.16)`、868 `rgba(217,48,37,.08)`、907 `rgba(127,127,127,.028)`、908 `rgba(47,111,228,.045)`、917-919 `rgba(0,0,0,.05/.12/.12)`、977 `rgba(0,0,0,.28)`

## 契约待补条款

1. **§2 vs §6 冲突（log-not-found）**：§2 说「日志文件不存在/解压失败 → `log-not-found`」，§6 说「非 live 且无日志 → 404 `session-not-found`」。index.js 实际：找不到日志目录/文件用 `session-not-found`（index.js:347，附 `params.reason`），`readSessionLog` 抛错用 `log-not-found`（353/355）。建议以 §6 为主并明确 `log-not-found` 的触发条件与 status。
2. **§8 `value.ledger` 形状未定**：index.js `toolSuccess` 只给 `{sessionId, workspacePath, live, source, counts}`（index.js:942-954），而 §8 只写 `ledger?`。建议写明允许裁剪版本及其字段，或要求完整 ledger。
3. **§8 `dryRun` 的适用范围**：参数表已加 `dryRun`，但未说明 list/classify 收到 dryRun 时应忽略还是报错（index.js:814 只校验 boolean，cleanup 才用）。
4. **§6 preview 的 `binary` 字段**：契约只在二进制时给 `binary:true`，index.js 恒返回 `binary: false`（index.js:761）。建议契约写明「恒带或仅二进制时带」，二者择一。
5. **§7 i18n 键表是「至少」还是「仅」**：client.js 使用 85 个 key（含 reason.*、edge.*、action.*、toast.*、stats.* 等），zh/en 均已补齐；§7 只列 18 个。建议写明 §7 为最小集合、新增键需同步 locale/{zh,en}.json。
6. **§5 `workspace` 块的细节**：`scanned` 应等于扫描到的文件总数（含 600 截断前的数字还是截断后？建议写明）；`tempPaths` 是否包含 override 后仍为 temp 的路径；`tempPathCount` 与 `tempPaths.length` 在截断时不等的关系。
7. **§5 node-limit 截断的可见性**：按 `(col, lane, path)` 稳定截断会整列丢靠后的 turn 列（实测 4100 个 write 时只保留 col1-8，第 9 轮节点全被截掉），ledger 只加 `node-limit` warning；建议契约说明或让 UI 在看到 `node-limit` 时提示「节点过多，部分轮次未展示」。
8. **§6 `workspace.tempPaths` 去重/相对化规则**：index.js `ledgerTempPaths` 会对 tempPaths 再做 `normalizeRelPath`，建议契约写明 tempPaths 必须是 workspace 相对路径、不含 `..`/绝对路径。
9. **§2 扫描排序确定性**：契约只写「按 mtime 倒序截断到 600」，未要求 tie-break；为满足确定性目标建议补「mtime 相同按 relPath 字典序」。
10. **§9 shell.overlay（scope root）跨会话桥接**：契约未描述 `shell.overlay` 无 `sessionId` 的问题；client 用模块级 store 桥接（正确做法），建议契约补一句，避免后续实现踩坑。

## 我验证过且 OK 的项

**host 注册与请求/响应边界（动态实测 + 静态审阅）**
- 模块导出 `apply/inject/name`，`inject = ['webServer']`（index.js:30）；四条 `{kind:'exact', path:'/api/session-files/ledger|classify|delete|preview'}` 路由全部注册成功（index.js:780-809），与 §6 路径一致。
- 全部路由先走 `requestRejection`（index.js:145-157）：非回环 host / `sec-fetch-site: cross-site` / 不匹配 origin → 403 `{ok:false,code:'forbidden'}`；错误响应统一 `{ok:false,code,params?}`，无自然语言；`content-type: application/json; charset=utf-8`；405 带 `allow`。
- GET /ledger：live session → 200 `{ok:true,ledger}`，顶层 `sessionId/workspacePath/sessionCreatedAt/generatedAt/live/source/counts/lanes/columns/nodes/edges/warnings` 齐全；`generatedAt=Date.now()` 由 index.js finalize 提供（符合 §3 允许 C 用 Date.now）；两次 GET 除 `generatedAt` 外 JSON 全等（确定性）。
- §5 字段形状全部可消费：node 的 `id/path/name/ext/dir/col/lane/cls/autoCls/reason/overridden/note/exists/size/mtime/birthtime/turns/actions/sources/kind` 在实测节点中均出现；columns `{id,kind,title,subtitle,turn?}`（turn 列 subtitle 为本地 HH:mm，如 `00:53`）；edges 只含 `from/to/kind`；`counts` 五键齐全；`lanes` 顺序 `[deliverable,process,input,temp]`。
- 空 events → 只有 input + final 两列（2 列）；空 events + 扫描文件（`_tmp_probe.py`/`report.docx`/`sub/data.json`/`verify/check1.txt`，sessionCreatedAt 设为未来）→ input 列出现 4 个 `kind:"input"` 节点（`report.docx`、`sub/data.json` 为 input lane；`_tmp_probe.py` reason=`temp-name`、`verify/check1.txt` reason=`temp-dir`，lane=temp；符合 §5「preexisting 未写过」定义），counts `{input:2,temp:2,files:4}`。
- node-limit：4100 个 write 事件、9 个 turn → GET /ledger 57ms，nodes=4000、`warnings:["node-limit"]`、边引用完整性 0 dangling、columns 11 个（input+9 turn+final）。
- 长路径（`d/`×90+`f.txt`）与中文路径（`目录/报告 2026.docx`）正常成节点（t1 节点 + `#final` + deliverable 边）；/classify 长路径 200；/preview 不存在的长路径 404。
- 无 workspace（无 cwd 且 workingDirectory.get 返回 undefined）：GET /ledger 200、workspacePath null、warnings `['no-workspace']`；POST /delete → 404 `{ok:false,code:'no-workspace'}`；非法 sessionId → 400 `bad-session-id`；不存在会话 → 404 `session-not-found`（含 params.reason）。

**删除 / 分类闭环（C 侧已修复后复测）**
- POST /delete `{sessionId,scope:'all',dryRun:true}` → 200 `{ok:true,deleted:[...],skipped:[],dryRun:true,ledger}`，且文件未动；去掉 dryRun 再调 → 文件真正被移走（磁盘存在性 false），后续 GET counts.temp 归零；真实 `$DSH_HOME/session-files/trash/<sessionId>/<epochMs>/<relPath>` 结构由 store.trashFiles 保证，`C:\Users\xzl\.dsh\session-files` 全程未被真实删除（integration.real.mjs 自带断言 `real ... untouched: true`）。
- POST /classify：合法 200 且 override 生效；`../` 越界 400 bad-path；cls 非法 400 bad-cls；note 非字符串 400 bad-note；cls:null 清除 override（§6）。
- 工具 `session_files`：注册参数与 §8 一致（`action` enum `[list,classify,cleanup]`、`paths` array、`cls` enum、`note`、`dryRun` boolean，required `[action]`）；`list` 输出紧凑表且总行数 ≤120；`cleanup` 无 paths 时清全部 temp 节点；`classify` 上限 200 paths、cls 校验；错误路径均返回 `isError:true` 文本；`exec.agent.id` 缺省时给出可读错误；未知 action 拒绝。
- 提示词：`ctx.systemPrompt.section({name:'session-files', order:40, text})` 注册成功，`text` 4 行（≤5 行），用 `runEffect` 包裹。

**client.js（B）**
- 字段消费与 ledger 输出完全一致，无拼错/错层：读 `ledger.nodes/edges/columns/counts/lanes/warnings/source/generatedAt/workspacePath`；node 读 `id/path/name/ext/dir/size/mtime/exists/lane/cls/autoCls/reason/overridden/note/turns/actions[].tool/action/turn/time/kind/col`；columns 读 `kind/title/subtitle`；layout 以 `node.col` 定位、缺失端点的边被丢弃（与 ledger 边完整性契约兼容）。
- 4 条 fetch 与 §6 对齐：GET `/ledger`（取 `body.ledger`）、POST `/classify` `{sessionId,path,cls,note}`、POST `/delete` `{sessionId,scope,paths,dryRun}`（先 dryRun 再真实执行，用 `body.dryRun===true` 判定 authoritative）、GET `/preview` `{sessionId,path,maxBytes:65536}`；所有响应统一按 `data.ok !== true` 抛 `code`（含 `{ok:false,code,params}` 消费）。
- 计数分开表述符合 §5：`counts.files`（工作区文件）+ lane 统计 + `counts.nodes`（树中节点）两个 chip（client.js:2023-2031）；`workspace.tempPathCount`、`truncated`、`collectBacklog` 逻辑已就绪（待 A 生产数据即可工作）。
- 规范合规：factory 只 `require('react')`（client.js:24），无 Harness Client 包 require、无 JSX、无 iframe、无 document.body 外 DOM（样式用 `dangerouslySetInnerHTML` 注入 `<style>` 在组件内渲染）；CJK 仅出现在 DICT 区（60-215 行），DICT 85 键 zh/en 齐备，动态 `t('reason.'+x)`/`t('lane.'+x)` 全部命中；`window.__ModuleLoader__.load({id:'dsh-session-files', factory})` 与已装插件同 API（asar 中 `__ModuleLoader__` 存在，`__DSH_CLIENT__` 为 0 次）。
- slot 名与 props 已在 shell 侧核实：asar 内嵌 slot 契约文档中 `conversation.input.right`（kind list、scope session、`standardProps.sessionId`、注册选项 `{name,id,order,label?}`）与 `shell.overlay`（scope root）均存在，client 的注册形状与官方示例一致；`package.json` 的 `dsh.client.inject: ['@deepseek-ai/dsh-client-ui-conversation']` 属合法 manifest 声明（参考插件同样声明），不违反 §1。
- 修复验证：client.js 的 cleanup 先 POST `/delete {scope:'all',dryRun:true}`（client.js:1708），用 host 返回的 `deleted` 作为 authoritative 目标（1714-1730），再真实执行（1741）；`collectBacklog` 读 `ledger.workspace.tempPaths`（1516-1517），`tempPathCount`/`truncated` 读 `ledger.workspace`（1800-1807）——**A 侧补上 `workspace` 块后该链路即通，无需改 client**。

**已知限制 / 不阻塞项**
- preview 恒返回 `binary:false`（契约未禁止；client 兼容）。
- `toolSuccess` 裁剪 `value.ledger`（契约未定形状）。
- `test/integration.real.mjs` 的 2 条 FAIL 属 P0 后果，A 修复后应转绿（建议修复后重跑确认）。
- 本次审阅为只读；A 修 P0 会改动 host/ledger.mjs + 测试夹具，届时建议再跑一次本报告的动态 harness 与 integration.real.mjs。
