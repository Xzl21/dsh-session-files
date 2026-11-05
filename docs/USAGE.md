# 使用说明

本文覆盖：界面上怎么用、agent 怎么用、HTTP 接口长什么样、数据存在哪里、出问题怎么排查。
实现契约（字段级）见仓库根目录 [CONTRACT.md](../CONTRACT.md)。

## 1. 界面

### 打开

会话输入框右侧、发送按钮左边有一个「文件树」图标按钮：

- 按钮显示当前会话是否已被插件接管；点一下打开**全屏画布**。
- 提示词里若提示「Host 半未生效」，说明插件 host 半没加载（通常是装完没重启 DSH 进程）。

### 读懂画布

| 区域 | 含义 |
| --- | --- |
| 顶部状态带 | 左侧是**文件级**统计：工作区扫描总数 + 交付/过程/输入/临时四类计数；右侧是**可视图**：树里实际画出的节点数。两者不等是正常的。 |
| 左侧道标签 | 四条道：交付 / 过程 / 输入 / 临时，带该类在树中的节点数，可点击折叠/隐藏（隐藏后该道压缩成 44px）。 |
| 列头 | `输入`（会话开始前）+ 每一轮（带开始时间）+ `交付`（最终产物）。列数由会话轮次决定。 |
| 卡片 | 文件名、动作（read/write/edit/exec/present/delete）、体积、判定原因、备注、徽章（`最终`=deliverable、`手动`=你改过分类、`已删除`=磁盘上已不存在）。 |
| 连线 | 灰=dérived（同轮读→写）、紫虚线=evolution（同一路径跨轮演化）、蓝=deliverable（present 到最终列）、灰虚线=origin（input 列来源）。 |
| 底部图例 | 四道颜色 + 连线含义。 |

### 常用操作

| 想要 | 怎么做 |
| --- | --- |
| 缩放 | 底部/工具栏 `+` `-`，范围 0.4×–2×，或滚轮。 |
| 看文件内容 | 点卡片 → 右侧抽屉显示预览（文本截断到 64KB；二进制只显示体积）。 |
| 改分类 | 抽屉里选一个道 → 立即保存并重绘；`恢复自动分类` 回到自动判定。 |
| 写备注 | 抽屉底部输入框，保存后卡片上会显示，便于「这个为什么留」。 |
| 看没画出来的垃圾 | 状态带旁的虚线 chip「另有 N 个未展开」→ 弹层列出路径（最多 20 条 + 总数）。 |
| 清理临时文件 | 顶部「清理全部临时文件」→ 先 dryRun 弹确认（列出权威数量）→ 确认后才移动。 |
| 收起 | `Esc` 或点击遮罩/关闭按钮。 |

### 分类规则（自动判定的依据）

- **输入**：扫描时已存在（`birthtime ?? mtime` ≤ 会话创建时间）且会话中没被写过。
- **交付**：被 `present` 工具交付过，或命中最终产物目录/扩展名规则。
- **过程**：会话中被 write/edit 产生的、非一次性中间物（文档/数据/图片等）。
- **临时**：`_tmp*`/`.tmp*`/`debug.log`/`*.bak`/`verify/` 等一次性脚本、日志、转储、验证产物，以及名字带 `one-day-script` 特征的单次脚本。

任何手动 override 都优先于自动判定，并且按会话持久化。

## 2. 给 agent 用（`session_files` 工具）

安装后 agent 会自动拿到这个工具和 4 行系统提示词。典型用法：

