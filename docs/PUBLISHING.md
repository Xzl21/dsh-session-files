# 发布与上架

结论先说：**DSH 插件没有「直接上传到市场」的接口**。dshmarket（市场应用）只是**读者**，它每次打开都实时拉取精选目录 `https://awesome-dsh-plugin.com/plugins.json`；而这个目录的唯一投稿入口是向 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库提一个 **新增 YAML 文件**的 PR。市场安装接口甚至会硬性拒绝目录外的条目（`dshmarket/lib/routes.js:6482-6488`：`"plugin is not in the curated registry"`）。

所以路线是：**GitHub 仓库 →（可选）Release tarball / npm 包 → 提交 awesome-dsh-plugin PR → 次日生效**。

## 0. 前提（本仓库已满足）

- 仓库根 `package.json` 声明了 `dsh.bundle.patch`（`./cordis.patch.yml`，文件存在且内容为 `- insert: [{id: session-files, name: dsh-session-files}]`）——**这是「可安装」的判定条件**，只声明 `dsh.client` 的仓库会被拒。
- `cordis.patch.yml` 里的 `name` 必须与 `package.json` 的 `name` 完全一致（改包名 = 改这里 + 重新安装）。
- 仓库根有 `screenshots.json`（1–8 张相对路径，不能跳出插件目录），目录站点会用它做展示。
- 仓库要有真的可运行代码（不是占位/只有 README）。
- 仓库**年龄 ≥ 1 天**（CI 自动检查），并加 `dsh-plugin` topic。

## 1. 建仓库并推送

GitHub 上新建空仓库 `dsh-session-files`（**不要**勾 README / .gitignore / license），然后：

```bash
git remote add origin https://github.com/<owner>/dsh-session-files.git   # 已配好 Xzl21
git push -u origin main
git push origin v0.1.0
```

仓库必须是**公开**的：目录 CI 要匿名读 `package.json`。

### 1.1 推不上去时：走 REST API 直推（本机就是这种情况）

本机 `github.com:443`（git smart HTTP）会被重置，但 `api.github.com` 可达，所以提供两条脚本：

```powershell
# 只推「当前 HEAD 的树」作为远端 main 上的一个新提交；远端已一致时不做事
node tools/publish.mjs Xzl21/dsh-session-files

# 需要带 tag 时
node tools/publish.mjs Xzl21/dsh-session-files --tag v0.1.4

# 先看要做什么
node tools/publish.mjs Xzl21/dsh-session-files --dry-run
```

- token 来源顺序：`--token` → `$env:GH_TOKEN` → `$env:GH_OAUTH_TOKEN` → `%DSH_HOME%/.dsh-gitdeck/auth.json`（dsh-gitdeck 连接后自动写入，0600）。
- 首次建仓用 `tools/publish-history.mjs`（逐条重放本地历史，能复现相同 tree；commit SHA 因平台序列化差异可能不同）。
- 直推脚本产生的提交与服务端的对象一致，之后在任何能联网 `git push` 的机器上先 `git fetch origin && git reset --hard origin/main` 即可对齐本地。

## 2. 本地自测（确认别人装得上）

```text
plugin_manager action=install_bundle target=github:Xzl21/dsh-session-files
```

或自己机器上用 link：

```text
plugin_manager action=install_bundle target=D:\...\dsh-session-files
```

装完确认：系统提示词出现 `[session-files]`、工具里有 `session_files`、插件列表 `include:session-files` 为 `active`。

## 3. 打包 tarball 挂 Release（可选，推荐）

目录条目的安装源优先级：**npm 包 → 同仓库 GitHub Release 的 `.tgz` → `github:owner/repo` 源码装**。发 tarball 可以让别人跳过构建审批、装得更快。

```bash
# 本机没有 npm，用 DSH 自带 pnpm：
NODE="C:/Users/xzl/AppData/Local/Programs/DSH NEXT/resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe"
PNPM="C:/Users/xzl/AppData/Local/Programs/DSH NEXT/resources/runtime/x64/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
"$NODE" "$PNPM" pack          # 产出 dsh-session-files-0.1.0.tgz
```

把产物**重命名成不带版本号的文件名**（`dsh-session-files.tgz`）再挂到 GitHub Release，并在条目里写：

```yaml
tarball: https://github.com/Xzl21/dsh-session-files/releases/latest/download/dsh-session-files.tgz
```

> 文件名带版本号 = 你下次发版就 404，所以一定要去掉版本号。

## 4. npm 包（可选）

