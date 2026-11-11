# dsh-session-files — 共享契约（唯一真相）

本文件由 Lead 维护。所有实现（host/ledger.mjs、index.js、client.js）必须严格按此契约。
任何一方想改契约，先通知 Lead，由 Lead 改本文件后再动手。

## 0. 产品定义

一个 DSH 插件（Host 半 + Client 半，同一个 npm 包）。给**每一个 session** 生成一张
「文件血统树」：横轴 = 轮次（turn）从左到右，纵轴 = 4 条道（lane）：

| lane | 中文 | 含义 | 清理策略 |
| --- | --- | --- | --- |
| `deliverable` | 交付 | 最终产物、present 过的文件、用户要的东西 | 永不清理 |
| `process` | 过程 | 值得留的中间产物（中间 docx/xlsx、抽取的 json、生成的数据） | 保留 |
| `input` | 输入 | 会话开始前就存在 / 用户带进来的文件 | 保留 |
| `temp` | 临时 | 探针脚本、`_tmp*`、`.log`、`.bak`、一次性的 `python/pwsh` 脚本 | 可一键删除（移到回收站） |

节点 = 「这一轮里这个文件的一次触达」。同一文件在多轮出现 = 多个节点 + evolution 边，
形成一条从左到右的生命线。交付文件在最右的「交付」列有一个终态节点。

## 1. 目录与模块边界（谁写哪个文件）

