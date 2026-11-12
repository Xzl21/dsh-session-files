#!/usr/bin/env node
// End-to-end integration check for the host half against REAL session logs and a
// REAL workspace.
//
//   node test/integration.real.mjs
//   node test/integration.real.mjs --session <session-id|log-file>
//   node test/integration.real.mjs --workspace <dir>
//   node test/integration.real.mjs --dump-ledger <out.json>
//
// The real workspace and the real `~/.dsh` are only ever READ. Every destructive
// step (trash/delete) runs against throwaway workspaces and DSH_HOME directories
// created under os.tmpdir(), which are removed before the process exits.
//
// Exit code: 0 when every check passes, 1 otherwise.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { apply } from '../index.js';
import { readSessionLog } from '../host/logreader.mjs';

const ROUTE_PREFIX = '/api/session-files';
const LANES = ['deliverable', 'process', 'input', 'temp'];

// ----- tiny check harness --------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  const text = detail === undefined ? '' : ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  failures.push(`${label}${text}`);
  return false;
}

function section(title) {
  process.stdout.write(`\n## ${title}\n`);
}

// ----- cli args ------------------------------------------------------------

function parseArgs(argv) {
  const options = { session: null, workspace: null, dumpLedger: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--session') {
      options.session = value;
      index += 1;
    } else if (flag === '--workspace') {
      options.workspace = value;
      index += 1;
    } else if (flag === '--dump-ledger') {
      options.dumpLedger = value;
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write('usage: node test/integration.real.mjs [--session <id|file>] [--workspace <dir>] [--dump-ledger <out.json>]\n');
      process.stdout.write('       session defaults to $DSH_SESSION_ID when set, else the newest log under $DSH_HOME/sessions.\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function realHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listSessionLogs(home) {
  const root = join(home, 'sessions');
  const logs = [];
  for (const slug of safeReaddir(root)) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(root, slug.name);
    for (const session of safeReaddir(slugDir)) {
      if (!session.isDirectory()) continue;
      const file = join(slugDir, session.name, 'session.v4.jsonl.zstd');
      try {
        const info = statSync(file);
        if (info.isFile()) logs.push({ file, mtimeMs: info.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs;
}

function resolveSessionLog(options, home) {
  // `--session` wins; otherwise honour DSH_SESSION_ID (the currently running
  // agent session) so `--dump-ledger` dumps "this" session out of the box;
  // otherwise fall back to the most recently modified session log.
  const requested = options.session ?? (process.env.DSH_SESSION_ID ? String(process.env.DSH_SESSION_ID) : null);
  if (requested) {
    if (existsSync(requested) && statSync(requested).isFile()) return resolve(requested);
    const variants = new Set([requested, `session-${requested}`]);
    for (const entry of listSessionLogs(home)) {
      const parts = entry.file.split(/[\\/]/);
      if (variants.has(parts[parts.length - 2])) return entry.file;
    }
    throw new Error(`no session log found for "${requested}" under ${join(home, 'sessions')}`);
  }
  const logs = listSessionLogs(home);
  if (logs.length === 0) throw new Error(`no session logs under ${join(home, 'sessions')}`);
  return logs[0].file;
}

// ----- fake cordis ctx that only provides webServer ------------------------

function mountPlugin(routes, services) {
  const optional = services || {};
  const disposers = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const ctx = {
    get(service) {
      if (service === 'webServer') return webServer;
      return optional[service];
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    logger,
    webServer,
  };
  apply(ctx);
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
  };
}

// ----- loopback http wiring ------------------------------------------------

async function startServer(routes) {
  const table = new Map(routes.map((route) => [route.path, route.handler]));
  const server = createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // keep '/'
    }
    const handler = table.get(pathname);
    if (typeof handler !== 'function') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'not-found' }));
      return;
    }
    Promise.resolve(handler(req, res)).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: 'internal' }));
      } catch {
        // ignore
      }
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function requestJson(base, pathname, options) {
  const settings = options || {};
  const init = { method: settings.method || 'GET', headers: { ...(settings.headers || {}) } };
  if (settings.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(settings.body);
  }
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function ledgerUrl(sessionId) {
  return `${ROUTE_PREFIX}/ledger?sessionId=${encodeURIComponent(sessionId)}`;
}

/** Poll `predicate` until it is truthy or `timeoutMs` elapses (background work). */
async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((done) => setTimeout(done, 40));
  }
}

// ----- ledger shape assertions (numbers stay data-driven) ------------------

function distinctNodePaths(ledger) {
  const paths = new Set();
  for (const node of ledger.nodes) if (node && typeof node.path === 'string') paths.add(node.path);
  return paths;
}

function tempNodePaths(ledger) {
  const paths = new Set();
  for (const node of ledger.nodes) if (node && node.lane === 'temp' && typeof node.path === 'string') paths.add(node.path);
  return paths;
}

function isRelativeSafe(relPath) {
  return typeof relPath === 'string' && relPath.length > 0 && !/^[A-Za-z]:/.test(relPath) && !relPath.startsWith('/') && !relPath.split('/').includes('..');
}

