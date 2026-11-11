// dsh-session-files - host half.
//
// Provides:
//   1. an HTTP API under `/api/session-files` (ledger / classify / delete / preview)
//      consumed by the browser half in ./client.js,
//   2. the `session_files` agent tool (list / classify / cleanup),
//   3. a short system-prompt section that teaches the model the cleanup ritual.
//
// The HTTP handlers and the agent tool share one implementation (`createMethods`)
// so the two callers can never drift apart. Every optional service is looked up
// with `ctx.get(...)`; when one is missing the related feature is skipped instead
// of failing plugin loading.
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { buildLedger, shouldSkipDir } from './host/ledger.mjs';
import { readSessionLog } from './host/logreader.mjs';
import {
  CLASSES,
  dshHome,
  isInside,
  normalizeRelPath,
  previewFile,
  readGone,
  readOverrides,
  resolveWorkspacePath,
  setOverride,
  trashFiles,
  updateGone,
} from './host/store.mjs';

export const name = 'dsh-session-files';
// The web server is mandatory: without it there is nothing to serve. The other
// services (sessions / tools / systemPrompt / workingDirectory) are optional.
export const inject = ['webServer'];

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 1_000_000;
const ROUTE_PREFIX = '/api/session-files';

const LANES = ['deliverable', 'process', 'input', 'temp'];
const LANE_SET = new Set(LANES);
const CLS_SET = new Set(CLASSES);
// Session event types the ledger understands; everything else is dropped before
// the pure ledger builder sees it (session logs are noisy).
const KEEP_EVENT_TYPES = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result']);

const MAX_SCAN_FILES = 600;
// Temp paths whose existence is checked on every ledger build. Above this the
// pruning hint is simply not offered; cleanup still stats everything it touches.
const MAX_TEMP_STAT = 400;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = MAX_SCAN_FILES * 8;
const SCAN_CONCURRENCY = 8;
const PREVIEW_DEFAULT_BYTES = 65536;

const TOOL_NAME = 'session_files';
const LIST_ROW_BUDGET = 108;

// ----- small helpers -------------------------------------------------------

function warn(ctx, message, error) {
  try {
    const detail = error ? `: ${String((error && error.message) || error)}` : '';
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[dsh-session-files] ${message}${detail}`);
  } catch {
    // logging must never break a request path
  }
}

/** Look up an optional service without ever throwing. */
function optionalService(ctx, key) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    // service missing or not ready yet
  }
  try {
    return ctx ? ctx[key] : undefined;
  } catch {
    return undefined;
  }
}

/** Run a registration inside `ctx.effect` when available. */
function runEffect(ctx, factory) {
  try {
    if (ctx && typeof ctx.effect === 'function') return ctx.effect(factory);
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  } catch (error) {
    warn(ctx, 'effect registration failed', error);
    return () => {};
  }
}

function fail(code, params, extra) {
  const body = { ok: false, code };
  if (params !== undefined) body.params = params;
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return body;
}

function json(res, status, value, extraHeaders) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // socket already gone
    }
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(value));
}

function internalError(res, error) {
  return json(res, 500, fail('internal', { message: String((error && error.message) || error) }));
}

function headerOf(headers, key) {
  if (!headers) return undefined;
  const value = headers[key] !== undefined ? headers[key] : headers[key.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  const parts = String(hostname).split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/**
 * Loopback guard copied from dsh-session-remover: reject cross-origin and
 * non-loopback callers. Returns 0 when the request may proceed.
 */
function requestRejection(req) {
  const headers = (req && req.headers) || {};
  const hostUrl = parseAuthority(headerOf(headers, 'host') ?? '');
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return 403;
  if (headerOf(headers, 'sec-fetch-site') === 'cross-site') return 403;
  const origin = headerOf(headers, 'origin');
  if (origin === undefined) return 0;
  try {
    return new URL(origin).host === hostUrl.host ? 0 : 403;
  } catch {
    return 403;
  }
}

async function readBody(req) {
  const declared = headerOf(req.headers, 'content-length');
  if (declared !== undefined && Number(declared) > BODY_LIMIT) return { error: 'body-too-large' };
  let raw = '';
  try {
    if (typeof req.setEncoding === 'function') req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > BODY_LIMIT) return { error: 'body-too-large' };
    }
  } catch {
    return { error: 'body-read-failed' };
  }
  if (raw.trim().length === 0) return { value: {} };
  try {
    const value = JSON.parse(raw);
    return { value: value && typeof value === 'object' && !Array.isArray(value) ? value : {} };
  } catch {
    return { error: 'bad-json' };
  }
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://localhost');
  } catch {
    return null;
  }
}

function methodNotAllowed(res, allowed) {
  return json(res, 405, fail('method-not-allowed'), { allow: allowed });
}

function toPosix(pathname) {
  return pathname.split(/[\\/]/).join('/');
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '-';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateText(value, limit) {
  const text = String(value == null ? '' : value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}\u2026`;
}

function mergeWarnings(...lists) {
  const out = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const text = typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.code ?? item.message ?? '') : '';
      if (text.length === 0 || out.includes(text)) continue;
      out.push(text);
    }
  }
  return out;
}

// ----- session data loading (contract section 2) ----------------------------

function sessionIdVariants(sessionId) {
  const variants = [sessionId];
  if (sessionId.startsWith('session-')) variants.push(sessionId.slice('session-'.length));
  else variants.push(`session-${sessionId}`);
  return variants;
}

function pickSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return SESSION_ID_RE.test(trimmed) ? trimmed : '';
}

function findLiveSession(ctx, sessionId) {
  let sessions;
  try {
    sessions = optionalService(ctx, 'sessions');
  } catch {
    sessions = undefined;
  }
  if (!sessions || typeof sessions.get !== 'function') return null;
  for (const id of sessionIdVariants(sessionId)) {
    try {
      const session = sessions.get(id);
      if (session) return session;
    } catch {
      // ignore lookup failures, fall through to the log file
    }
  }
  return null;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (!KEEP_EVENT_TYPES.has(event.type)) return null;
  return {
    type: event.type,
    seq: Number.isFinite(event.seq) ? event.seq : 0,
    time: Number.isFinite(event.time) ? event.time : 0,
    // `tool/call.data.arguments` is a JSON string and is intentionally kept as-is;
    // the ledger parses it itself.
    data: event.data && typeof event.data === 'object' ? event.data : {},
  };
}

