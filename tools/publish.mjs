#!/usr/bin/env node
// Publish the committed HEAD of a local git repository to GitHub through the REST API,
// for machines where `git push` cannot reach github.com:443 (git smart HTTP) but
// api.github.com is reachable.
//
// Unlike `tools/publish-history.mjs` (which replays the whole history to reproduce SHAs),
// this script only appends ONE commit on top of the remote branch with the local HEAD tree.
// Run it after every local commit; it is a no-op when the trees already match.
//
// Usage:
//   node tools/publish.mjs <owner/repo> [options]
//
// Options:
//   --dir <path>        repository directory (default: the parent of tools/)
//   --branch <name>     remote branch (default: main)
//   --message <text>    commit message (default: the message of local HEAD)
//   --tag <name>        create or move this tag onto the new commit
//   --dry-run           report what would be published, change nothing
//   --token <token>     GitHub token (default: $GH_TOKEN, then the dsh-gitdeck store)
//
// Token sources, in order: --token, $GH_TOKEN, $GH_OAUTH_TOKEN,
// %DSH_HOME%/.dsh-gitdeck/auth.json (the dsh-gitdeck OAuth store, mode 0600).
//
// Exit codes: 0 published or already in sync, 1 failure, 2 bad usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function usage(code = 2) {
  console.error('usage: node tools/publish.mjs <owner/repo> [--dir <path>] [--branch main] [--message <text>] [--tag vX.Y.Z] [--dry-run] [--token <token>]');
  process.exit(code);
}

const argv = process.argv.slice(2);
const slug = argv.shift();
if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) usage();

const options = { branch: 'main', dir: path.resolve(here, '..'), message: '', tag: '', dryRun: false, token: '' };
while (argv.length > 0) {
  const flag = argv.shift();
  if (flag === '--dry-run') options.dryRun = true;
  else if (flag === '--dir') options.dir = path.resolve(argv.shift() || '.');
  else if (flag === '--branch') options.branch = argv.shift() || 'main';
  else if (flag === '--message') options.message = argv.shift() || '';
  else if (flag === '--tag') options.tag = argv.shift() || '';
  else if (flag === '--token') options.token = argv.shift() || '';
  else {
    console.error(`unknown option: ${flag}`);
    usage();
  }
}

// This sandbox forbids piped child stdio (spawn EPERM), so git output goes through files.
const gitBin = process.env.PUBLISH_GIT || 'git';
let tmpCounter = 0;
function gitBuf(args) {
  const tmp = path.join(os.tmpdir(), `publish-${process.pid}-${tmpCounter++}.out`);
  const fd = fs.openSync(tmp, 'w');
  try {
    execFileSync(gitBin, ['-C', options.dir, ...args], { stdio: ['ignore', fd, 'inherit'] });
  } finally {
    fs.closeSync(fd);
  }
  const bytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return bytes;
}
const git = (...args) => gitBuf(args).toString('utf8');

function readToken() {
  if (options.token) return options.token;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GH_OAUTH_TOKEN) return process.env.GH_OAUTH_TOKEN;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const store = path.join(home, '.dsh-gitdeck', 'auth.json');
  if (fs.existsSync(store)) {
    try {
      const record = JSON.parse(fs.readFileSync(store, 'utf8'));
      if (record && typeof record.token === 'string' && record.token) return record.token;
    } catch { /* fall through */ }
  }
  console.error('no GitHub token found: pass --token, set GH_TOKEN, or connect dsh-gitdeck');
  process.exit(1);
}

const token = readToken();
const API = 'https://api.github.com';
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-session-files-publish',
  'content-type': 'application/json',
};