function checkLedgerShape(label, ledger) {
  const nodes = Array.isArray(ledger.nodes) ? ledger.nodes : [];
  const edges = Array.isArray(ledger.edges) ? ledger.edges : [];
  const columns = Array.isArray(ledger.columns) ? ledger.columns : [];
  const counts = ledger.counts || {};
  const lanes = Array.isArray(ledger.lanes) ? ledger.lanes : [];

  check(`${label}: counts are file-level integers`, ['deliverable', 'process', 'input', 'temp'].every((lane) => Number.isInteger(counts[lane]) && counts[lane] >= 0), counts);
  check(`${label}: counts.files === sum of lanes`, counts.files === counts.deliverable + counts.process + counts.input + counts.temp, { files: counts.files, sum: counts.deliverable + counts.process + counts.input + counts.temp });
  check(`${label}: lanes are the four contract lanes`, lanes.length === 4 && LANES.every((lane) => lanes.includes(lane)), lanes);
  check(`${label}: columns have ids and known kinds`, columns.length >= 2 && columns.every((column) => column && typeof column.id === 'string' && typeof column.kind === 'string'), columns.map((column) => column && column.kind));
  check(`${label}: every node has path/lane/id`, nodes.length > 0 && nodes.every((node) => node && typeof node.id === 'string' && typeof node.path === 'string' && LANES.includes(node.lane)), nodes.length);
  check(`${label}: node paths are relative and inside the workspace`, nodes.every((node) => isRelativeSafe(node.path)));
  const nodeIds = new Set(nodes.map((node) => node.id));
  check(`${label}: every edge endpoint exists in nodes`, edges.every((edge) => edge && nodeIds.has(edge.from) && nodeIds.has(edge.to)), edges.length);
  check(`${label}: counts.files >= distinct node paths`, counts.files >= distinctNodePaths(ledger).size, { files: counts.files, nodePaths: distinctNodePaths(ledger).size });

  if (ledger.workspace) {
    const workspace = ledger.workspace;
    const tempPaths = Array.isArray(workspace.tempPaths) ? workspace.tempPaths : [];
    // `scanned` is the scan size; `counts.files` also covers event-only paths, so
    // the two may differ; both must still be consistent with the backlog numbers.
    check(`${label}: workspace.scanned is a non-negative integer`, Number.isInteger(workspace.scanned) && workspace.scanned >= 0, { scanned: workspace.scanned });
    check(`${label}: counts.files covers the workspace backlog`, counts.files >= workspace.tempPathCount, { files: counts.files, backlog: workspace.tempPathCount });
    check(`${label}: workspace.tempPathCount <= counts.temp`, Number.isInteger(workspace.tempPathCount) && workspace.tempPathCount <= counts.temp, { backlog: workspace.tempPathCount, temp: counts.temp });
    check(`${label}: workspace.tempPaths capped at 500 and truncated flag matches`, tempPaths.length === Math.min(workspace.tempPathCount, 500) && workspace.truncated === (workspace.tempPathCount > 500), { len: tempPaths.length, count: workspace.tempPathCount, truncated: workspace.truncated });
    check(`${label}: workspace.tempPaths are safe relative paths`, tempPaths.every(isRelativeSafe));
    check(`${label}: workspace.tempPaths never duplicate a temp node`, tempPaths.every((relPath) => !tempNodePaths(ledger).has(relPath)));
    check(`${label}: temp nodes + backlog cannot exceed the temp file count`, tempNodePaths(ledger).size <= counts.temp && tempPaths.length <= counts.temp, { tempNodes: tempNodePaths(ledger).size, backlog: tempPaths.length, temp: counts.temp });
  }
  return { nodes, edges, columns, counts };
}

// ----- fixtures ------------------------------------------------------------

function writeSyntheticSessionLog(home, workspacePath, sessionId) {
  const header = { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 86_400_000, cwd: workspacePath, isSeeded: false };
  const turnStart = { type: 'turn/start', seq: 1, time: Date.now() - 3_600_000, data: { turn: 1 } };
  const first = `${JSON.stringify(header)}\n`;
  const rest = `${JSON.stringify(turnStart)}\n`;
  const file = join(home, 'sessions', '--integration--', sessionId, 'session.v4.jsonl.zstd');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([zstdCompressSync(Buffer.from(first, 'utf8')), zstdCompressSync(Buffer.from(rest, 'utf8'))]));
  return file;
}

function writeSyntheticLogWithWrite(home, workspacePath, sessionId, relPath) {
  const header = { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 86_400_000, cwd: workspacePath, isSeeded: false };
  const turnStart = { type: 'turn/start', seq: 1, time: Date.now() - 3_600_000, data: { turn: 1 } };
  const call = {
    type: 'tool/call',
    seq: 2,
    time: Date.now() - 3_500_000,
    data: { name: 'write', turn: 1, arguments: JSON.stringify({ file_path: relPath, content: 'print(1)\n' }) },
  };
  const lines = [`${JSON.stringify(header)}\n`, `${JSON.stringify(turnStart)}\n`, `${JSON.stringify(call)}\n`];
  const file = join(home, 'sessions', '--integration--', sessionId, 'session.v4.jsonl.zstd');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line, 'utf8')))));
  return file;
}

function copyRealSessionLog(home, sourceFile, sessionId) {
  const file = join(home, 'sessions', '--integration--', sessionId, 'session.v4.jsonl.zstd');
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(sourceFile, file);
  return file;
}