插件包目录：`D:\005agent\dsh data\plugins\dsh-session-files\`

```
package.json          Lead（已写好）
cordis.patch.yml      Lead（已写好）
locale/en.json        Lead（已写好）
locale/zh.json        Lead（已写好）
icon.svg              Lead
CONTRACT.md           Lead（本文件）
host/ledger.mjs       A（纯函数，禁止 import node:fs / node:path 之外的东西；不许碰 ctx）
host/store.mjs        C（fs 持久化：分类覆盖 + 备注 + 回收站）
index.js              C（host 接线：HTTP 路由 / agent 工具 / 系统提示词 / 会话数据加载）
client.js             B（UI：按钮 + 全屏树）
test/ledger.test.mjs  A（node 直接跑的单测，无框架）
test/mock-ledger.json Lead（B 的联调数据，A 可用于对拍）
```

约束：
- 全部 ESM（`type: module`）。host 半只用 node 内置模块，**零第三方依赖**。
- `index.js` 与 `host/*.mjs` 里不要 `import` 任何 `@deepseek-ai/*` 包（打包在 asar 里，解析不到）。
- client.js 只能用 `require('react')` 和浏览器全局（`fetch`/`window`/`document`/`Intl`）；
  **禁止** require 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-*`）。
- 禁止 JSX（没有编译步骤）。全部 `React.createElement`，可写 `const h = React.createElement`。
- 用户可见文案走 locale：client 里读 `ctx.get('locale')`，用本文件 §7 的字典，不要散落硬编码中文字符串。

## 2. 数据来源（Host 侧如何拿到「这个 session 碰过哪些文件」）

一个 session 的真相在 session log。两种来源：

1. **live session**（进程里有）：`ctx.get('sessions').get(sessionId)` → `Session`。
   - `session.header` = `{ version, id, createdAt, cwd?, ... }`
   - `session.snapshotEvents(0, session.seq)` → `readonly SessionEvent[]`，元素形如
     `{ type, seq, time, data }`。只需要这些 type：
     - `turn/start` → `data: { turn }`
     - `turn/end` → `data: { turn, reason }`
     - `tool/call` → `data: { turn, step, callId, name, arguments }`（**arguments 是 JSON 字符串**）
     - `tool/result` → `data: { turn, step, message, error?, meta? }`
   - 文件工具名与参数（`arguments` 解析后）：
     - `write` / `edit` → `{ file_path }` 写
     - `read` / `read_image` → `{ file_path }` 读
     - `present` → `{ files: [{ path }] }` 或 `{ path }`，交付
     - `bash` / `pwsh` → `{ command }`（**不是** file_path，需要从命令文本里抠路径，见 §4）
     - `glob` / `grep` → `{ path? }`（目录，忽略或当读）
     - `office_*` → `{ path }` / `{ file }` / `{ output }` 尽量兼容

2. **非 live session**（历史会话，进程里没有）：读日志文件。
   - 位置：`$DSH_HOME/sessions/*/<sessionId>/session.v4.jsonl.zstd`（`$DSH_HOME` 默认
     `C:\Users\xzl\.dsh`）。**不要**自己拼 workspace slug，直接枚举 `sessions/*/` 下找
     `<sessionId>` 目录（性能可接受：目录数很少）。
   - 格式：**多帧拼接**的 zstd（每个 flush 一帧，实测 330 帧），解压后是 JSONL：
     第一行 `{"type":"session","version":4,"id":…,"createdAt":…,"cwd":…}` 是 header，其余是事件。
   - **坑**：`zstdDecompressSync(整文件)` 和 `createZstdDecompress()` 都只解第一帧（实测只拿到 202 字节）。
     必须按 `28 b5 2f fd` 魔数切候选偏移，逐段尝试解压（参考实现见 `host/logreader.mjs`）。
   - `SessionEvent` 的字段同 live：`{ type, seq, time, data }`。
   - 文件不存在 → `warnings: ['log-missing']`；文件存在但解压/解析失败 → `warnings: ['log-unreadable']`。
     两种情况在 §6 统一回 **404 `session-not-found`**（`params.reason = 'no-log' | 'log-unreadable'`）。
     **不再使用 `log-not-found` 这个 code**（历史上 §2/§6 冲突，现统一以 §6 为准）。

3. **工作区扫描（补充真相）**：
   事件里的工具参数不是全部真相（比如 `python _tmp_probe.py > out.txt`、heredoc 生成的脚本）。
   所以每次请求都要扫一次 workspace 目录（`session.header.cwd`）：
   - 递归列出文件，跳过 `.git`、`node_modules`、`.tmp-*`、`$DSH_HOME` 内部目录；
     完整模式表以 `ledger.mjs` 导出的 `SKIP_DIR_PATTERNS` 为准（C 直接复用，不要各写一份）；
     **不跳** `build/`、`dist/`、`reports/`；**symlink 一律跳过**（不 stat 跟随，避免把 workspace 外文件登记进台账）；
   - 每个文件取 `relPath`（posix 分隔符、相对 cwd）、`size`、`mtime`、`birthtime`；
   - 上限 `maxScanFiles = 600`，超出按 `(mtime desc, relPath 字典序 asc)` 截断——**必须有 relPath tie-break**，
     否则并发采集 + 同 mtime 会让截断边界跨请求抖动，破坏「同样输入逐字节相同」；
   - 扫描失败（目录不存在）→ `warnings` 里记一条，不影响出树。

## 3. `host/ledger.mjs` 的导出（A 实现，C 调用，B 吃 JSON）

```js
// 纯函数，无 IO。输入：
export function buildLedger(input) -> Ledger

// input 形状：
{
  sessionId: string,
  workspacePath: string | null,        // 绝对路径，用于显示与删除；null = 未知
  sessionCreatedAt: number | null,     // ms
  events: Array<{ type, seq, time, data }>,   // 只含 §2 里那几种 type，已按 seq 升序
  scanFiles: Array<{ relPath, size, mtime, birthtime }>,  // 已相对化、已截断
  scanTotal?: number,                  // 可选：截断到 maxScanFiles **之前**的全量文件数；
                                       // 供 workspace.scanned 还原真实规模，缺省回退 scanFiles.length
  overrides: { [relPath]: { cls: 'deliverable'|'process'|'input'|'temp', note?: string } },
  limits?: { maxNodes?: number },      // 默认 4000
  // —— 以下三项为可选增量（A 已实现）；**C 必须显式传**，否则 live 会话会被标成 log：
  generatedAt?: number,                // ms；缺省回退「最后一个事件 time → sessionCreatedAt → 0」，绝不用 Date.now()
  live?: boolean,                      // 缺省 false
  source?: 'live'|'log'                // 缺省 'log'
}
```

同时导出（给单测与 index.js 复用）：

```js
export function extractFileOps(events) -> FileOp[]
// FileOp = { path: string(原始，未相对化), action: 'read'|'write'|'edit'|'delete'|'exec'|'present',
//            tool: string, turn: number, seq: number, time: number }
export function classifyPath(relPath, info) -> { autoCls, reason }   // info 见 §4
export function buildTree({ fileOps, scanFiles, sessionCreatedAt, overrides, limits, turnTimes?, warnings? }) -> { columns, nodes, edges, counts, warnings }
// turnTimes?: Map<number, number>  turn → ms（来自 turn/start），给 turn 列 subtitle 出 HH:mm（本地时间）
// warnings?:   string[]            外部 warning（如 'scan-truncated'/'log-not-found'）透传进结果
```

`buildLedger` = `extractFileOps` + `buildTree` 的组合，负责把绝对路径相对化。

## 4. 分类规则（`autoCls`，可被 overrides 覆盖）

优先级从高到低：

1. **present 过** → `deliverable`
2. 路径命中交付目录名（`deliverables|deliverable|release|final|输出|交付`，整段匹配）→ `deliverable`
3. 命中临时模式 → `temp`，分两层（**v0.1.1 起的防误删分层**）：
   - **显式规则（任何文件都生效）**：
     - basename 以 `_`、`~` 开头，或以 `.tmp/.bak/.old/.orig/.swp/.log` 结尾
     - temp 点文件（`.tmp*`、`.bak`、`.swp`、`.lock`、`._*`、`.DS_Store` …）与 `thumbs.db`/`desktop.ini`
     - **一次性脚本**：`basename ∈ 正则 '^(tmp|temp|probe|debug|scratch|test|check|scan|inspect)[-_]'`
   - **启发式规则（仅当 `touched` 且不在项目目录内才生效，避免误删项目文件）**：
     - basename 含 `tmp|temp|scratch|probe|debug|draft|snapshot|dump|intermediate`（词边界或 `_`/`-`/`.` 分隔）
     - **一次性脚本**：扩展名为 `.py/.ps1/.sh/.mjs/.js/.bat/.cmd` 且路径只在**一个** turn 里被写过、
       且没被任何「过程/交付」文件引用（引用 = 别的工具的 args 里出现过该路径字符串）
     - `touched` = 本 session 写过 / present 过 / 至少出现在一个 turn 里（只被扫描、本会话从未碰过的文件
       不会被名字启发式判成垃圾）
     - **项目目录内**（任一层祖父目录含 `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod` 等 manifest；
       工作区根目录的 manifest 不算）一律不走启发式：仓库自己的 `tools/*.mjs`、`.gitignore`、`.gitattributes`
       永远不会被「一键清理」删掉
   - 目录规则（任何文件都生效）：位于 `.tmp*` / `tmp` / `temp` / `scratch` / `cache` / **`verify`** 目录下
   > 为什么分层：v0.1.0 用「basename 含 dump/以 `.` 开头」一刀切，导致用户在多会话点清理时，
   > `plugins/dsh-session-files/.gitignore`、`.gitattributes`、`tools/layout-dump.mjs` 被移进回收站
   > （见 CHANGELOG 0.1.1）。分层后**配置与项目工具默认安全**，用户仍可手动分类覆盖。
   > 已知限制（A 已确认）：`referencedBy` 只能在同一**次**工具调用内判定
   > （`python helper.py > out.json` 同一行可判）；「先 write 脚本、另一次调用单独执行它」这种跨调用引用
   > 感知不到，会把一次性脚本仍判成 `temp`——v1 接受。
4. 只被读、从未被本 session 写过，且 `birthtime <= sessionCreatedAt` → `input`
5. 被写过 → `process`
6. 其余（扫描发现、无事件）→ `input` if `birthtime <= sessionCreatedAt` else `process`

`info` 形状（classifyPath 第二参，允许缺省字段）：
```js
{ written: boolean, presented: boolean, readOnly: boolean, touchedTurns: number[],
  birthtime?: number, mtime?: number, sessionCreatedAt?: number, referencedBy?: string[],
  projectDir?: boolean }
```

可解释性：每个节点的 `reason` 是**短英文 key**（`presented`/`dir`/`temp-name`/`temp-ext`/`temp-dir`/
`oneday-script`/`readonly-preexisting`/`written`/`scanned-preexisting`/`scanned-new`/`override`），UI 自己翻译。
**override 优先级高于 presented**（用户显式分类压过自动判定），生效时 `reason = 'override'`，`overridden: true`。

## 5. Ledger JSON（对 Client 的 HTTP 响应，**唯一契约**）

`buildLedger` 返回 / `/api/session-files/ledger` 的 `ledger` 字段：

```jsonc
{
  "sessionId": "session-…",
  "workspacePath": "D:\\005agent\\dsh data",   // null = 未知
  "sessionCreatedAt": 1762400000000,
  "generatedAt": 1762400123456,
  "live": true,                                 // 是否来自 live session
  "source": "live" | "log",                     // 数据来源
  "counts": { "deliverable": 2, "process": 7, "input": 12, "temp": 9, "files": 30, "tempMissing": 4 },
  // counts 是**文件级**计数（含没有展开成节点的扫描文件）；nodes 是**可视图**。
  // 两者不相等是正常的，UI 必须分开表述（「工作区 30 个文件 · 树中 12 个节点」）。
  // tempMissing（可选）：temp 记录中「磁盘上已经不存在」的条数（本次最多核对 400 条，
  // 因此它是**下限**而不是精确值）。它解释了一个常见的困惑：面板说「9 个临时文件」而
  // 清理只移走 5 个——剩下 4 个只是历史记账。清理（§6 `/delete`）会清掉这些记录。
  "workspace": {                                 // 可选；仅当存在「未展开的 temp 文件」时出现
    "scanned": 443,                // 本次扫描到的文件总数（**截断到 maxScanFiles 之前**的全量计数）
    "tempPathCount": 180,          // 被判为 temp、但没有出现在 nodes 里的文件数（= tempPaths 去重后总数，含被 500 截断的部分）
    "tempPaths": ["_asar_1.py"],   // 这些文件的相对路径（posix、workspace 相对、不含 .. / 绝对路径），码点序，最多 500 条
    "truncated": false             // tempPathCount > tempPaths.length 时为 true
  },
  "lanes": ["deliverable", "process", "input", "temp"],   // 渲染顺序，从上到下
  "columns": [
    { "id": "input", "kind": "input",   "title": "输入", "subtitle": "会话开始前" },
    { "id": "t1",    "kind": "turn",    "title": "第 1 轮", "subtitle": "10:20", "turn": 1 },
    { "id": "t2",    "kind": "turn",    "title": "第 2 轮", "subtitle": "10:41", "turn": 2 },
    { "id": "final", "kind": "final",   "title": "交付",   "subtitle": "最终产物" }
  ],
  "nodes": [
    {
      "id": "src/a.py#t1",
      "path": "src/a.py",
      "name": "a.py",
      "ext": "py",
      "dir": "src",
      "col": 1,                      // columns 下标
      "lane": "process",             // §0 四道之一（最终分类）
      "cls": "process",              // = lane；保留给 UI 语义
      "autoCls": "process",
      "reason": "written",
      "overridden": false,
      "note": null,                  // string | null
      "exists": true,
      "size": 1234,
      "mtime": 1762400000000,
      "birthtime": 1762400000000,
      "turns": [1],
      "actions": [ { "tool": "write", "action": "write", "turn": 1, "seq": 12, "time": 1762… } ],
      "sources": ["event"],           // "event" | "scan" | "override"
      "kind": "turn"                  // "input" | "turn" | "final"
    }
  ],
  "edges": [
    { "from": "src/a.py#i", "to": "src/a.py#t1", "kind": "origin" },
    { "from": "src/a.py#t1", "to": "src/a.py#t2", "kind": "evolution" },
    { "from": "src/a.py#t1", "to": "out/report.docx#t1", "kind": "derived" },
    { "from": "out/report.docx#t2", "to": "out/report.docx#final", "kind": "deliverable" }
  ],
  "warnings": ["scan-truncated", "log-not-found"]
}
```

规则：
- `nodes[].id` = `${path}#${suffix}`，suffix ∈ `i`（input 列）、`t<turn>`、`final`。同一 path 在
  同一列最多 1 个节点。`nodes` 按 `(col, lane 顺序, path)` 排好序，UI 不用再排。
- `nodes[].exists` 必须来自**磁盘核对**，不能只看「有没有被标记 deleted」：temp 节点若其文件
  已不在工作区（例如被另一次清理移到回收站、或用户自己删了），`exists` 为 `false`，UI 据此
  把该行标灰并显示 `node.gone`。核对只做 temp 道、最多 400 条（`MAX_TEMP_STAT`），其余道沿用
  扫描/事件结论。
- `input` 列的节点只给「preexisting 且未在会话中被写过」的文件（扫描出来的），最多 40 个；
  选取优先级：**先按最终 lane 排序 `input` → `process`，同 lane 内按 mtime 倒序**。
  **最终分类为 `temp` 的 preexisting 文件不进 input 列**——它们是「历史垃圾」，由
  `workspace.tempPaths`（§5 workspace 块）统一承载、在 UI 的「另有 N 个未展开」里列出、
  由 `scope:'all'` 统一清理。理由：输入道要回答「我给了 agent 什么」，不是「这里本来就躺着什么垃圾」。
  被写过的文件不重复出现在 input 列（它的生命线从第一个 turn 开始）。
  **preexisting 判定与 §4 完全一致：`birthtime ?? mtime`（birthtime 缺失时回退 mtime），不许一边回退一边不回退。**
- `workspace.tempPaths` 是「清理」的另一半：这些文件被判为 temp 却因为没有被任何 tool call 触达而没有节点。
  **口径**：按**最终分类**（含 override）判 temp；路径不在 nodes 的 path 集合里；`tempPathCount` 含被截断到 500 条之外的部分。
  `/delete` 的 `scope:"all"` 会同时清理节点里的 temp 和这里的 tempPaths（去重）。
- `final` 列：每个 `deliverable` 路径一个 `#final` 节点（`kind:"final"`，`lane:"deliverable"`），
  即使它最后一次出现在第 N 轮，边 `#tN → #final` 是 `deliverable`。
- `derived` 边：同一 turn 内，A 被 `read`（或 `exec` 引用）且 B 被 `write/edit`，且 A≠B，则
  A#t → B#t；每个写入节点最多 3 条入边，全图 `derived` 边上限 300 条（去重、按 seq 就近）。
- 没有 turn 的会话（events 为空）：只有 `input` + `final` 两列。
- 任何一条边两端节点都必须存在于 `nodes` 里。
- 单文件大小/内容不进 ledger（只有 size/mtime），内容走 `/preview`。

## 6. HTTP 路由（C 实现，B 调用）

前缀 `/api/session-files`。**每个** handler 先跑回环守卫（见 B/C 各自任务里的 session-remover 范式），
失败返回 403 `{ ok:false, code:'forbidden' }`。响应头 `content-type: application/json; charset=utf-8`。
所有错误统一 `{ ok: false, code: string, params?: object }`，**服务端不出自然语言**。

### GET `/api/session-files/ledger?sessionId=<id>`
→ `{ ok: true, ledger: Ledger }`
- `sessionId` 必须匹配 `SESSION_ID_RE`（见 §B 范式）→ 否则 400 `code:'bad-session-id'`
- 既不是 live 又没有日志 → 404 `code:'session-not-found'`

### POST `/api/session-files/classify`
body `{ sessionId, path, cls: 'deliverable'|'process'|'input'|'temp'|null, note?: string }`
→ `{ ok: true, ledger: Ledger }`（`cls: null` = 清除覆盖，回到 autoCls）
- path 必须是 workspace 相对路径，绝对路径/`..` → 400 `code:'bad-path'`

### POST `/api/session-files/delete`
body `{ sessionId, paths?: string[], scope?: 'all'|'tree', dryRun?: boolean }`
→ `{ ok: true, deleted: string[], pruned: string[], skipped: string[], dryRun?: true, ledger: Ledger }`
- 只允许删 `temp` 道的文件（其它道进 `skipped`）；`skipped` 里也可含越界路径。
- **`deleted` 与 `pruned` 分开**：`deleted` = 真正移到回收站的文件；`pruned` = 候选里文件**早已
  不在磁盘**的失效记账，只从 ledger 里忘掉、不动磁盘（因此 `pruned` 可以是「清理成功但删了 0
  个文件」）。两者都为空才算「没有可清理的东西」。
- `scope`（默认 `'all'`）：
  - `'tree'`：只删 `paths` 里给出的、且在 ledger 节点中属于 `temp` 道的文件。
  - `'all'`：`paths`（若有）+ 当前 ledger 里所有 temp 节点 + `ledger.workspace.tempPaths`（去重后统一删）。
    **这是 UI「清理临时文件」主按钮的行为**（含历史遗留的 temp 文件）。
- `dryRun:true` 只返回将要删/剪的列表，不动磁盘、不动记账。
- **剪枝语义**：被剪掉的路径写入 `$DSH_HOME/session-files/gone/<sessionId>.json`
  （`{version:1, sessionId, paths:[]}`，上限 20000 条），重建 ledger 时据此丢弃同名旧记账；
  若该文件**又回到**工作区且被扫描/事件重新记录，则以新记录为准（剪枝只对「无新证据」的记录生效）。
- **删除 = 移动到回收站**：`$DSH_HOME/session-files/trash/<sessionId>/<epochMs>/<relPath>`，
  返回的 `deleted` 是原相对路径。不 `fs.rm`。

### POST `/api/session-files/reveal`
body `{ sessionId, path }`
→ `{ ok: true, path, exists: boolean, isDirectory: boolean }`
- 在系统文件管理器里定位 `path`：Windows `explorer.exe /select,"<abs>"`、macOS `open -R <abs>`、
  其它平台打开父目录。
- **Windows 上必须自己拼命令行并用 `shell: true`**：把 `'/select,' + path` 当作 argv 交给 `spawn()`
  时，libuv 会把整个 token 重新加引号（`"/select,D:\dir with spaces\f.docx"`），Explorer 解析失败后
  会退回默认目录（文档）——用户看到的现象就是「点了却打开『文档』」。
- 文件已不在磁盘（`exists:false`）时改为打开其父目录；父目录也不存在则回退到工作区根目录。
- 错误码：`bad-path` 400、`no-workspace` 404、`reveal-failed` 500（连进程都起不来）。
- **预览错误码**：`file-not-found` 表示该记录对应的文件已不在工作区（多为清理到回收站），客户端应显示
  「文件已不在工作区」而不是「Host 未就绪」；其它错误码才提示 Host 需要重启。

### GET `/api/session-files/preview?sessionId=<id>&path=<relPath>&maxBytes=65536`
→ `{ ok: true, path, text, truncated: boolean, bytes: number, binary: boolean }`
- **`binary` 恒带**（文本时为 `false`）。
- 二进制（含 NUL 或非 UTF-8 解码失败）→ `{ ok:true, path, text:"", binary:true, bytes }`

## 7. 文案（B 用；zh 为默认）

下表是**最小集合**：client.js 的 DICT 可以增补键（reason.*/edge.*/toast.*/stats.* 等），但必须 zh/en 同步；
`locale/{zh,en}.json` 只放 `meta.title/description`（插件市场卡片用），界面文案不进 locale 文件。