async function api(method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 500)}`);
  return parsed;
}

async function optional(method, url) {
  try { return await api(method, url); } catch (error) {
    if (/ -> 404:/.test(String(error.message))) return undefined;
    throw error;
  }
}

function parseIdent(line) {
  const match = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`cannot parse ident line: ${line}`);
  const iso = new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d+Z$/, '');
  const offset = match[4];
  return {
    name: match[1],
    email: match[2],
    date: new Date(`${iso}${offset.slice(0, 3)}:${offset.slice(3)}`).toISOString(),
  };
}

const localHead = git('rev-parse', 'HEAD').trim();
const localTree = git('rev-parse', 'HEAD^{tree}').trim();
const headHeader = git('cat-file', '-p', localHead).split('\n\n')[0];
const commitMessage = options.message || git('log', '-1', '--pretty=%B').replace(/\s+$/, '');
const authorIdent = parseIdent(headHeader.split('\n').find((line) => line.startsWith('author ')).slice(7));

console.log(`repo   ${slug} (branch ${options.branch})`);
console.log(`local  ${localHead} tree ${localTree}`);

const remoteRef = await optional('GET', `/repos/${slug}/git/ref/heads/${options.branch}`);
const remoteHead = remoteRef?.object?.sha;
console.log(`remote ${remoteHead || '(empty branch)'}`);

let remoteTree = '';
if (remoteHead) {
  const remoteCommit = await api('GET', `/repos/${slug}/git/commits/${remoteHead}`);
  remoteTree = remoteCommit.tree.sha;
}
if (remoteHead && remoteTree === localTree) {
  console.log(`already in sync: remote ${options.branch} already has tree ${localTree}`);
  if (options.tag) await publishTag(remoteHead);
  process.exit(0);
}

const remoteBlobs = new Set();
if (remoteHead) {
  const remoteTreeDump = await api('GET', `/repos/${slug}/git/trees/${remoteTree}?recursive=1`);
  for (const entry of remoteTreeDump.tree) if (entry.type === 'blob') remoteBlobs.add(entry.sha);
}

const entries = [];
let uploaded = 0;
for (const line of git('ls-tree', '-r', localHead).split('\n').filter(Boolean)) {
  const tabAt = line.indexOf('\t');
  const [mode, type, objectSha] = line.slice(0, tabAt).split(/\s+/);
  const rel = line.slice(tabAt + 1);
  if (mode === '160000' || type !== 'blob') {
    console.log(`skip   ${rel} (not a regular file)`);
    continue;
  }
  let sha = objectSha;
  if (!remoteBlobs.has(sha)) {
    if (options.dryRun) {
      console.log(`would upload ${rel}`);
    } else {
      const bytes = gitBuf(['cat-file', 'blob', objectSha]);
      const blob = await api('POST', `/repos/${slug}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' });
      sha = blob.sha;
      uploaded += 1;
    }
  }
  entries.push({ path: rel, mode, type: 'blob', sha });
}
console.log(`files  ${entries.length} (${uploaded} new blobs)`);

if (options.dryRun) {
  console.log('dry run: no commit, refs or tags were changed');
  process.exit(0);
}

const tree = await api('POST', `/repos/${slug}/git/trees`, { tree: entries });
const commit = await api('POST', `/repos/${slug}/git/commits`, {
  message: commitMessage,
  tree: tree.sha,
  parents: remoteHead ? [remoteHead] : [],
  author: authorIdent,
  committer: authorIdent,
});
console.log(`commit ${commit.sha} ${commit.html_url || ''}`);

if (remoteHead) await api('PATCH', `/repos/${slug}/git/refs/heads/${options.branch}`, { sha: commit.sha, force: false });
else await api('POST', `/repos/${slug}/git/refs`, { ref: `refs/heads/${options.branch}`, sha: commit.sha });
console.log(`ref    refs/heads/${options.branch} -> ${commit.sha}`);

if (options.tag) await publishTag(commit.sha);

async function publishTag(target) {
  const tagName = options.tag;
  const tagObject = await api('POST', `/repos/${slug}/git/tags`, {
    tag: tagName,
    message: tagName,
    object: target,
    type: 'commit',
    tagger: authorIdent,
  });
  const existing = await optional('GET', `/repos/${slug}/git/ref/tags/${tagName}`);
  if (existing) {
    await api('PATCH', `/repos/${slug}/git/refs/tags/${tagName}`, { sha: tagObject.sha, force: true });
    console.log(`tag    refs/tags/${tagName} -> ${target} (moved)`);
  } else {
    await api('POST', `/repos/${slug}/git/refs`, { ref: `refs/tags/${tagName}`, sha: tagObject.sha });
    console.log(`tag    refs/tags/${tagName} -> ${target} (created)`);
  }
}

const repository = await api('GET', `/repos/${slug}`);
console.log(`done   ${repository.html_url}`);