function liveEvents(session) {
  const events = [];
  try {
    const to = Number(session.seq);
    const snapshot = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0, Number.isFinite(to) ? to : 0) : [];
    for (const event of Array.isArray(snapshot) ? snapshot : []) {
      const normalized = normalizeEvent(event);
      if (normalized) events.push(normalized);
    }
  } catch (error) {
    // A broken snapshot must not lose the request; caller sees an empty event list.
  }
  return events;
}

function sessionCreatedAtOf(header) {
  const value = header && header.createdAt;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function pathExists(pathname) {
  try {
    await stat(pathname);
    return true;
  } catch {
    return false;
  }
}

function sessionsRoot() {
  return join(dshHome(), 'sessions');
}

/** Locate `<home>/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd` for a session. */
async function findSessionLog(sessionId) {
  const root = sessionsRoot();
  let slugs;
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return { file: null, reason: 'sessions-unreadable' };
  }
  const variants = sessionIdVariants(sessionId);
  for (const entry of slugs) {
    if (!entry.isDirectory()) continue;
    const slugDir = join(root, entry.name);
    for (const id of variants) {
      const file = join(slugDir, id, 'session.v4.jsonl.zstd');
      if (await pathExists(file)) return { file };
    }
  }
  return { file: null, reason: 'no-log' };
}

/**
 * Load a session header + the event types the ledger needs.
 * @returns {Promise<{ok: true, source: 'live'|'log', live: boolean, header: object, events: object[], session: object|null, warnings: string[]} | {ok: false, code: string, status: number, params?: object}>}
 */
async function loadSession(ctx, sessionId) {
  const live = findLiveSession(ctx, sessionId);
  if (live) {
    return {
      ok: true,
      source: 'live',
      live: true,
      header: live.header && typeof live.header === 'object' ? live.header : {},
      events: liveEvents(live),
      session: live,
      warnings: [],
    };
  }

  const found = await findSessionLog(sessionId);
  if (!found.file) {
    return {
      ok: false,
      code: 'session-not-found',
      status: 404,
      params: { reason: String(found.reason || 'no-log') },
      warnings: ['log-missing'],
    };
  }

  let parsed;
  try {
    parsed = readSessionLog(found.file);
  } catch (error) {
    // The log exists but cannot be decoded: still a 404, with a distinct reason.
    return { ok: false, code: 'session-not-found', status: 404, params: { reason: 'log-unreadable' }, warnings: ['log-unreadable'] };
  }
  if (!parsed || !parsed.header) {
    return { ok: false, code: 'session-not-found', status: 404, params: { reason: 'log-unreadable' }, warnings: ['log-unreadable'] };
  }
  const header = parsed.header;
  if (sessionCreatedAtOf(header) === null) {
    // Older logs may still be serviceable; keep the ledger usable but tell the UI.
  }

  const events = [];
  for (const event of Array.isArray(parsed.events) ? parsed.events : []) {
    const normalized = normalizeEvent(event);
    if (normalized) events.push(normalized);
  }
  events.sort((a, b) => a.seq - b.seq);

  const warnings = [];
  if (parsed.badFrames > 0) warnings.push('log-decode-errors');
  return { ok: true, source: 'log', live: false, header, events, session: null, warnings };
}

/** Workspace path: header.cwd first, then the working-directory service. */
function workspacePathOf(ctx, session, header) {
  if (header && typeof header.cwd === 'string' && header.cwd.trim().length > 0) return resolve(header.cwd.trim());
  try {
    const workingDirectory = optionalService(ctx, 'workingDirectory');
    if (workingDirectory && typeof workingDirectory.get === 'function' && session) {
      const value = workingDirectory.get(session);
      if (typeof value === 'string' && value.trim().length > 0) return resolve(value.trim());
    }
  } catch {
    // optional service: fall through
  }
  return null;
}

// ----- workspace scan (contract section 2) ----------------------------------

/**
 * Shallow (depth <= 6, <= 600 files) iterative workspace scan.
 * Directory pruning comes from ledger.mjs (`shouldSkipDir`, driven by its
 * `SKIP_DIR_PATTERNS` table) so the scanner and the classifier cannot drift.
 * @returns {Promise<{files: Array<{relPath: string, size: number, mtime: number, birthtime: number}>, total: number, warnings: string[]}>}
 */
async function scanWorkspace(absDir) {
  const files = [];
  const warnings = [];
  if (typeof absDir !== 'string' || absDir.trim().length === 0) return { files, total: 0, warnings: ['no-workspace'] };

  const root = resolve(absDir);
  let home;
  try {
    home = resolve(dshHome());
  } catch {
    home = null;
  }

  const collected = [];
  const stack = [{ dir: root, depth: 0 }];
  let overCapacity = false;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      warnings.push(depth === 0 ? 'scan-root-unreadable' : 'scan-dir-unreadable');
      continue;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_SCAN_DEPTH) continue;
        if (shouldSkipDir(entry.name)) continue;
        if (home && isInside(home, absolute)) continue;
        stack.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (collected.length >= MAX_SCAN_ENTRIES) {
        overCapacity = true;
        break;
      }
      if (entry.isSymbolicLink()) {
        // Symlinks are always skipped: a link can point outside the workspace, and
        // following it would leak that path into the ledger and into /preview.
        warnings.push('scan-symlink-skipped');
        continue;
      }
      collected.push(absolute);
    }
    if (overCapacity) break;
  }

  const records = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < collected.length) {
      const absolute = collected[cursor];
      cursor += 1;
      try {
        const info = await stat(absolute);
        if (!info.isFile()) continue;
        const relPath = relative(root, absolute);
        if (relPath.length === 0 || relPath.startsWith('..')) continue;
        records.push({
          relPath: toPosix(relPath),
          size: Number(info.size) || 0,
          mtime: Math.round(Number(info.mtimeMs) || 0),
          birthtime: Math.round(Number(info.birthtimeMs) || 0),
        });
      } catch {
        // unreadable entry: skip silently
      }
    }
  };
  const workers = Math.min(SCAN_CONCURRENCY, Math.max(1, collected.length));
  await Promise.all(Array.from({ length: workers }, worker));

  for (const record of records) {
    if (record.relPath.length === 0 || record.relPath.startsWith('..')) continue;
    files.push(record);
  }

  files.sort((a, b) => b.mtime - a.mtime || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  // Total before the 600-file cap, so the ledger can report the real workspace size.
  const total = files.length;
  const limited = files.slice(0, MAX_SCAN_FILES);
  limited.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  if (files.length > MAX_SCAN_FILES || overCapacity) warnings.push('scan-truncated');
  return { files: limited, total, warnings };
}