| key | zh | en |
| --- | --- | --- |
| title | 会话文件树 | Session file tree |
| lane.deliverable | 交付 | Deliverable |
| lane.process | 过程 | Process |
| lane.input | 输入 | Input |
| lane.temp | 临时 | Temp |
| btn.open | 文件树 | File tree |
| action.refresh | 刷新 | Refresh |
| action.cleanup | 清理全部临时文件 | Clean up all temp files |
| action.delete | 删除 | Delete |
| action.save | 保存 | Save |
| action.reset | 恢复自动分类 | Auto |
| confirm.delete | 把 N 个文件移到回收站？ | Move N files to trash? |
| empty | 这个会话还没有产生文件 | No files yet in this session |
| loading | 正在读取会话文件… | Reading session files… |
| error.network | 读取失败：Host 半未生效或需要重启 DSH | Failed: host half not live (restart DSH?) |
| note.ph | 备注… | Note… |

## 8. Agent 工具 `session_files`（C 实现，遵守 user-actions 规范：与 HTTP 路由共用同一批 Host 方法）

参数 schema：
```jsonc
{
  "type": "object",
  "properties": {
    "action":   { "type": "string", "enum": ["list", "classify", "cleanup"] },
    "paths":    { "type": "array", "items": { "type": "string" } },
    "cls":      { "type": "string", "enum": ["deliverable", "process", "input", "temp"] },
    "note":     { "type": "string" },
    "dryRun":   { "type": "boolean" }
  },
  "required": ["action"]
}
```
- `list`：返回本 session 文件台账的紧凑文本表（分道、路径、size、轮次、reason）。≤ 120 行。
- `classify`：给 `paths` 打 `cls`（`note` 可选）。
- `cleanup`：默认 `scope:'all'` —— 把 `paths` 里属于 `temp` 的、当前 ledger 里全部 `temp` 节点、以及 `ledger.workspace.tempPaths`（被判 temp 但没有节点的扫描文件，去重）一起移到回收站，返回删除清单与 `workspaceRemaining`。`dryRun:true` 只报将删列表、不动磁盘。
- 结果 `value` 用 `{ ok, action, summary, ledger? }`；`ledger` 允许裁剪为
  `{ sessionId, workspacePath, live, source, counts, warnings? }`（agent 不需要 nodes/edges，省 token）；
  `output.render` 输出一段 text ContentBlock。`dryRun` 只对 `cleanup` 生效，`list`/`classify` 收到时忽略（不报错）。
