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
category: ui
description:
  en: Per-session file tree that shows every file a session touched, split into deliverable, process, input and temp lanes, with recoverable one-click cleanup.
  zh: 按会话展示 agent 碰过的所有文件，按交付/过程/输入/临时四道铺成从左到右的树，并支持可恢复的一键清理。
icon: https://raw.githubusercontent.com/Xzl21/dsh-session-files/main/assets/icon-180.png
tarball: https://github.com/Xzl21/dsh-session-files/releases/latest/download/dsh-session-files.tgz
# 注意：不要写 npm: 键
```

（`icon` 只收 GitHub 托管的**位图**，需要 180px PNG；本仓库暂时只有 `icon.svg`，可以先不放 `icon` 行，或自己导一张 180×180 PNG 放到 `assets/icon-180.png`。）

PR 规则：每 PR 最多 3 条、描述必须准确（维护者会读代码核对）、只允许新增那一个 YAML 文件。合并后站点与 dshmarket 次日自动收录。
可选：本地重载市场插件，用 `DSHM_REGISTRY_URL` 指向自建镜像做验证。

## 6. 后续发版

1. 改代码 + 测试全绿。
2. `CHANGELOG.md` 加条目，`package.json` 升版本（语义化）。
3. `git commit && git tag vA.B.C && git push && git push --tags`。
4. 重新打 tarball 挂 Release（文件名不带版本号，覆盖同一个 asset 名）。
5. 目录条目不需要再改（url 不变，站点自己刷新版本/star）。

## 7. 参考出处

- `dshmarket` README（中文）`C:\Users\xzl\.dsh\profiles\desktop\node_modules\dshmarket\README.zh.md:116-134`：「这个仓库是市场应用本身，不是插件目录」。
- `dshmarket/lib/regions.js:70`：`CATALOG_OFFICIAL = 'https://awesome-dsh-plugin.com/plugins.json'`。
- `dshmarket/lib/routes.js:6482-6488`：安装强制「条目必须在精选目录中」。
- `dshmarket/lib/sources.js:506-528`：安装源优先级与 `github:owner/repo[#path:/subpath]` 解析。
- `awesome-dsh-plugin/awesome-dsh-plugin:contributing.md`：一插件一 YAML、`dsh.bundle` 硬要求、仓库 ≥1 天、`dsh-plugin` topic。