// ----- ledger assembly -----------------------------------------------------

function ledgerCounts(ledger, nodes) {
  const counts = ledger && typeof ledger.counts === 'object' && ledger.counts !== null ? ledger.counts : {};
  const paths = new Set();
  for (const node of nodes) {
    if (node && typeof node.path === 'string' && node.exists !== false) paths.add(node.path);
  }
  const out = {};
  for (const lane of LANES) out[lane] = Number.isFinite(counts[lane]) ? counts[lane] : 0;
  out.files = Number.isFinite(counts.files) ? counts.files : paths.size;
  return out;
}

/** Add the fields the contract puts on the HTTP/tool boundary (live/source/generatedAt). */
function withTempMissing(counts, rawLedger) {
  // ledgerCounts() derives every lane from nodes, which cannot know about files that are
  // already gone. Keep the stale-record count the ledger build measured (contract section 5).
  const stale = rawLedger && rawLedger.counts && typeof rawLedger.counts.tempMissing === 'number' ? rawLedger.counts.tempMissing : 0;
  if (stale > 0 && counts && typeof counts === 'object') counts.tempMissing = stale;
  return counts;
}

function finalizeLedger(rawLedger, meta) {
  const nodes = Array.isArray(rawLedger && rawLedger.nodes) ? rawLedger.nodes : [];
  const ledger = {
    ...(rawLedger && typeof rawLedger === 'object' ? rawLedger : {}),
    sessionId: typeof rawLedger?.sessionId === 'string' ? rawLedger.sessionId : meta.sessionId,
    workspacePath: rawLedger && 'workspacePath' in rawLedger ? rawLedger.workspacePath : meta.workspacePath,
    sessionCreatedAt: rawLedger && 'sessionCreatedAt' in rawLedger ? rawLedger.sessionCreatedAt : meta.sessionCreatedAt,
    generatedAt: Date.now(),
    live: typeof rawLedger?.live === 'boolean' ? rawLedger.live : meta.live,
    source: rawLedger?.source === 'live' || rawLedger?.source === 'log' ? rawLedger.source : meta.source,
    counts: withTempMissing(ledgerCounts(rawLedger, nodes), rawLedger),
    lanes: Array.isArray(rawLedger?.lanes) && rawLedger.lanes.length === LANES.length ? rawLedger.lanes : LANES,
    columns: Array.isArray(rawLedger?.columns) ? rawLedger.columns : [],
    nodes,
    edges: Array.isArray(rawLedger?.edges) ? rawLedger.edges : [],
    warnings: mergeWarnings(rawLedger?.warnings, meta.warnings),
  };
  return ledger;
}

// ----- shared implementation (HTTP + tool) ---------------------------------