- sessionId 取自 `exec.agent.id`。
- 工具描述里要写清：**任务收尾时调用 `action:"list"`，把一次性探针脚本标成 temp 并 cleanup**。

## 9. 系统提示词（C 实现）

`ctx.systemPrompt.section({ name: 'session-files', order: 40, text })`，text 短（≤5 行）：
说明本插件存在、临时脚本要标 temp、交付文件用 present、收尾时清理。
用 `ctx.effect(...)` 包注册。

## 10. 存储（C 实现）

- 覆盖/备注：`$DSH_HOME/session-files/overrides/<sessionId>.json`
  `{ "version": 1, "sessionId": "...", "files": { "<relPath>": { "cls": "temp", "note": "…", "updatedAt": 1762 } } }`
- 回收站：`$DSH_HOME/session-files/trash/<sessionId>/<epochMs>/<relPath>`
- 剪枝记账：`$DSH_HOME/session-files/gone/<sessionId>.json`
  `{ "version": 1, "sessionId": "...", "paths": ["verify/dbg.py", "…"] }`（上限 20000 条，超出丢最旧的）
  语义：这些路径的旧 ledger 记录已被清理命令确认失效，重建 ledger 时不再展示；文件若重新出现并被记录，以新记录为准。
- 写文件要原子（tmp 文件 + rename），并发写用串行队列；读失败一律降级为空。
- **不要**把状态写到 workspace 里（那正是用户抱怨的污染源）。