- ⚠️ npm 上的 `dsh-session-files` **已被他人占用**（占位包 `0.0.0-stage`），原名发不了。
- 要发就发作用域包：`@xzl21/dsh-session-files`。**但**：`package.json` 的 `name` 改了，`cordis.patch.yml` 的 `name` 也必须同步改，然后重新 `install_bundle`——属于一次破坏性变更，建议作为 `0.2.0` 再做。
- `npm` 映射由目录 CI 自动从 registry 的 `repository` 字段关联（本仓库已指向 GitHub），**YAML 里不要手写 `npm:` 键**，会被拒。
- 有 peer 依赖时范围要写显式的 prerelease 分支（如 `">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"`），否则会静默排除所有预发布 harness 版本。本插件目前无 peer 依赖。

## 5. 提交精选目录 PR（满 1 天后）

在 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库新增 **一个文件**：`data/plugins/Xzl21__dsh-session-files.yml`

```yaml
url: https://github.com/Xzl21/dsh-session-files
name: Xzl21/dsh-session-files
category: session
tarball: https://github.com/Xzl21/dsh-session-files/releases/latest/download/dsh-session-files.tgz
icon: https://raw.githubusercontent.com/Xzl21/dsh-session-files/main/assets/icon-180.png
description:
  en: "Per-session file tree: ..."
  zh: "按会话展开的文件树：..."
# 注意：不要写 npm: 键
```

（`icon` 只收 GitHub 托管的**位图**；本仓库的 `assets/icon-180.png` 就是 180px PNG。`description` 里出现 `": "` 必须加引号，否则 YAML 会解析成嵌套键。）

PR 规则：每 PR 最多 3 条、描述必须准确（维护者会读代码核对）、只允许新增那一个 YAML 文件。合并后站点与 dshmarket 次日自动收录。
可选：本地重载市场插件，用 `DSHM_REGISTRY_URL` 指向自建镜像做验证。

### 已提交的 PR

- **#14760** — https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14760 （2026-11-13 提交，CI 跑 `check`，合并后次日进入 `plugins.json`）
  - 分支在 fork `Xzl21/awesome-dsh-plugin` 的 `add-session-files`；后续要改条目，改 fork 分支上的同一个文件即可，PR 会自动更新。
  - 因为本机 `git push` 到 github.com 会被重置，Fork/建分支/写文件/开 PR 全部走 REST API（`api.github.com` 可达）。


## 6. 后续发版

1. 改代码 + 测试全绿。
2. `CHANGELOG.md` 加条目，`package.json` 升版本（语义化）。
3. `node tools/publish.mjs Xzl21/dsh-session-files --tag vA.B.C`（本机只能走 REST API；换一台能 `git push` 的机器则用 `git push && git push --tags`）。
4. 打 tarball 挂到新 Release，**asset 名固定为 `dsh-session-files.tgz`**（覆盖式命名，条目里的 `latest/download/` 才不会 404）：

   ```powershell
   $NODE="C:/Users/xzl/AppData/Local/Programs/DSH NEXT/resources/runtime/x64/primary-runtime/dependencies/node/bin/node.exe"
   $PNPM="C:/Users/xzl/AppData/Local/Programs/DSH NEXT/resources/runtime/x64/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
   & $NODE $PNPM pack --pack-destination .push
   # 把 .push\dsh-session-files-A.B.C.tgz 作为 asset 名 dsh-session-files.tgz 上传到该 Release
   ```
5. 目录条目不需要再改（`url` 与 `tarball` 都不变，站点自己刷新版本/star）。
6. 本地装的是当前 profile 的 junction 安装，改完源码**重启 DSH**即可生效，不需要重新 `install_bundle`。

### 发布记录

| 版本 | 日期 | 发布内容 |
| --- | --- | --- |
| 0.1.4 | 2026-11-13 | 回收站面板 + 可选保留期自动清理；Release `v0.1.4`（asset `dsh-session-files.tgz`）；目录 PR #14760 |
| 0.1.3 | 2026-11-12 | 打开所在文件夹、预览错误提示更诚实 |
| 0.1.2 | 2026-11-12 | 清理前磁盘核对，消除「说有 178 个却清不动」 |
| 0.1.1 | 2026-11-11 | 修误删项目文件（plumbing 白名单 + 分层判定） |
| 0.1.0 | 2026-11-11 | 首个版本：会话文件树 + 四道分类 + 可恢复清理 |


## 7. 参考出处

- `dshmarket` README（中文）`C:\Users\xzl\.dsh\profiles\desktop\node_modules\dshmarket\README.zh.md:116-134`：「这个仓库是市场应用本身，不是插件目录」。
- `dshmarket/lib/regions.js:70`：`CATALOG_OFFICIAL = 'https://awesome-dsh-plugin.com/plugins.json'`。
- `dshmarket/lib/routes.js:6482-6488`：安装强制「条目必须在精选目录中」。
- `dshmarket/lib/sources.js:506-528`：安装源优先级与 `github:owner/repo[#path:/subpath]` 解析。
- `awesome-dsh-plugin/awesome-dsh-plugin:contributing.md`：一插件一 YAML、`dsh.bundle` 硬要求、仓库 ≥1 天、`dsh-plugin` topic。