function createMethods(ctx) {
  /** Build the full ledger for one session (contract section 5). */
  async function buildLedgerFor(sessionId) {
    const loaded = await loadSession(ctx, sessionId);
    if (!loaded.ok) return loaded;

    const workspacePath = workspacePathOf(ctx, loaded.session, loaded.header);
    const sessionCreatedAt = sessionCreatedAtOf(loaded.header);
    const warnings = [...loaded.warnings];

    let scanFiles = [];
    let scanTotal = null;
    if (workspacePath) {
      const scan = await scanWorkspace(workspacePath);
      scanFiles = scan.files;
      scanTotal = Number.isInteger(scan.total) ? scan.total : scanFiles.length;
      warnings.push(...scan.warnings);
    } else {
      warnings.push('no-workspace');
    }

    const overrides = await readOverrides(sessionId);
    const gonePaths = await readGone(sessionId);
    // buildLedger is pure: the caller supplies the clock, the live flag, the source and the
    // per-turn start times (contract section 3). Warnings are forwarded so the ledger can carry them.
    const turnTimes = new Map();
    for (const event of loaded.events) {
      if (event && event.type === 'turn/start') {
        const turn = Number(event.data && event.data.turn);
        if (Number.isFinite(turn) && !turnTimes.has(turn)) turnTimes.set(turn, Number(event.time) || 0);
      }
    }
    let rawLedger;
    try {
      rawLedger = buildLedger({
        sessionId,
        workspacePath,
        sessionCreatedAt,
        events: loaded.events,
        scanFiles,
        scanTotal,
        overrides,
        gonePaths,
        generatedAt: Date.now(),
        live: loaded.live === true,
        source: loaded.source === 'live' ? 'live' : 'log',
        turnTimes,
        warnings,
      });
    } catch (error) {
      return { ok: false, code: 'ledger-failed', status: 500, params: { message: String((error && error.message) || error) } };
    }
    if (!rawLedger || typeof rawLedger !== 'object') {
      return { ok: false, code: 'ledger-failed', status: 500 };
    }

    // Temp records whose file is already gone are still part of the history, but
    // both halves must say so: `exists:false` lets the list/UI mark them, and
    // `counts.tempMissing` tells the cleanup path how many stale records it can
    // forget. Without this the panel claims "178 temp files" while cleanup moves 0.
    if (workspacePath && Array.isArray(rawLedger.nodes) && rawLedger.nodes.length > 0) {
      const checkedPaths = [];
      const checked = new Set();
      for (const node of rawLedger.nodes) {
        if (!node || node.lane !== 'temp' || typeof node.path !== 'string') continue;
        if (checked.has(node.path)) continue;
        checked.add(node.path);
        if (checkedPaths.length >= MAX_TEMP_STAT) break;
        checkedPaths.push(node.path);
      }
      if (checkedPaths.length > 0) {
        const present = new Set(await existingWorkspaceFiles(workspacePath, checkedPaths));
        const missing = new Set();
        for (const rel of checkedPaths) {
          if (!present.has(rel)) missing.add(rel);
        }
        if (missing.size > 0) {
          for (const node of rawLedger.nodes) {
            if (!node || node.lane !== 'temp' || typeof node.path !== 'string') continue;
            if (missing.has(node.path)) node.exists = false;
          }
          rawLedger.counts = rawLedger.counts && typeof rawLedger.counts === 'object' ? rawLedger.counts : {};
          rawLedger.counts.tempMissing = missing.size;
        }
      }
    }
    return {
      ok: true,
      ledger: finalizeLedger(rawLedger, {
        sessionId,
        workspacePath,
        sessionCreatedAt,
        live: loaded.live,
        source: loaded.source,
        warnings,
      }),
    };
  }

  function overrideCleanupError(error) {
    const code = error && error.code;
    if (code === 'bad-path') return { ok: false, code: 'bad-path', status: 400 };
    if (code === 'bad-cls') return { ok: false, code: 'bad-cls', status: 400 };
    if (code === 'bad-note') return { ok: false, code: 'bad-note', status: 400 };
    if (code === 'bad-session-id') return { ok: false, code: 'bad-session-id', status: 400 };
    return { ok: false, code: 'store-failed', status: 500, params: { message: String((error && error.message) || error) } };
  }

  /**
   * Apply one or more classification changes, then rebuild the ledger.
   * @param {Array<{path: string, cls: string|null, note?: string}>} entries
   */
  async function classifyManyFor(sessionId, entries) {
    const prepared = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const rel = normalizeRelPath(entry && entry.path);
      if (rel === null) return { ok: false, code: 'bad-path', status: 400, params: { path: String((entry && entry.path) ?? '') } };
      // `cls` is tri-state: undefined = patch/keep the existing override,
      // null = clear the override, a class name = set it.
      const cls = entry && entry.cls !== undefined ? entry.cls : undefined;
      if (cls !== undefined && cls !== null && !CLS_SET.has(cls)) return { ok: false, code: 'bad-cls', status: 400 };
      let note;
      if (entry && entry.note !== undefined) {
        if (entry.note !== null && typeof entry.note !== 'string') return { ok: false, code: 'bad-note', status: 400 };
        note = entry.note === null ? '' : entry.note;
      }
      prepared.push({ rel, cls, note });
    }
    if (prepared.length === 0) return { ok: false, code: 'bad-path', status: 400 };

    try {
      for (const item of prepared) {
        const patch = {};
        if (item.cls !== undefined) patch.cls = item.cls;
        if (item.note !== undefined) patch.note = item.note;
        await setOverride(sessionId, item.rel, patch);
      }
    } catch (error) {
      return overrideCleanupError(error);
    }
    return buildLedgerFor(sessionId);
  }

  async function classifyFor(sessionId, relPath, cls, note) {
    return classifyManyFor(sessionId, [{ path: relPath, cls, note }]);
  }

  /** Filter `rels` down to the ones that still exist as regular files inside the workspace. */
  async function existingWorkspaceFiles(workspacePath, rels) {
    const existing = [];
    for (let index = 0; index < rels.length; index += SCAN_CONCURRENCY) {
      const chunk = rels.slice(index, index + SCAN_CONCURRENCY);
      const checks = await Promise.all(
        chunk.map(async (rel) => {
          try {
            const resolved = resolveWorkspacePath(workspacePath, rel);
            const info = await stat(resolved.absolute);
            return info.isFile() === true;
          } catch {
            return false;
          }
        }),
      );
      for (let offset = 0; offset < chunk.length; offset += 1) {
        if (checks[offset]) existing.push(chunk[offset]);
      }
    }
    return existing;
  }

  /**
   * Temp paths the current ledger allows `/delete` to touch (contract section 6).
   * `scope === 'tree'` only honours explicit temp nodes; `scope === 'all'` also
   * pulls in the scan backlog (`ledger.workspace.tempPaths`) that never reached
   * a node because no tool call touched it.
   */
  function ledgerTempPaths(ledger, scope) {
    const tempNodePaths = new Set();
    for (const node of Array.isArray(ledger.nodes) ? ledger.nodes : []) {
      if (!node || typeof node.path !== 'string') continue;
      const rel = normalizeRelPath(node.path);
      if (rel === null) continue;
      if (node.lane === 'temp') tempNodePaths.add(rel);
    }
    const backlog = [];
    const workspace = ledger.workspace;
    if (workspace && Array.isArray(workspace.tempPaths)) {
      for (const value of workspace.tempPaths) {
        const rel = normalizeRelPath(value);
        if (rel !== null) backlog.push(rel);
      }
    }
    const allowed = new Set(tempNodePaths);
    if (scope === 'all') {
      for (const rel of backlog) allowed.add(rel);
    }
    return { allowed, tempNodePaths, backlog };
  }

  /**
   * Delete workspace files by moving them to the plugin trash (contract section 6).
   * Only `temp` paths are ever touched and the client's own classification is
   * never trusted: the freshly rebuilt ledger decides. `scope: 'all'` (default)
   * also cleans the scan backlog; `dryRun` returns the exact list without
   * touching the disk.
   */
  async function deleteFor(sessionId, paths, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const scope = settings.scope === 'tree' ? 'tree' : 'all';
    const dryRun = settings.dryRun === true;
    const requested = [];
    const skipped = [];
    for (const value of Array.isArray(paths) ? paths : []) {
      const rel = normalizeRelPath(value);
      if (rel === null) {
        skipped.push(typeof value === 'string' ? value : String(value));
        continue;
      }
      if (!requested.includes(rel)) requested.push(rel);
    }

    const built = await buildLedgerFor(sessionId);
    if (!built.ok) return built;
    const ledger = built.ledger;
    const workspacePath = ledger.workspacePath;
    if (!workspacePath) return { ok: false, code: 'no-workspace', status: 404 };

    const { allowed, tempNodePaths, backlog } = ledgerTempPaths(ledger, scope);
    const candidates = [];
    for (const rel of requested) {
      if (allowed.has(rel)) candidates.push(rel);
      else if (!skipped.includes(rel)) skipped.push(rel);
    }
    if (scope === 'all') {
      for (const rel of tempNodePaths) {
        if (!candidates.includes(rel)) candidates.push(rel);
      }
      for (const rel of backlog) {
        if (!candidates.includes(rel)) candidates.push(rel);
      }
    }

    const deletable = await existingWorkspaceFiles(workspacePath, candidates);
    const deletableSet = new Set(deletable);
    // Candidates that are not on disk are stale ledger records, not failures: the
    // file was already moved to trash (possibly by another session) or deleted from
    // outside. Cleanup forgets those records so the counters finally match reality.
    const pruned = [];
    for (const rel of candidates) {
      if (!deletableSet.has(rel) && !pruned.includes(rel)) pruned.push(rel);
    }
    if (dryRun) return { ok: true, dryRun: true, deleted: deletable, pruned, skipped, ledger };
    if (deletable.length === 0 && pruned.length === 0) return { ok: true, deleted: [], pruned: [], skipped, ledger };

    let deleted = [];
    try {
      const result = await trashFiles(sessionId, workspacePath, deletable);
      deleted = Array.isArray(result.deleted) ? result.deleted : [];
      for (const rel of Array.isArray(result.skipped) ? result.skipped : []) {
        if (!deleted.includes(rel) && !skipped.includes(rel)) skipped.push(rel);
      }
    } catch (error) {
      return { ok: false, code: 'trash-failed', status: 500, params: { message: String((error && error.message) || error) } };
    }

    // Only forget paths that are really gone: a path whose trash move failed is
    // still on disk and must keep its record. A pruned path that is back on disk
    // and now deleted also leaves the gone list.
    const movedSet = new Set(deleted);
    const goneToAdd = pruned.filter((rel) => !movedSet.has(rel));
    if (goneToAdd.length > 0 || deleted.length > 0) {
      try {
        await updateGone(sessionId, { add: goneToAdd, remove: deleted });
      } catch (error) {
        return { ok: false, code: 'store-failed', status: 500, params: { message: String((error && error.message) || error) } };
      }
    }

    const rebuilt = await buildLedgerFor(sessionId);
    if (!rebuilt.ok) return rebuilt;
    return { ok: true, deleted, pruned: goneToAdd, skipped, ledger: rebuilt.ledger };
  }

  async function previewFor(sessionId, relPath, maxBytes) {
    const rel = normalizeRelPath(relPath);
    if (rel === null) return { ok: false, code: 'bad-path', status: 400 };
    const loaded = await loadSession(ctx, sessionId);
    if (!loaded.ok) return loaded;
    const workspacePath = workspacePathOf(ctx, loaded.session, loaded.header);
    if (!workspacePath) return { ok: false, code: 'no-workspace', status: 404 };
    let limit = Number(maxBytes);
    if (!Number.isFinite(limit) || limit <= 0) limit = PREVIEW_DEFAULT_BYTES;
    try {
      const preview = await previewFile(workspacePath, rel, limit);
      return { ok: true, path: rel, text: preview.text, truncated: preview.truncated, binary: preview.binary === true, bytes: preview.bytes };
    } catch (error) {
      const code = error && error.code;
      if (code === 'bad-path') return { ok: false, code: 'bad-path', status: 400 };
      if (code === 'file-not-found') return { ok: false, code: 'file-not-found', status: 404 };
      return { ok: false, code: 'preview-failed', status: 500, params: { message: String((error && error.message) || error) } };
    }
  }

  return { buildLedgerFor, classifyFor, classifyManyFor, deleteFor, previewFor };
}

