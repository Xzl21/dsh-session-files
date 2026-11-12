import fs from "node:fs";
const auth = JSON.parse(fs.readFileSync(process.env.DSH_HOME + "/.dsh-gitdeck/auth.json", "utf8"));
const token = auth.token;
const H = { authorization: `Bearer ${token}`, "user-agent": "x" };
const tgz = fs.readFileSync(".push/dsh-session-files-0.1.4.tgz");
const name = "dsh-session-files.tgz";
const boundary = "----dshpublish" + Date.now();
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n${name}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/gzip\r\n\r\n`,
);
const body = Buffer.concat([head, tgz, Buffer.from(`\r\n--${boundary}--\r\n`)]);
const up = await fetch("https://uploads.github.com/repos/Xzl21/dsh-session-files/releases/443183847/assets?name=" + name, {
  method: "POST",
  headers: { ...H, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
  body,
});
const upJson = await up.json();
console.log("asset", up.status, upJson.name, upJson.size, upJson.browser_download_url || upJson.message);

// update catalog entry to the stable latest/download URL
const url = "https://raw.githubusercontent.com/Xzl21/awesome-dsh-plugin/add-session-files/data/plugins/Xzl21__dsh-session-files.yml";
const cur = await (await fetch("https://api.github.com/repos/Xzl21/awesome-dsh-plugin/contents/data/plugins/Xzl21__dsh-session-files.yml?ref=add-session-files", { headers: { ...H, accept: "application/vnd.github+json" } })).json();
const text = Buffer.from(cur.content, "base64").toString("utf8");
const next = text.replace(/^tarball: .*$/m, "tarball: https://github.com/Xzl21/dsh-session-files/releases/latest/download/dsh-session-files.tgz");
const put = await fetch("https://api.github.com/repos/Xzl21/awesome-dsh-plugin/contents/data/plugins/Xzl21__dsh-session-files.yml", {
  method: "PUT",
  headers: { ...H, "content-type": "application/json", accept: "application/vnd.github+json" },
  body: JSON.stringify({ message: "Use the unversioned release asset for the tarball", content: Buffer.from(next, "utf8").toString("base64"), branch: "add-session-files", sha: cur.sha }),
});
const putJson = await put.json();
console.log("yml update", put.status, putJson.commit ? putJson.commit.sha.slice(0, 8) : putJson.message);
console.log(next.split("\n")[3]);
