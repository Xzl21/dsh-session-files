import fs from "node:fs";
const auth = JSON.parse(fs.readFileSync(process.env.DSH_HOME + "/.dsh-gitdeck/auth.json", "utf8"));
const yml = [
  "url: https://github.com/Xzl21/dsh-session-files",
  "name: Xzl21/dsh-session-files",
  "category: session",
  "tarball: https://github.com/Xzl21/dsh-session-files/releases/download/v0.1.4/dsh-session-files-0.1.4.tgz",
  "icon: https://raw.githubusercontent.com/Xzl21/dsh-session-files/main/assets/icon-180.png",
  "description:",
  '  zh: "按会话展开的文件树：把一次对话碰过的文件按轮次排成从左到右的列，分成交付、过程、输入、临时四道；点击卡片可预览、改分类、写备注；临时文件可一键移入可恢复的回收站，回收站支持整批或单文件恢复、清空整批，以及可选的按天数自动清理。另带 session_files 工具，让 agent 可以自己收拾。"',
  '  en: "Per-session file tree: every file a conversation touched, laid out left-to-right by turn and split into deliverable, process, input and temp lanes; click a card to preview, reclassify or annotate. Temp files move into a recoverable trash with batch or single-file restore, batch emptying and an optional retention window. Ships a session_files tool so the agent can tidy up itself."',
  "",
].join("\n");
const dest = ".push/Xzl21__dsh-session-files.yml";
fs.writeFileSync(dest, yml, "utf8");
const res = await fetch("https://api.github.com/repos/Xzl21/awesome-dsh-plugin/contents/data/plugins/Xzl21__dsh-session-files.yml", {
  method: "PUT",
  headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json", "user-agent": "x", accept: "application/vnd.github+json" },
  body: JSON.stringify({
    message: "Add Xzl21/dsh-session-files (session file tree with recoverable trash)",
    content: Buffer.from(yml, "utf8").toString("base64"),
    branch: "add-session-files",
  }),
});
console.log("status", res.status);
const j = await res.json();
console.log(j.commit ? "commit " + j.commit.sha : JSON.stringify(j).slice(0, 400));
