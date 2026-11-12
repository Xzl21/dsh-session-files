import fs from "node:fs";
const auth = JSON.parse(fs.readFileSync(process.env.DSH_HOME + "/.dsh-gitdeck/auth.json", "utf8"));
const tgz = fs.readFileSync(".push/dsh-session-files-0.1.4.tgz");
const releaseId = 443183847;
const name = "dsh-session-files-0.1.4.tgz";
const boundary = "----dshpublish" + Date.now();
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n${name}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/gzip\r\n\r\n`,
);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
const body = Buffer.concat([head, tgz, tail]);
const res = await fetch(`https://uploads.github.com/repos/Xzl21/dsh-session-files/releases/${releaseId}/assets?name=${name}`, {
  method: "POST",
  headers: { authorization: `Bearer ${auth.token}`, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length), "user-agent": "x" },
  body,
});
console.log("status", res.status);
const j = await res.json();
console.log("asset", j.name, j.size, j.browser_download_url || j.message);