```text
# 看这个会话留下了什么（表格：道 / 路径 / 体积 / 轮次 / 判定原因）
session_files { "action": "list" }

# 把一次性探针标记成临时（可批量，≤200 条；note 可选）
session_files { "action": "classify", "paths": ["_probe.py", "verify/"], "cls": "temp", "note": "一次性探针" }

# 先看会清掉什么（不动磁盘）
session_files { "action": "cleanup", "dryRun": true }

# 真正清理：paths 省略 = 清掉本会话所有 temp（含树里没画出的历史垃圾）
session_files { "action": "cleanup" }
```

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `list` \| `classify` \| `cleanup` | 必填 |
| `paths` | `string[]` | workspace 相对路径（posix）。`classify` 必填；`cleanup` 可选（省略=全部 temp） |
| `cls` | `deliverable` \| `process` \| `input` \| `temp` | `classify` 必填 |
| `note` | `string` | 可选备注 |
| `dryRun` | `boolean` | 仅 `cleanup` 生效 |

返回值（`output.schema`）：`{ ok, action, summary, ledger? }`，`ledger` 是裁剪版（只含 `sessionId/workspacePath/live/source/counts`），完整台账走 HTTP。

> 工具 body 必须返回**裸 value**，不是 `{ isError, value, content }` 信封——这是 dsh-tools 的硬约束，前面踩过这个坑（报 `missing required property "value.ok"`），回归测试已覆盖。

## 3. HTTP 接口

全部前缀 `/api/session-files`，仅在回环地址可达（Host 头必须是 localhost/127.x/[::1]，跨站请求被拒），错误统一 `{ ok:false, code, params? }`。

### `GET /api/session-files/ledger?sessionId=<id>`

→ `{ ok:true, ledger: Ledger }`。`ledger` 字段见 CONTRACT.md §5（`counts`、`columns`、`nodes`、`edges`、可选 `workspace`、`warnings`）。

### `POST /api/session-files/classify`

```jsonc
{ "sessionId": "session-…", "path": "verify/run.py", "cls": "temp", "note": "一次性" }
```

- `cls` 三态：省略 = 保留现有 override；`null` = 清除 override 回到自动；字符串 = 设置。
- → `{ ok:true, ledger }`；路径越界 → 400 `bad-path`。

### `POST /api/session-files/delete`

```jsonc
{ "sessionId": "session-…", "paths": ["a.py"], "scope": "all", "dryRun": true }
```

- `scope`：`"tree"` = 只删 `paths` 里且属 temp 的；`"all"`（默认）= `paths` ∪ 所有 temp 节点 ∪ `workspace.tempPaths`。
- `dryRun:true` 只返回清单，不动磁盘。
- → `{ ok:true, deleted:[], skipped:[], ledger, dryRun? }`。

### `GET /api/session-files/preview?sessionId=<id>&path=<relPath>&maxBytes=65536`

→ `{ ok:true, path, text, truncated, binary, bytes }`，`binary` 恒带。

## 4. 数据存在哪里

| 内容 | 路径 |
| --- | --- |
| 分类覆盖 + 备注 | `$DSH_HOME/session-files/overrides/<sessionId>.json`（原子写，串行队列） |
| 回收站 | `$DSH_HOME/session-files/trash/<sessionId>/<epochMs>/<相对路径>` |
| 会话事件真相 | `$DSH_HOME/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd`（只读） |

想彻底重置某个会话的标注：删掉对应 `overrides/<sessionId>.json`。想还原清理掉的文件：从 trash 目录拷回去。

## 5. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 按钮不出现 | 页面没刷新（F5）；或插件未启用（`plugin_manager action=list_plugins` 查 `include:session-files`）。 |
| 打开树提示「Host 半未生效或需要重启 DSH」 | host 半代码改过但没重启 DSH 进程；Node 会缓存 ESM 模块。 |
| 树是空的但工作区明明有文件 | 树只画本会话触碰过的文件；历史垃圾在「另有 N 个未展开」里。 |
| 交付列为空 | 该会话没有用 `present` 交付过文件（不是 bug）。 |
| 清理数量与预期不符 | 先 `dryRun` 看 `deleted` 与 `skipped`；`skipped` 里通常是「不是 temp」「已不存在」「越界」三类。 |
| 日志读不出来 | `warnings` 里会出现 `log-missing` / `log-unreadable`，此时只能靠工作区扫描给出部分信息。 |