// ----- HTTP routes (contract section 6) -------------------------------------

function createHandlers(methods) {
  const handleLedger = async (ctx, req, res) => {
    if (requestRejection(req) !== 0) return json(res, 403, fail('forbidden'));
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const url = parseRequestUrl(req);
    const sessionId = pickSessionId(url ? url.searchParams.get('sessionId') : '');
    if (!sessionId) return json(res, 400, fail('bad-session-id'));
    const built = await methods.buildLedgerFor(sessionId);
    if (!built.ok) return json(res, built.status || 500, fail(built.code, built.params, built.warnings ? { warnings: built.warnings } : undefined));
    return json(res, 200, { ok: true, ledger: built.ledger });
  };

  const handleClassify = async (ctx, req, res) => {
    if (requestRejection(req) !== 0) return json(res, 403, fail('forbidden'));
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readBody(req);
    if (body.error === 'body-too-large') return json(res, 413, fail('body-too-large'));
    if (body.error) return json(res, 400, fail(body.error));
    const value = body.value || {};
    const sessionId = pickSessionId(value.sessionId);
    if (!sessionId) return json(res, 400, fail('bad-session-id'));
    // Tri-state (contract section 6): omitted `cls` keeps the existing override, `cls: null`
    // clears it, a class string sets it. Only a note may accompany either form.
    const cls = value.cls === undefined ? undefined : value.cls;
    const result = await methods.classifyFor(sessionId, value.path, cls, value.note);
    if (!result.ok) return json(res, result.status || 500, fail(result.code, result.params, result.warnings ? { warnings: result.warnings } : undefined));
    return json(res, 200, { ok: true, ledger: result.ledger });
  };

  const handleDelete = async (ctx, req, res) => {
    if (requestRejection(req) !== 0) return json(res, 403, fail('forbidden'));
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readBody(req);
    if (body.error === 'body-too-large') return json(res, 413, fail('body-too-large'));
    if (body.error) return json(res, 400, fail(body.error));
    const value = body.value || {};
    const sessionId = pickSessionId(value.sessionId);
    if (!sessionId) return json(res, 400, fail('bad-session-id'));
    if (value.paths !== undefined && !Array.isArray(value.paths)) return json(res, 400, fail('bad-path'));
    const scope = value.scope === undefined ? 'all' : value.scope;
    if (scope !== 'all' && scope !== 'tree') return json(res, 400, fail('bad-scope'));
    if (value.dryRun !== undefined && typeof value.dryRun !== 'boolean') return json(res, 400, fail('bad-dry-run'));
    const result = await methods.deleteFor(sessionId, value.paths, { scope, dryRun: value.dryRun === true });
    if (!result.ok) return json(res, result.status || 500, fail(result.code, result.params, result.warnings ? { warnings: result.warnings } : undefined));
    const payload = { ok: true, deleted: result.deleted, pruned: result.pruned || [], skipped: result.skipped, ledger: result.ledger };
    if (result.dryRun === true) payload.dryRun = true;
    return json(res, 200, payload);
  };

  const handlePreview = async (ctx, req, res) => {
    if (requestRejection(req) !== 0) return json(res, 403, fail('forbidden'));
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const url = parseRequestUrl(req);
    const sessionId = pickSessionId(url ? url.searchParams.get('sessionId') : '');
    if (!sessionId) return json(res, 400, fail('bad-session-id'));
    const rawPath = url ? url.searchParams.get('path') : '';
    const rawMax = url ? url.searchParams.get('maxBytes') : null;
    let maxBytes;
    if (rawMax !== null && rawMax.trim().length > 0) {
      const parsed = Number(rawMax);
      maxBytes = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    const result = await methods.previewFor(sessionId, rawPath, maxBytes);
    if (!result.ok) return json(res, result.status || 500, fail(result.code, result.params, result.warnings ? { warnings: result.warnings } : undefined));
    return json(res, 200, {
      ok: true,
      path: result.path,
      text: result.text,
      truncated: result.truncated === true,
      binary: result.binary === true,
      bytes: result.bytes,
    });
  };

  return { handleLedger, handleClassify, handleDelete, handlePreview };
}

function registerRoutes(ctx, methods) {
  const webServer = optionalService(ctx, 'webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    warn(ctx, 'webServer service unavailable; HTTP routes disabled');
    return;
  }
  const handlers = createHandlers(methods);
  const routes = [
    { path: `${ROUTE_PREFIX}/ledger`, handler: handlers.handleLedger },
    { path: `${ROUTE_PREFIX}/classify`, handler: handlers.handleClassify },
    { path: `${ROUTE_PREFIX}/delete`, handler: handlers.handleDelete },
    { path: `${ROUTE_PREFIX}/preview`, handler: handlers.handlePreview },
  ];
  for (const route of routes) {
    runEffect(ctx, () =>
      webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          try {
            await route.handler(ctx, req, res);
          } catch (error) {
            warn(ctx, `route ${route.path} failed`, error);
            internalError(res, error);
          }
        },
      }),
    );
  }
}