// ----- main ----------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const realStateBefore = existsSync(join(home, 'session-files'));
  const originalHome = process.env.DSH_HOME;

  const realLog = resolveSessionLog(options, home);
  const log = readSessionLog(realLog);
  if (!log.header || typeof log.header.id !== 'string') throw new Error(`could not parse a session header from ${realLog}`);
  const sessionId = log.header.id;
  const workspacePath = options.workspace ? resolve(options.workspace) : typeof log.header.cwd === 'string' ? resolve(log.header.cwd) : '';
  if (!workspacePath || !existsSync(workspacePath)) throw new Error(`workspace not found: ${workspacePath || '(header.cwd missing)'}`);

  section('real session log');
  process.stdout.write(`log: ${realLog}\nframes: ${log.frames} badFrames: ${log.badFrames} events: ${log.events.length}\n`);
  process.stdout.write(`header: id=${sessionId} cwd=${log.header.cwd} createdAt=${log.header.createdAt}\n`);
  check('real log has a session header', typeof log.header.id === 'string' && Number.isFinite(Number(log.header.createdAt)));
  check('real log decodes without fatal frames', log.frames > 0 && log.badFrames >= 0);
  check('real log has events', log.events.length > 0, log.events.length);
  const toolCalls = log.events.filter((event) => event && event.type === 'tool/call');
  check('real log has tool/call events', toolCalls.length > 0, toolCalls.length);
  const touchedPaths = new Set();
  for (const event of toolCalls) {
    const data = event.data || {};
    let args = data.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = undefined;
      }
    }
    if (!args || typeof args !== 'object') continue;
    if (typeof args.file_path === 'string') touchedPaths.add(args.file_path);
    if (typeof args.path === 'string') touchedPaths.add(args.path);
    if (Array.isArray(args.files)) for (const file of args.files) if (file && typeof file.path === 'string') touchedPaths.add(file.path);
  }
  process.stdout.write(`tool/call by tool: ${[...new Set(toolCalls.map((event) => String((event.data || {}).name)))].join(', ')}\n`);
  process.stdout.write(`distinct file paths from tool arguments: ${touchedPaths.size}\n`);

  // ----- part A: real log + real workspace through the real plugin --------
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-sf-home-'));
  const tmpWorkspace = mkdtempSync(join(tmpdir(), 'dsh-sf-ws-'));
  const routes = [];
  const unmount = mountPlugin(routes);
  const server = await startServer(routes);
  check('plugin registers nine exact routes', routes.length === 9 && routes.every((route) => route.kind === 'exact' && typeof route.path === 'string'), routes.map((route) => route.path));
  const routePaths = new Set(routes.map((route) => route.path));
  check(
    'plugin registers the trash and config routes',
    [
      `${ROUTE_PREFIX}/trash`,
      `${ROUTE_PREFIX}/trash/restore`,
      `${ROUTE_PREFIX}/trash/empty`,
      `${ROUTE_PREFIX}/config`,
    ].every((pathname) => routePaths.has(pathname)),
    [...routePaths],
  );

  let exitCode = 0;
  try {
    process.env.DSH_HOME = tmpHome;
    copyRealSessionLog(tmpHome, realLog, sessionId);

    section('real workspace + real ledger (read-only)');
    const ledgerResponse = await requestJson(server.base, ledgerUrl(sessionId));
    process.stdout.write(`GET /ledger -> ${ledgerResponse.status}\n`);
    if (!check('real ledger responds 200', ledgerResponse.status === 200 && ledgerResponse.json && ledgerResponse.json.ok === true)) {
      process.stdout.write(`${JSON.stringify(ledgerResponse.json)}\n`);
      throw new Error('real ledger request failed; aborting');
    }
    const ledger = ledgerResponse.json.ledger;
    check('ledger is tagged as a log session', ledger.source === 'log' && ledger.live === false);
    check('ledger sessionId matches', ledger.sessionId === sessionId, ledger.sessionId);
    check('ledger workspacePath is the real workspace', typeof ledger.workspacePath === 'string' && resolve(ledger.workspacePath) === workspacePath, ledger.workspacePath);
    check('ledger has generatedAt', Number.isFinite(ledger.generatedAt), ledger.generatedAt);
    const shape = checkLedgerShape('real ledger', ledger);
    process.stdout.write(
      `counts ${JSON.stringify(ledger.counts)} | nodes ${shape.nodes.length} (paths ${distinctNodePaths(ledger).size}) | edges ${shape.edges.length} | columns ${shape.columns.length} | warnings ${JSON.stringify(ledger.warnings)}\n`,
    );
    if (ledger.workspace) {
      process.stdout.write(`workspace: scanned ${ledger.workspace.scanned} tempPathCount ${ledger.workspace.tempPathCount} tempPaths ${ledger.workspace.tempPaths.length} truncated ${ledger.workspace.truncated}\n`);
    } else {
      process.stdout.write('workspace: (absent, no temp backlog)\n');
    }

    const second = await requestJson(server.base, ledgerUrl(sessionId));
    // Strict determinism is asserted on the throwaway workspace below; the real
    // workspace changes under other live agents, so here only the identity fields
    // must be byte-identical (same workspace, same lanes, same column layout).
    const identity = (value) => JSON.stringify({ sessionId: value.sessionId, workspacePath: value.workspacePath, lanes: value.lanes, columnIds: (value.columns || []).map((column) => column && column.id), generatedAt: 0 });
    check('ledger identity fields are deterministic', second.status === 200 && identity(second.json.ledger) === identity(ledger));

    if (options.dumpLedger) {
      const target = resolve(options.dumpLedger);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
      process.stdout.write(
        `dump: ${target} | nodes ${ledger.nodes.length} edges ${ledger.edges.length} workspace.tempPathCount ${ledger.workspace ? ledger.workspace.tempPathCount : 0} | counts ${JSON.stringify(ledger.counts)}\n`,
      );
    }

    section('dry-run delete (scope all)');
    const expectedBacklog = ledger.workspace && Array.isArray(ledger.workspace.tempPaths) ? ledger.workspace.tempPaths : [];
    const expected = new Set([...tempNodePaths(ledger), ...expectedBacklog]);
    const existingCandidates = [...expected].filter((relPath) => {
      try {
        return statSync(join(workspacePath, ...relPath.split('/'))).isFile();
      } catch {
        return false;
      }
    });
    const dry = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId, scope: 'all', dryRun: true } });
    check('dry run responds 200', dry.status === 200 && dry.json && dry.json.ok === true, dry.status);
    const dryDeleted = Array.isArray(dry.json && dry.json.deleted) ? dry.json.deleted : [];
    check('dry run flags dryRun:true', dry.json && dry.json.dryRun === true);
    check('dry run reports every temp file that exists on disk', dryDeleted.length === existingCandidates.length && dryDeleted.every((relPath) => existingCandidates.includes(relPath)), { deleted: dryDeleted.length, existing: existingCandidates.length, candidates: expected.size });
    check('dry run deleted paths are a subset of temp candidates', dryDeleted.every((relPath) => expected.has(relPath)), dryDeleted.filter((relPath) => !expected.has(relPath)).slice(0, 5));
    const truncatedBacklog = Boolean(ledger.workspace && ledger.workspace.truncated);
    check('dry run covers every listed temp path on disk', truncatedBacklog || dryDeleted.length === existingCandidates.length, { deleted: dryDeleted.length, expected: existingCandidates.length, truncated: truncatedBacklog });
    const stillOnDisk = dryDeleted.every((relPath) => existsSync(join(workspacePath, ...relPath.split('/'))));
    check('dry run moved nothing on disk', stillOnDisk);
    const afterDry = await requestJson(server.base, ledgerUrl(sessionId));
    check('ledger still served after dry run', afterDry.status === 200 && Boolean(afterDry.json && afterDry.json.ledger), afterDry.status);
    // The real workspace is shared with other live agents, so its file counts can
    // drift while the suite runs. A dry run can only ever *delete*, and that is
    // already asserted on disk above, so a drift here is a note, not a failure.
    const dryBeforeCounts = JSON.stringify(ledger.counts);
    const dryAfterCounts = JSON.stringify(afterDry.json && afterDry.json.ledger ? afterDry.json.ledger.counts : null);
    if (dryBeforeCounts !== dryAfterCounts) process.stdout.write(`note: counts drifted during dry run ${dryBeforeCounts} -> ${dryAfterCounts} (workspace churn)\n`);

    section('classify + clear (real overrides, temp DSH_HOME)');
    const classifyNode = shape.nodes.find((node) => node.lane !== 'temp' && typeof node.path === 'string') || shape.nodes[0];
    if (classifyNode) {
      const classified = await requestJson(server.base, `${ROUTE_PREFIX}/classify`, {
        method: 'POST',
        body: { sessionId, path: classifyNode.path, cls: 'deliverable', note: 'integration-test' },
      });
      const classifiedNode = classified.json && classified.json.ledger ? classified.json.ledger.nodes.find((node) => node.path === classifyNode.path) : undefined;
      check('classify responds 200 and marks the node overridden', classified.status === 200 && Boolean(classifiedNode) && classifiedNode.overridden === true && classifiedNode.note === 'integration-test', classified.status);
      check('classify persisted an override file in the temp DSH_HOME', existsSync(join(tmpHome, 'session-files', 'overrides', `${sessionId}.json`)));
      const noteOnly = await requestJson(server.base, `${ROUTE_PREFIX}/classify`, { method: 'POST', body: { sessionId, path: classifyNode.path, note: 'note-only-patch' } });
      const noteNode = noteOnly.json && noteOnly.json.ledger ? noteOnly.json.ledger.nodes.find((node) => node.path === classifyNode.path) : undefined;
      check(
        'note-only classify keeps the existing class and updates the note',
        noteOnly.status === 200 && Boolean(noteNode) && noteNode.overridden === true && noteNode.cls === 'deliverable' && noteNode.note === 'note-only-patch',
        JSON.stringify(noteNode || noteOnly.json),
      );
      const cleared = await requestJson(server.base, `${ROUTE_PREFIX}/classify`, { method: 'POST', body: { sessionId, path: classifyNode.path, cls: null } });
      const clearedNode = cleared.json && cleared.json.ledger ? cleared.json.ledger.nodes.find((node) => node.path === classifyNode.path) : undefined;
      check('classify null clears the override', cleared.status === 200 && Boolean(clearedNode) && clearedNode.overridden === false, cleared.status);
    } else {
      check('classify test has a node to work with', false);
    }

    section('preview (real workspace, read-only)');
    const previewNode = shape.nodes.find((node) => typeof node.path === 'string' && node.size > 32 && ['.md', '.js', '.mjs', '.json', '.txt', '.py', '.css', '.html'].includes(extname(node.path).toLowerCase()));
    if (previewNode) {
      const preview = await requestJson(server.base, `${ROUTE_PREFIX}/preview?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(previewNode.path)}&maxBytes=32`);
      const previewBody = preview.json || {};
      check('preview responds 200', preview.status === 200 && previewBody.ok === true, preview.status);
      check('preview truncates at maxBytes', previewBody.truncated === true && typeof previewBody.text === 'string' && previewBody.text.length <= 32, { truncated: previewBody.truncated, length: (previewBody.text || '').length });
      check('preview reports the file size', Number.isFinite(previewBody.bytes) && previewBody.bytes === previewNode.size, { bytes: previewBody.bytes, size: previewNode.size });
    } else {
      check('preview test has a text node to work with', false);
    }

    section('loopback guard');
    const crossOrigin = await requestJson(server.base, ledgerUrl(sessionId), { headers: { origin: 'http://evil.example' } });
    check('cross-origin origin is rejected with 403', crossOrigin.status === 403 && crossOrigin.json.code === 'forbidden', crossOrigin.status);
    const crossSite = await requestJson(server.base, ledgerUrl(sessionId), { headers: { 'sec-fetch-site': 'cross-site' } });
    check('cross-site fetch is rejected with 403', crossSite.status === 403, crossSite.status);
    const badId = await requestJson(server.base, `${ROUTE_PREFIX}/ledger?sessionId=../../etc/passwd`);
    check('bad session id is rejected with 400', badId.status === 400 && badId.json.code === 'bad-session-id', badId.status);
    const missing = await requestJson(server.base, `${ROUTE_PREFIX}/ledger?sessionId=session-00000000-0000-0000-0000-000000000000`);
    check('unknown session is 404 session-not-found', missing.status === 404 && missing.json.code === 'session-not-found', missing.status);
    check('unknown session reason is no-log', missing.json && missing.json.params && missing.json.params.reason === 'no-log', JSON.stringify(missing.json));
    check(
      'unknown session carries a log-missing warning',
      Array.isArray(missing.json && missing.json.warnings) && missing.json.warnings.includes('log-missing'),
      JSON.stringify(missing.json && missing.json.warnings),
    );

    // ----- part B: destructive delete, throwaway workspace only -----------
    section('real delete on a throwaway workspace (scope all)');
    const scHome = mkdtempSync(join(tmpdir(), 'dsh-sf-delhome-'));
    const scWorkspace = mkdtempSync(join(tmpdir(), 'dsh-sf-delws-'));
    writeFileSync(join(scWorkspace, 'probe_one.py'), 'print(1)\n');
    writeFileSync(join(scWorkspace, '_asar_dump.py'), 'x = 1\n');
    writeFileSync(join(scWorkspace, 'notes.md'), '# notes\n');
    const scSessionId = `session-${randomUUID()}`;
    writeSyntheticSessionLog(scHome, scWorkspace, scSessionId);
    process.env.DSH_HOME = scHome;

    const scLedgerResponse = await requestJson(server.base, ledgerUrl(scSessionId));
    check('throwaway ledger responds 200', scLedgerResponse.status === 200 && Boolean(scLedgerResponse.json && scLedgerResponse.json.ledger), scLedgerResponse.status);
    const scLedger = scLedgerResponse.json && scLedgerResponse.json.ledger;
    if (scLedger) {
      const scAgain = await requestJson(server.base, ledgerUrl(scSessionId));
      const scSerial = (value) => JSON.stringify({ ...value, generatedAt: 0 });
      check('throwaway ledger is deterministic (two builds serialize identically)', scAgain.status === 200 && scSerial(scAgain.json.ledger) === scSerial(scLedger));
      const scTemp = tempNodePaths(scLedger);
      const scBacklog = scLedger.workspace && Array.isArray(scLedger.workspace.tempPaths) ? scLedger.workspace.tempPaths : [];
      check('throwaway ledger finds temp files', scTemp.size + scBacklog.length > 0, { tempNodes: scTemp.size, backlog: scBacklog.length, counts: scLedger.counts });
      const treeOnly = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: scSessionId, scope: 'tree', paths: ['notes.md'] } });
      check('tree scope skips non-temp explicit paths', treeOnly.status === 200 && Array.isArray(treeOnly.json.skipped) && treeOnly.json.deleted.length === 0, treeOnly.json);
      const scDry = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: scSessionId, scope: 'all', dryRun: true } });
      const scDryDeleted = Array.isArray(scDry.json && scDry.json.deleted) ? scDry.json.deleted : [];
      check('throwaway dry run lists temp files', scDryDeleted.length > 0, scDryDeleted);
      check('throwaway dry run leaves files on disk', scDryDeleted.every((relPath) => existsSync(join(scWorkspace, ...relPath.split('/')))));
      const scReal = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: scSessionId, scope: 'all' } });
      const scDeleted = Array.isArray(scReal.json && scReal.json.deleted) ? scReal.json.deleted : [];
      check('throwaway delete responds 200', scReal.status === 200 && scReal.json.ok === true, scReal.status);
      check('throwaway delete moved exactly the dry-run list', scDeleted.length === scDryDeleted.length && scDeleted.every((relPath) => scDryDeleted.includes(relPath)), { real: scDeleted, dry: scDryDeleted });
      check('throwaway delete removed the sources from the workspace', scDeleted.every((relPath) => !existsSync(join(scWorkspace, ...relPath.split('/')))));
      check('throwaway delete wrote files into the plugin trash', scDeleted.every((relPath) => {
        const trashRoot = join(scHome, 'session-files', 'trash', scSessionId);
        if (!existsSync(trashRoot)) return false;
        for (const batch of safeReaddir(trashRoot)) {
          if (!batch.isDirectory()) continue;
          if (existsSync(join(trashRoot, batch.name, ...relPath.split('/')))) return true;
        }
        return false;
      }));
      check('throwaway delete keeps non-temp files', existsSync(join(scWorkspace, 'notes.md')));
      check('temp workspace still has no stray state', !existsSync(join(scWorkspace, 'session-files')));
      rmSync(scHome, { recursive: true, force: true });
      rmSync(scWorkspace, { recursive: true, force: true });
    } else {
      failed += 1;
      failures.push('throwaway ledger could not be built');
    }
    // ----- part B2: stale temp records are pruned, never skipped forever -------
    section('stale temp records (pruned, not skipped)');
    const stHome = mkdtempSync(join(tmpdir(), 'dsh-sf-stalehome-'));
    const stWorkspace = mkdtempSync(join(tmpdir(), 'dsh-sf-stalews-'));
    const stRel = 'probe_gone.py';
    writeFileSync(join(stWorkspace, stRel), 'print(1)\n');
    const stSessionId = `session-${randomUUID()}`;
    writeSyntheticLogWithWrite(stHome, stWorkspace, stSessionId, stRel);
    process.env.DSH_HOME = stHome;
    {
      const live = await requestJson(server.base, ledgerUrl(stSessionId));
      const liveLedger = (live.json && live.json.ledger) || {};
      const liveNode = (liveLedger.nodes || []).find((node) => node.path === stRel);
      check('a touched temp file starts as an existing temp node', Boolean(liveNode) && liveNode.lane === 'temp' && liveNode.exists === true, liveNode);

      // The file vanishes outside the plugin (user deletion, or another session's cleanup).
      rmSync(join(stWorkspace, stRel), { force: true });

      const gone = await requestJson(server.base, ledgerUrl(stSessionId));
      const goneLedger = (gone.json && gone.json.ledger) || {};
      const goneNode = (goneLedger.nodes || []).find((node) => node.path === stRel);
      check('a temp node whose file is gone reports exists:false', Boolean(goneNode) && goneNode.exists === false, goneNode);
      check('counts.tempMissing reports the stale record', (goneLedger.counts || {}).tempMissing >= 1, goneLedger.counts);

      const dry = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: stSessionId, scope: 'all', dryRun: true } });
      const dryJson = dry.json || {};
      check('dry run reports the vanished record as pruned', Array.isArray(dryJson.pruned) && dryJson.pruned.includes(stRel), dryJson);
      check('dry run does not claim to delete the vanished record', Array.isArray(dryJson.deleted) && !dryJson.deleted.includes(stRel), dryJson);

      const done = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: stSessionId, scope: 'all' } });
      const doneJson = done.json || {};
      check('cleanup prunes it (deleted stays empty)', done.status === 200 && Array.isArray(doneJson.pruned) && doneJson.pruned.includes(stRel) && Array.isArray(doneJson.deleted) && doneJson.deleted.length === 0, doneJson);
      const afterLedger = (doneJson.ledger || {});
      check('the pruned record is gone from the returned ledger', !(afterLedger.nodes || []).some((node) => node.path === stRel), (afterLedger.nodes || []).map((node) => node.path));
      check('the stale record is not resurrected by the next ledger build', !(await requestJson(server.base, ledgerUrl(stSessionId))).json || !(((await requestJson(server.base, ledgerUrl(stSessionId))).json.ledger.nodes) || []).some((node) => node.path === stRel));
      check('pruning never touches the disk', !existsSync(join(stWorkspace, stRel)));
    }
    rmSync(stHome, { recursive: true, force: true });
    rmSync(stWorkspace, { recursive: true, force: true });

    // ----- part C: the session_files agent tool over a throwaway workspace ---
    section('session_files tool (throwaway workspace)');
    const toolHome = mkdtempSync(join(tmpdir(), 'dsh-sf-toolhome-'));
    const toolWorkspace = mkdtempSync(join(tmpdir(), 'dsh-sf-toolws-'));
    writeFileSync(join(toolWorkspace, 'probe_tmp.py'), 'print(1)\n');
    writeFileSync(join(toolWorkspace, '_asar_dump.py'), 'x = 1\n');
    writeFileSync(join(toolWorkspace, 'notes.md'), '# notes\n');
    const toolSessionId = `session-${randomUUID()}`;
    writeSyntheticSessionLog(toolHome, toolWorkspace, toolSessionId);
    process.env.DSH_HOME = toolHome;
    const toolDefs = [];
    const unmountTools = mountPlugin([], {
      tools: {
        register(definition) {
          toolDefs.push(definition);
          return () => {};
        },
      },
    });
    const sessionFilesTool = toolDefs.find((definition) => definition && definition.name === 'session_files');
    check('session_files tool registers through ctx.get(tools)', Boolean(sessionFilesTool));
    if (sessionFilesTool) {
      // Mimic what dsh-tools does with a tool body's return value: it must be the BARE
      // output value (validated against output.schema), never a { isError, value, content }
      // envelope -- the envelope fails schema validation with `missing required property
      // "value.ok"` and swallows the real error message.
      const runTool = async (definition, args, exec) => {
        try {
          const returned = await definition.execute(args, exec);
          const schema = (definition.output && definition.output.schema) || {};
          const required = Array.isArray(schema.required) ? schema.required : [];
          const missing = required.filter((key) => !returned || typeof returned !== 'object' || returned[key] === undefined);
          if (missing.length > 0) throw new Error(`invalid tool output: missing ${missing.map((key) => `"value.${key}"`).join(', ')}`);
          if (Object.hasOwn(returned, 'isError')) throw new Error('tool body returned a result envelope instead of the bare output value');
          return { isError: false, value: returned, content: definition.output.render(args, returned) };
        } catch (error) {
          const message = String((error && error.message) || error);
          return { isError: true, error: { message }, content: [{ type: 'text', text: message }] };
        }
      };
      const textOf = (result) => String(result && result.content && result.content[0] ? result.content[0].text : '');
      try {
        const listed = await runTool(sessionFilesTool, { action: 'list' }, { agent: { session: { id: toolSessionId } } });
        const listText = textOf(listed);
        check('tool list returns a compact text table', listed && listed.isError === false && listText.length > 0 && listed.content.length === 1, listText.slice(0, 120));
        check(
          'tool list keeps nodes out of the result value',
          Boolean(listed.value && listed.value.ledger) && listed.value.ledger.nodes === undefined && typeof listed.value.ledger.counts.temp === 'number',
        );
        // Regression: a tool body must return the bare output value. Returning the
        // `{ isError, value, content }` envelope makes dsh-tools reject the call with
        // `missing required property "value.ok"` and hides the real message.
        check(
          'tool body returns the bare output value, not a result envelope',
          Boolean(listed.value)
            && !Object.hasOwn(listed.value, 'isError')
            && listed.value.ok === true
            && typeof listed.value.action === 'string'
            && typeof listed.value.summary === 'string',
          listed.value ? Object.keys(listed.value).join(',') : '(no value)',
        );
        const badAction = await runTool(sessionFilesTool, { action: 'nope' }, { agent: { session: { id: toolSessionId } } });
        const badMessage = String((badAction.error && badAction.error.message) || '');
        check(
          'tool failure surfaces the real message instead of an output-schema violation',
          badAction.isError === true && /unknown action "nope"/.test(badMessage) && !/invalid tool output/i.test(badMessage),
          badMessage.slice(0, 160),
        );
        const classified = await runTool(sessionFilesTool, { action: 'classify', paths: ['notes.md'], cls: 'deliverable', note: 'tool-test' }, { agent: { session: { id: toolSessionId } } });
        check(
          'tool classify overrides a path',
          classified && classified.isError === false && classified.value.ledger.counts.deliverable >= 1,
          classified && classified.value ? JSON.stringify(classified.value.ledger.counts) : '',
        );
        const dryClean = await runTool(sessionFilesTool, { action: 'cleanup', dryRun: true }, { agent: { session: { id: toolSessionId } } });
        const dryCleanText = textOf(dryClean);
        check(
          'tool cleanup dryRun reports without touching files',
          dryClean && dryClean.isError === false && /dry run/i.test(dryCleanText) && existsSync(join(toolWorkspace, 'probe_tmp.py')),
          dryCleanText.slice(0, 160),
        );
        const realClean = await runTool(sessionFilesTool, { action: 'cleanup' }, { agent: { session: { id: toolSessionId } } });
        const realCleanText = textOf(realClean);
        check(
          'tool cleanup moves the temp backlog to the trash',
          realClean && realClean.isError === false && /moved/i.test(realCleanText) && !existsSync(join(toolWorkspace, 'probe_tmp.py')) && !existsSync(join(toolWorkspace, '_asar_dump.py')) && existsSync(join(toolWorkspace, 'notes.md')) && realClean.value.ledger.counts.temp === 0,
          realCleanText.slice(0, 220),
        );
        const treeOnlyClean = await runTool(sessionFilesTool, { action: 'cleanup', paths: ['notes.md'] }, { agent: { session: { id: toolSessionId } } });
        check(
          'tool cleanup skips explicit non-temp paths',
          treeOnlyClean && treeOnlyClean.isError === false && existsSync(join(toolWorkspace, 'notes.md')),
          textOf(treeOnlyClean).slice(0, 160),
        );
      } finally {
        unmountTools();
        rmSync(toolHome, { recursive: true, force: true });
        rmSync(toolWorkspace, { recursive: true, force: true });
      }
    }
    // ----- part D: trash browser, restore, empty and retention config -----
    section('trash browser, restore, empty and retention config');
    const trHome = mkdtempSync(join(tmpdir(), 'dsh-sf-trashhome-'));
    const trWorkspace = mkdtempSync(join(tmpdir(), 'dsh-sf-trashws-'));
    const trSessionId = `session-${randomUUID()}`;
    const trashBase = join(trHome, 'session-files', 'trash');
    const trashListUrl = (query) => `${ROUTE_PREFIX}/trash?sessionId=${encodeURIComponent(trSessionId)}${query || ''}`;
    const probeRel = 'probe_trash.py';
    const probeText = 'print("trash")\n';
    const probeBytes = Buffer.byteLength(probeText);
    try {
      writeSyntheticSessionLog(trHome, trWorkspace, trSessionId);
      writeFileSync(join(trWorkspace, probeRel), probeText);
      process.env.DSH_HOME = trHome;

      const emptyList = await requestJson(server.base, trashListUrl());
      check(
        'empty trash responds with zero totals',
        emptyList.status === 200 && emptyList.json && emptyList.json.ok === true && emptyList.json.batches.length === 0 && emptyList.json.totals.batches === 0 && emptyList.json.totals.files === 0 && emptyList.json.totals.bytes === 0,
        emptyList.json,
      );
      check('trash list reports the default retention config', Boolean(emptyList.json.config) && emptyList.json.config.trashRetentionDays === 0, emptyList.json.config);

      const badScope = await requestJson(server.base, trashListUrl('&scope=everything'));
      check('bad trash scope is 400 bad-scope', badScope.status === 400 && badScope.json.code === 'bad-scope', badScope.status);

      const trashDelete = await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: trSessionId, scope: 'all' } });
      const movedPaths = Array.isArray(trashDelete.json && trashDelete.json.deleted) ? trashDelete.json.deleted : [];
      check('trash fixture delete moved the probe file', trashDelete.status === 200 && movedPaths.includes(probeRel), movedPaths);
      check('trash fixture delete removed the workspace copy', !existsSync(join(trWorkspace, probeRel)));

      const listed = await requestJson(server.base, trashListUrl());
      const listedBatches = Array.isArray(listed.json.batches) ? listed.json.batches : [];
      const batch = listedBatches.find((item) => item.ownerSessionId === trSessionId);
      check('trash list shows the new batch', listed.status === 200 && listedBatches.length === 1 && Boolean(batch), listed.json);
      check(
        'batch carries id, owner and createdAt',
        Boolean(batch) && batch.id === `${trSessionId}/${batch.createdAt}` && Number.isFinite(batch.createdAt) && batch.createdAt > 0,
        batch && batch.id,
      );
      check('batch reports whole-batch files and bytes', Boolean(batch) && batch.files === 1 && batch.bytes === probeBytes, batch && { files: batch.files, bytes: batch.bytes });
      check(
        'batch entries list the relative path and size',
        Boolean(batch) && batch.entries.length === 1 && batch.entries[0].path === probeRel && batch.entries[0].size === probeBytes && batch.truncated === false,
        batch && batch.entries,
      );
      check(
        'batch totals aggregate the listing',
        listed.json.totals.batches === 1 && listed.json.totals.files === 1 && listed.json.totals.bytes === probeBytes,
        listed.json.totals,
      );
      if (!batch) throw new Error('trash batch missing; aborting the trash section');

      // A manually planted batch under another session owner proves scope filtering.
      const foreignId = `session-${randomUUID()}`;
      const foreignBatchName = String(Date.now() - 1000);
      const foreignBatchId = `${foreignId}/${foreignBatchName}`;
      mkdirSync(join(trashBase, foreignId, foreignBatchName), { recursive: true });
      writeFileSync(join(trashBase, foreignId, foreignBatchName, 'foreign.bin'), 'zz');
      const allList = await requestJson(server.base, trashListUrl());
      const scopedList = await requestJson(server.base, trashListUrl('&scope=session'));
      check('scope all includes every owner', allList.json.totals.batches === 2 && allList.json.totals.files === 2 && allList.json.totals.bytes === probeBytes + 2, allList.json.totals);
      check(
        'scope session only lists this session',
        scopedList.status === 200 && scopedList.json.batches.length === 1 && scopedList.json.batches[0].ownerSessionId === trSessionId && scopedList.json.totals.batches === 1,
        scopedList.json.totals,
      );

      const batchDir = join(trashBase, trSessionId, String(batch.createdAt));
      const restored = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, { method: 'POST', body: { sessionId: trSessionId, batch: batch.id } });
      check('restore responds 200 and copies the batch back', restored.status === 200 && restored.json.ok === true && restored.json.restored.includes(probeRel), restored.json);
      check(
        'restore puts the file back into the workspace',
        existsSync(join(trWorkspace, probeRel)) && readFileSync(join(trWorkspace, probeRel), 'utf8') === probeText,
      );
      check('restore returns a rebuilt ledger', Boolean(restored.json.ledger) && restored.json.ledger.sessionId === trSessionId && Array.isArray(restored.json.ledger.nodes));
      check('restore keeps the trash copy (copy, not move)', existsSync(join(batchDir, probeRel)));

      const restoreAgain = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, { method: 'POST', body: { sessionId: trSessionId, batch: batch.id } });
      check(
        'restore never overwrites an existing file',
        restoreAgain.status === 200 && restoreAgain.json.restored.length === 0 && restoreAgain.json.skipped.some((item) => item.path === probeRel && item.reason === 'exists'),
        restoreAgain.json.skipped,
      );
      const restoreMissing = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, {
        method: 'POST',
        body: { sessionId: trSessionId, batch: batch.id, paths: ['not_in_batch.py'] },
      });
      check(
        'restore reports missing batch entries',
        restoreMissing.status === 200 && restoreMissing.json.skipped.some((item) => item.path === 'not_in_batch.py' && item.reason === 'missing'),
        restoreMissing.json.skipped,
      );
      const restoreBadPath = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, {
        method: 'POST',
        body: { sessionId: trSessionId, batch: batch.id, paths: ['../escape.txt'] },
      });
      check(
        'restore reports unsafe paths as bad-path',
        restoreBadPath.status === 200 && restoreBadPath.json.skipped.some((item) => item.reason === 'bad-path'),
        restoreBadPath.json.skipped,
      );
      const missingBatch = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, { method: 'POST', body: { sessionId: trSessionId, batch: `${trSessionId}/1` } });
      check('unknown batch is 404 batch-not-found', missingBatch.status === 404 && missingBatch.json.code === 'batch-not-found', missingBatch.status);
      const badBatch = await requestJson(server.base, `${ROUTE_PREFIX}/trash/restore`, { method: 'POST', body: { sessionId: trSessionId, batch: 'not-a-batch' } });
      check('malformed batch id is 400 bad-batch', badBatch.status === 400 && badBatch.json.code === 'bad-batch', badBatch.status);

      const emptyNeedsScope = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId } });
      check('empty without scope is 400 empty-scope-required', emptyNeedsScope.status === 400 && emptyNeedsScope.json.code === 'empty-scope-required', emptyNeedsScope.status);
      const zeroDays = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, olderThanDays: 0 } });
      check('olderThanDays 0 is rejected', zeroDays.status === 400 && zeroDays.json.code === 'empty-scope-required', zeroDays.status);
      const dryEmpty = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, batch: batch.id, dryRun: true } });
      check(
        'empty dryRun reports the batch without deleting it',
        dryEmpty.status === 200 && dryEmpty.json.dryRun === true && dryEmpty.json.removed.length === 1 && dryEmpty.json.removed[0].batch === batch.id && dryEmpty.json.removed[0].files === 1 && dryEmpty.json.totals.files === 1 && existsSync(join(batchDir, probeRel)),
        dryEmpty.json,
      );
      const realEmpty = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, batch: batch.id } });
      check(
        'empty really deletes the batch directory',
        realEmpty.status === 200 && realEmpty.json.removed.length === 1 && realEmpty.json.totals.files === 1 && realEmpty.json.totals.bytes === probeBytes && !existsSync(batchDir),
        realEmpty.json,
      );
      const afterEmpty = await requestJson(server.base, trashListUrl());
      check('empty leaves only the foreign batch listed', afterEmpty.json.batches.length === 1 && afterEmpty.json.batches[0].ownerSessionId === foreignId, afterEmpty.json.totals);
      const foreignEmpty = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, batch: foreignBatchId } });
      check("empty by batch removes another session's batch", foreignEmpty.status === 200 && foreignEmpty.json.removed.length === 1 && !existsSync(join(trashBase, foreignId)), foreignEmpty.json);

      // A fresh batch survives the olderThanDays filter.
      await new Promise((done) => setTimeout(done, 10));
      writeFileSync(join(trWorkspace, probeRel), probeText);
      await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: trSessionId, scope: 'all' } });
      const listedAgain = await requestJson(server.base, trashListUrl());
      const freshBatch = listedAgain.json.batches.find((item) => item.ownerSessionId === trSessionId);
      const freshBatchDir = freshBatch ? join(trashBase, trSessionId, String(freshBatch.createdAt)) : '';
      check('second delete creates a fresh trash batch', Boolean(freshBatch) && freshBatch.files === 1, listedAgain.json.totals);
      const keepFresh = await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, olderThanDays: 1 } });
      check(
        'olderThanDays 1 keeps fresh batches',
        keepFresh.status === 200 && keepFresh.json.removed.length === 0 && existsSync(freshBatchDir),
        keepFresh.json,
      );

      const configUrl = `${ROUTE_PREFIX}/config`;
      const badRetention = await requestJson(server.base, configUrl, { method: 'POST', body: { sessionId: trSessionId, trashRetentionDays: 5000 } });
      check('config rejects retention above 3650', badRetention.status === 400 && badRetention.json.code === 'bad-retention', badRetention.status);
      const fractional = await requestJson(server.base, configUrl, { method: 'POST', body: { sessionId: trSessionId, trashRetentionDays: 1.5 } });
      check('config rejects non-integer retention', fractional.status === 400 && fractional.json.code === 'bad-retention', fractional.status);
      const missingRetention = await requestJson(server.base, configUrl, { method: 'POST', body: { sessionId: trSessionId } });
      check('config requires trashRetentionDays', missingRetention.status === 400 && missingRetention.json.code === 'bad-retention', missingRetention.status);
      const savedConfig = await requestJson(server.base, configUrl, { method: 'POST', body: { sessionId: trSessionId, trashRetentionDays: 7 } });
      check(
        'config write responds 200 with the new setting',
        savedConfig.status === 200 && savedConfig.json.config.trashRetentionDays === 7 && Array.isArray(savedConfig.json.swept) && savedConfig.json.totals.files === 0,
        savedConfig.json,
      );
      const configPath = join(trHome, 'session-files', 'config.json');
      check('config write persists config.json', existsSync(configPath) && JSON.parse(readFileSync(configPath, 'utf8')).trashRetentionDays === 7, existsSync(configPath) ? readFileSync(configPath, 'utf8') : 'missing');

      // Age the fresh batch past the 7 day retention and let GET /trash sweep it.
      const oldEpoch = String(Date.now() - 40 * 86_400_000);
      if (freshBatch) renameSync(freshBatchDir, join(trashBase, trSessionId, oldEpoch));
      const sweptList = await requestJson(server.base, trashListUrl());
      check(
        'GET /trash sweeps batches older than the configured retention',
        sweptList.status === 200 && !sweptList.json.batches.some((item) => item.ownerSessionId === trSessionId) && !existsSync(join(trashBase, trSessionId, oldEpoch)),
        sweptList.json.totals,
      );

      // Retention 0 disables sweeping again.
      await new Promise((done) => setTimeout(done, 10));
      writeFileSync(join(trWorkspace, probeRel), probeText);
      await requestJson(server.base, `${ROUTE_PREFIX}/delete`, { method: 'POST', body: { sessionId: trSessionId, scope: 'all' } });
      const thirdList = await requestJson(server.base, trashListUrl());
      const thirdBatch = thirdList.json.batches.find((item) => item.ownerSessionId === trSessionId);
      const thirdOld = String(Date.now() - 40 * 86_400_000);
      if (thirdBatch) renameSync(join(trashBase, trSessionId, String(thirdBatch.createdAt)), join(trashBase, trSessionId, thirdOld));
      const offConfig = await requestJson(server.base, configUrl, { method: 'POST', body: { sessionId: trSessionId, trashRetentionDays: 0 } });
      check('config 0 disables retention', offConfig.status === 200 && offConfig.json.config.trashRetentionDays === 0 && offConfig.json.swept.length === 0, offConfig.json);
      const stillThere = await requestJson(server.base, trashListUrl());
      check('retention 0 keeps old batches', stillThere.status === 200 && stillThere.json.batches.some((item) => item.ownerSessionId === trSessionId), stillThere.json.totals);
      const cleanupBatch = stillThere.json.batches.find((item) => item.ownerSessionId === trSessionId);
      if (cleanupBatch) await requestJson(server.base, `${ROUTE_PREFIX}/trash/empty`, { method: 'POST', body: { sessionId: trSessionId, batch: cleanupBatch.id } });
      check('trash fixture cleanup removed its session directory', !existsSync(join(trashBase, trSessionId)));

      // apply() sweeps expired trash when the plugin loads (contract section 10).
      const applyHome = mkdtempSync(join(tmpdir(), 'dsh-sf-applyhome-'));
      const applyStateDir = join(applyHome, 'session-files');
      const applyBatchDir = join(applyStateDir, 'trash', trSessionId, String(Date.now() - 40 * 86_400_000));
      try {
        mkdirSync(applyBatchDir, { recursive: true });
        writeFileSync(join(applyBatchDir, 'expired.bin'), 'old');
        writeFileSync(join(applyStateDir, 'config.json'), JSON.stringify({ version: 1, trashRetentionDays: 3 }));
        process.env.DSH_HOME = applyHome;
        const unmountSweep = mountPlugin([]);
        try {
          const sweptOnApply = await waitFor(() => !existsSync(applyBatchDir));
          check('apply() sweeps expired trash batches on plugin load', sweptOnApply);
        } finally {
          unmountSweep();
        }
      } finally {
        process.env.DSH_HOME = trHome;
        rmSync(applyHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(trHome, { recursive: true, force: true });
      rmSync(trWorkspace, { recursive: true, force: true });
    }
  } finally {
    process.env.DSH_HOME = originalHome;
    await server.close();
    unmount();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpWorkspace, { recursive: true, force: true });
    const realStateAfter = existsSync(join(home, 'session-files'));
    process.stdout.write(`\nreal ${join(home, 'session-files')} untouched: ${realStateAfter === realStateBefore}\n`);
    if (realStateAfter !== realStateBefore) {
      failed += 1;
      failures.push('the real DSH_HOME session-files directory changed during the run');
    }
  }

  section('summary');
  process.stdout.write(`PASS ${passed} / FAIL ${failed}\n`);
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  exitCode = failed === 0 ? 0 : 1;
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stdout.write(`\nFATAL ${String((error && error.stack) || error)}\n`);
  process.exitCode = 1;
});
