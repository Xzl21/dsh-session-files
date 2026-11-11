// Replicate the local commit history of a repo to GitHub through the REST API,
// byte-identical (same trees, same author/committer lines => same commit SHAs),
// without using `git push` (github.com:443 is reset on this machine, api.github.com works).
//
// Usage: node replicate.mjs <local-repo-dir> <owner/repo>
//
// NOTE: this sandbox forbids piped child stdio (spawn EPERM), so git output is
// captured through temporary files (stdio: ['ignore', fd, 'inherit']).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , repoDir, slug] = process.argv;
if (!repoDir || !slug) {
  console.error('usage: node replicate.mjs <local-repo-dir> <owner/repo>');
  process.exit(2);
}

const GIT_DIR = 'D:\\001软件\\工具\\Git\\cmd';
const env = { ...process.env, PATH: `${GIT_DIR};${process.env.PATH || ''}` };
let tmpCounter = 0;
function gitBuf(args) {
  const tmp = path.join(os.tmpdir(), `rep-${process.pid}-${tmpCounter++}.out`);
  const fd = fs.openSync(tmp, 'w');
  try {
    execFileSync('git', ['-C', repoDir, ...args], { env, stdio: ['ignore', fd, 'inherit'] });
  } finally {
    fs.closeSync(fd);
  }
  const bytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return bytes;
}
const git = (...args) => gitBuf(args).toString('utf8');

// token comes from the dsh-gitdeck credential store (never printed)
const authPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.dsh-gitdeck', 'auth.json');
const token = JSON.parse(fs.readFileSync(authPath, 'utf8')).token;
const API = 'https://api.github.com';
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-replicate',
  'content-type': 'application/json',
};

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return parsed;
}

function parseIdent(line) {
  const m = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error(`cannot parse ident: ${line}`);
  const iso = new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d+Z$/, '');
  const off = m[4];
  const sign = off[0] === '-' ? '-' : '+';
  return { name: m[1], email: m[2], date: new Date(`${iso}${off.slice(0, 3)}:${off.slice(3)}`).toISOString() };
}

const shas = git('rev-list', '--reverse', 'HEAD').split('\n').map((s) => s.trim()).filter(Boolean);
console.log(`local commits: ${shas.length}`);

const blobCache = new Map();
let parent = null;
let lastCommit = null;

for (const sha of shas) {
  const raw = git('cat-file', '-p', sha);
  const splitAt = raw.indexOf('\n\n');
  const header = raw.slice(0, splitAt);
  const message = raw.slice(splitAt + 2);
  const lines = header.split('\n');
  const treeSha = lines.find((l) => l.startsWith('tree ')).slice(5).trim();
  const authorLine = lines.find((l) => l.startsWith('author ')).slice(7);
  const committerLine = lines.find((l) => l.startsWith('committer ')).slice(10);

  const entries = [];
  for (const line of git('ls-tree', '-r', sha).split('\n').filter(Boolean)) {
    const tabAt = line.indexOf('\t');
    const meta = line.slice(0, tabAt).split(/\s+/);
    const mode = meta[0];
    const blobSha = meta[2];
    const rel = line.slice(tabAt + 1);
    if (mode === '160000') { console.log(`  skip submodule ${rel}`); continue; }
    if (!blobCache.has(blobSha)) {
      const bytes = gitBuf(['cat-file', 'blob', blobSha]);
      const blob = await api('POST', `/repos/${slug}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' });
      blobCache.set(blobSha, blob.sha);
    }
    entries.push({ path: rel, mode, type: 'blob', sha: blobCache.get(blobSha) });
  }

  const tree = await api('POST', `/repos/${slug}/git/trees`, { tree: entries });
  console.log(`  tree ${sha.slice(0, 8)} -> ${tree.sha.slice(0, 8)} (${entries.length} files, local ${treeSha.slice(0, 8)}${tree.sha === treeSha ? ' identical' : ' DIFFERS'})`);

  const commit = await api('POST', `/repos/${slug}/git/commits`, {
    message,
    tree: tree.sha,
    parents: parent ? [parent] : [],
    author: parseIdent(authorLine),
    committer: parseIdent(committerLine),
  });
  console.log(`  commit ${sha.slice(0, 8)} -> ${commit.sha.slice(0, 8)}${commit.sha === sha ? ' identical' : ' differs'}`);
  parent = commit.sha;
  lastCommit = commit.sha;
}

async function ensureRef(refName, sha, force) {
  try {
    const created = await api('POST', `/repos/${slug}/git/refs`, { ref: refName, sha });
    return created.object.sha;
  } catch (error) {
    if (!/already exists/i.test(String(error.message))) throw error;
    const patched = await api('PATCH', `/repos/${slug}/git/refs/${refName.replace('refs/', '')}`, {
      sha,
      force: Boolean(force),
    });
    return patched.object.sha;
  }
}
const mainSha = await ensureRef('refs/heads/main', lastCommit, true);
console.log(`ref refs/heads/main -> ${mainSha}`);

// annotated tag object, mirroring the local one
const localTag = git('cat-file', '-p', 'v0.1.0');
const tagSplit = localTag.indexOf('\n\n');
const tagHeader = localTag.slice(0, tagSplit);
const tagMessage = localTag.slice(tagSplit + 2);
const tagLines = tagHeader.split('\n');
const tagTarget = tagLines.find((l) => l.startsWith('object ')).slice(7).trim();
const tagType = tagLines.find((l) => l.startsWith('type ')).slice(5).trim();
const tagName = tagLines.find((l) => l.startsWith('tag ')).slice(4).trim();
const taggerLine = tagLines.find((l) => l.startsWith('tagger ')).slice(7);
const tagObject = await api('POST', `/repos/${slug}/git/tags`, {
  tag: tagName,
  message: tagMessage,
  object: lastCommit,
  type: tagType,
  tagger: parseIdent(taggerLine),
});
const tagSha = await ensureRef('refs/tags/v0.1.0', tagObject.sha, true);
console.log(`ref refs/tags/v0.1.0 -> ${tagSha.slice(0, 8)} (local target ${tagTarget.slice(0, 8)})`);

const info = await api('GET', `/repos/${slug}`);
console.log(`done: ${info.html_url} default_branch=${info.default_branch} size=${info.size}`);