// ----- agent tool (contract section 8) -------------------------------------

const TOOL_DESCRIPTION = [
  'Inspect, classify and clean up the files THIS session created in its workspace.',
  'The tool builds a file ledger for the current session: every path touched by tool calls (write/edit/read/present/exec) plus files discovered by scanning the workspace, sorted into four lanes: deliverable (final artifacts), process (intermediates worth keeping), input (files that existed before the session), temp (throwaway probes, scratch scripts, logs, dumps).',
  '',
  'Actions:',
  '- "list": print the ledger as a compact table (lane, path, size, turns, reason).',
  '- "classify": set the lane for the given paths (cls = deliverable | process | input | temp) with an optional note. Mark one-off probe scripts, logs and throwaway output as "temp".',
  '- "cleanup": move the given paths to the plugin trash; only paths the ledger considers "temp" are moved, everything else is reported as skipped. Omit "paths" to clean up every temp path of this session, including historical temp files the tree does not show. Use "dryRun": true to preview the list without touching any file. Trashed files are recoverable, never destroyed.',
  '',
  'Wrap-up ritual: before finishing a task call action:"list" to see what this session left behind, mark one-off probes as "temp" with action:"classify", then run action:"cleanup". Present final deliverables with the present tool; keep scratch files in a subdirectory (e.g. .scratch/) instead of the workspace root.',
].join('\n');

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'classify', 'cleanup'],
      description: 'list = show the ledger; classify = set lanes for paths; cleanup = move temp paths to the trash.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspace-relative paths (posix, e.g. "scripts/probe.py"). Required for classify; optional for cleanup (default: every temp path, including temp files not shown in the tree).',
    },
    cls: {
      type: 'string',
      enum: CLASSES,
      description: 'Target lane for action:"classify".',
    },
    note: {
      type: 'string',
      description: 'Optional short note stored with the classification, e.g. why a file must be kept.',
    },
    dryRun: {
      type: 'boolean',
      description: 'For action:"cleanup": only report what would be moved to the trash; touch no files.',
    },
  },
  required: ['action'],
};

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      summary: { type: 'string' },
      ledger: { type: 'object' },
    },
    required: ['ok', 'action', 'summary'],
  },
  render(_args, value) {
    const summary = value && typeof value === 'object' ? value.summary : '';
    return [{ type: 'text', text: String(summary || '') }];
  },
};

/**
 * A tool body returns the *bare* output value; the runtime snapshots it, validates it
 * against `output.schema`, and turns `output.render(value)` into the transcript content
 * (`dsh-tools` -> `dispatchToolBody`: `const returned = await tool.execute(...)` then
 * `createSuccessResult(exec, tool, returned)`). Returning `{ isError, value, content }`
 * here is a hard error: the envelope fails the schema check and the real message is
 * replaced by `missing required property "value.ok"`.
 */
function toolValue(action, summary, ledger) {
  const value = { ok: true, action, summary };
  if (ledger) {
    value.ledger = {
      sessionId: ledger.sessionId,
      workspacePath: ledger.workspacePath,
      live: ledger.live === true,
      source: ledger.source,
      counts: ledger.counts,
    };
  }
  return value;
}

/** Failures are thrown: the runtime converts a thrown body error into the turn's error result. */
function toolError(message) {
  const text = String(message || 'session_files failed');
  const error = new Error(text);
  error.name = 'SessionFilesToolError';
  throw error;
}

function toolFailure(code, params) {
  const detail = params && params.message ? ` (${String(params.message)})` : '';
  toolError(`session_files failed: ${String(code)}${detail}`);
}

function executionSessionId(exec) {
  const agent = exec && exec.agent;
  if (agent) {
    // The live Agent exposes the Session it drives (`agent.session.id`); some builds
    // also expose a plain `agent.id`. Try the documented shape first, then the others.
    const session = agent.session;
    if (session && typeof session.id === 'string' && session.id.length > 0) return session.id;
    if (session && session.header && typeof session.header.id === 'string' && session.header.id.length > 0) return session.header.id;
    if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id;
  }
  const fallback = exec && exec.sessionId;
  if (typeof fallback === 'string' && SESSION_ID_RE.test(fallback)) return fallback;
  return '';
}

/** Compact per-lane rows, one line per (lane, path), merged across turns. */
function ledgerRows(ledger) {
  const groups = new Map();
  for (const node of Array.isArray(ledger.nodes) ? ledger.nodes : []) {
    if (!node || typeof node.path !== 'string') continue;
    const lane = LANE_SET.has(node.lane) ? node.lane : 'process';
    const path = normalizeRelPath(node.path);
    if (path === null) continue;
    const key = `${lane}\u0000${path}`;
    const col = Number.isFinite(node.col) ? node.col : -1;
    const turns = Array.isArray(node.turns) ? node.turns.filter((turn) => Number.isFinite(turn)) : [];
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { lane, path, node, col, turns: [...new Set(turns)] });
      continue;
    }
    for (const turn of turns) if (!existing.turns.includes(turn)) existing.turns.push(turn);
    if (col >= existing.col) {
      existing.node = node;
      existing.col = col;
    }
  }
  return LANES.map((lane) => [...groups.values()].filter((group) => group.lane === lane));
}

function listSummary(ledger) {
  const counts = ledger.counts || {};
  const lines = [];
  const workspace = typeof ledger.workspacePath === 'string' && ledger.workspacePath.length > 0 ? ledger.workspacePath : '(unknown)';
  lines.push(`session ${ledger.sessionId}  source ${ledger.source || '?'}${ledger.live ? ' (live)' : ''}  workspace ${workspace}`);
  lines.push(
    `counts: files ${counts.files || 0} | deliverable ${counts.deliverable || 0} | process ${counts.process || 0} | input ${counts.input || 0} | temp ${counts.temp || 0}`,
  );
  if (Array.isArray(ledger.warnings) && ledger.warnings.length > 0) lines.push(`warnings: ${ledger.warnings.join(', ')}`);

  const grouped = ledgerRows(ledger);
  const total = grouped.reduce((sum, rows) => sum + rows.length, 0);
  if (total === 0) {
    lines.push('(no files recorded for this session yet)');
  } else {
    let truncated = 0;
    for (let index = 0; index < LANES.length; index++) {
      const rows = grouped[index];
      if (rows.length === 0) continue;
      if (lines.length >= LIST_ROW_BUDGET) {
        truncated += rows.length;
        continue;
      }
      lines.push(`[${LANES[index]}] ${rows.length}`);
      for (const row of rows) {
        if (lines.length >= LIST_ROW_BUDGET) {
          truncated += 1;
          continue;
        }
        const node = row.node || {};
        const size = formatBytes(node.size);
        const turnText = row.turns.length > 0 ? `t${row.turns.slice(0, 6).join(',')}` : '-';
        const reason = typeof node.reason === 'string' ? node.reason : '';
        const missing = node.exists === false ? ' (missing)' : '';
        lines.push(`  ${row.path}  ${size}  ${turnText}  ${reason}${missing}`);
      }
    }
    if (truncated > 0) lines.push(`\u2026 ${truncated} more row(s) truncated`);
  }

  const tempCount = Number(counts.temp) || 0;
  const deliverableCount = Number(counts.deliverable) || 0;
  const backlog = ledger && ledger.workspace && Number.isFinite(ledger.workspace.tempPathCount) ? ledger.workspace.tempPathCount : 0;
  const treeTempCount = Array.isArray(ledger && ledger.nodes) ? ledger.nodes.filter((node) => node && node.lane === 'temp').length : 0;
  if (tempCount > 0) {
    const backlogText = backlog > 0 ? ` (${treeTempCount} in the tree below, ${backlog} more not shown)` : '';
    lines.push(`next: mark one-off probes/logs as temp (action:"classify", cls:"temp") if needed, then action:"cleanup" with no paths to move every temp file${backlogText} to the trash.`);
  } else if (deliverableCount > 0) {
    lines.push('next: nothing to clean up; present the deliverable files with the present tool.');
  } else {
    lines.push('next: nothing to clean up.');
  }
  return lines.join('\n');
}

function summarizeLedgerCounts(ledger) {
  const counts = (ledger && ledger.counts) || {};
  return `files ${counts.files || 0} (deliverable ${counts.deliverable || 0}, process ${counts.process || 0}, input ${counts.input || 0}, temp ${counts.temp || 0})`;
}

function createToolExecute(ctx, methods) {
  return async (args, exec) => {
    const sessionId = executionSessionId(exec);
    if (!sessionId) return toolError('session_files must run inside an agent session (exec.agent.id is missing)');
    const options = args && typeof args === 'object' ? args : {};
    const action = typeof options.action === 'string' ? options.action : '';
    try {
      if (action === 'list') {
        const built = await methods.buildLedgerFor(sessionId);
        if (!built.ok) return toolFailure(built.code, built.params);
        return toolValue('list', listSummary(built.ledger), built.ledger);
      }

      if (action === 'classify') {
        const paths = (Array.isArray(options.paths) ? options.paths : []).filter((value) => typeof value === 'string');
        if (paths.length === 0) return toolError('action "classify" requires a non-empty "paths" array');
        if (paths.length > 200) return toolError('action "classify" accepts at most 200 paths per call');
        const cls = typeof options.cls === 'string' ? options.cls : '';
        if (!CLS_SET.has(cls)) return toolError(`action "classify" requires "cls" (one of ${LANES.join(' | ')})`);
        const note = typeof options.note === 'string' ? options.note : undefined;
        const result = await methods.classifyManyFor(
          sessionId,
          paths.map((path) => ({ path, cls, note })),
        );
        if (!result.ok) return toolFailure(result.code, result.params);
        const noteText = note ? ` with note "${truncateText(note, 120)}"` : '';
        const summary = `classified ${paths.length} path(s) as ${cls}${noteText}; now ${summarizeLedgerCounts(result.ledger)}`;
        return toolValue('classify', summary, result.ledger);
      }

      if (action === 'cleanup') {
        const explicit = (Array.isArray(options.paths) ? options.paths : []).filter((value) => typeof value === 'string');
        if (explicit.length > 200) return toolError('action "cleanup" accepts at most 200 explicit paths per call');
        const dryRun = options.dryRun === true;
        // scope "all" also cleans the scan backlog: temp files that no tool call touched.
        const result = await methods.deleteFor(sessionId, explicit, { scope: 'all', dryRun });
        if (!result.ok) return toolFailure(result.code, result.params);
        const workspaceRemaining = result.ledger && result.ledger.workspace && Number.isFinite(result.ledger.workspace.tempPathCount) ? result.ledger.workspace.tempPathCount : 0;
        const remainingNodes = Array.isArray(result.ledger && result.ledger.nodes) ? result.ledger.nodes.filter((node) => node && node.lane === 'temp').length : 0;
        const pruned = Array.isArray(result.pruned) ? result.pruned : [];
        const lines = [`${dryRun ? 'dry run: would move' : 'moved'} ${result.deleted.length} temp file(s) to the plugin trash`];
        if (result.deleted.length === 0 && result.skipped.length === 0 && pruned.length === 0) {
          lines[0] = `nothing to clean up; ${summarizeLedgerCounts(result.ledger)}`;
        }
        if (pruned.length > 0) {
          const preview = pruned.slice(0, 8).join(', ');
          const more = pruned.length > 8 ? `, +${pruned.length - 8} more` : '';
          lines.push(
            `${dryRun ? 'would prune' : 'pruned'} ${pruned.length} stale record(s) (file already gone, nothing on disk was touched): ${preview}${more}`,
          );
        }
        if (result.skipped.length > 0) {
          const preview = result.skipped.slice(0, 8).join(', ');
          const more = result.skipped.length > 8 ? `, +${result.skipped.length - 8} more` : '';
          lines.push(`skipped ${result.skipped.length} path(s) that are not temp, missing, or outside the workspace: ${preview}${more}`);
        }
        if (dryRun) lines.push('dry run only: no file was touched; call again without dryRun to move them.');
        lines.push(`now ${summarizeLedgerCounts(result.ledger)}; workspaceRemaining ${workspaceRemaining} temp file(s) outside the tree, ${remainingNodes} temp node(s)`);
        return toolValue('cleanup', lines.join('\n'), result.ledger);
      }

      return toolError(`unknown action "${action}"; expected one of ${['list', 'classify', 'cleanup'].join(' | ')}`);
    } catch (error) {
      // Our own failures already carry a clean, user-facing message: rethrow as-is so the
      // runtime reports it verbatim instead of prefixing it twice.
      if (error && error.name === 'SessionFilesToolError') throw error;
      toolError(`session_files failed: ${String((error && error.message) || error)}`);
    }
  };
}

function registerTool(ctx, methods) {
  const tools = optionalService(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') {
    warn(ctx, 'tools service unavailable; session_files tool disabled');
    return;
  }
  const execute = createToolExecute(ctx, methods);
  const definition = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    execute,
    isConcurrencySafe(args) {
      return Boolean(args) && args.action !== 'cleanup';
    },
  };
  runEffect(ctx, () => tools.register(definition));
}

// ----- system prompt (contract section 9) -----------------------------------

const PROMPT_TEXT = [
  '[session-files] A file ledger tracks every file this session reads, writes or presents, sorted into deliverable / process / input / temp.',
  'Keep scratch scripts and logs in a subdirectory (e.g. .scratch/) instead of the workspace root; mark one-off files as temp with the session_files tool (action:"classify", cls:"temp").',
  'Before finishing a task, call session_files with action:"list", then action:"cleanup" to move the temp files to the trash (recoverable, never destroyed).',
  'Present final deliverables with the present tool; do not leave them unnoticed in the workspace root.',
].join('\n');

function registerPrompt(ctx) {
  const systemPrompt = optionalService(ctx, 'systemPrompt');
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    warn(ctx, 'systemPrompt service unavailable; prompt section disabled');
    return;
  }
  runEffect(ctx, () => systemPrompt.section({ name: 'session-files', order: 40, text: PROMPT_TEXT }));
}

// ----- plugin entry -------------------------------------------------------

export function apply(ctx) {
  let methods;
  try {
    methods = createMethods(ctx);
  } catch (error) {
    warn(ctx, 'failed to initialize session-files methods', error);
    return;
  }
  try {
    registerRoutes(ctx, methods);
  } catch (error) {
    warn(ctx, 'failed to register HTTP routes', error);
  }
  try {
    registerTool(ctx, methods);
  } catch (error) {
    warn(ctx, 'failed to register session_files tool', error);
  }
  try {
    registerPrompt(ctx);
  } catch (error) {
    warn(ctx, 'failed to register system prompt section', error);
  }
}
