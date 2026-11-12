// Durable state for dsh-session-files: per-session classification overrides,
// free-form notes, file previews and the trash directory used by cleanup.
//
// Everything is stored under $DSH_HOME (`<home>/session-files/...`) so the
// user's workspace never receives runtime data:
//   <home>/session-files/overrides/<sessionId>.json
//   <home>/session-files/trash/<sessionId>/<epochMs>/<relPath>
//   <home>/session-files/config.json
//
// Writes are atomic (temp file + rename) and serialized per state file, so two
// concurrent requests cannot interleave into a corrupted JSON file.
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const CLASSES = ['deliverable', 'process', 'input', 'temp'];
const CLASS_SET = new Set(CLASSES);
const NOTE_LIMIT = 2000;
const REL_PATH_LIMIT = 4096;
const PREVIEW_LIMIT_DEFAULT = 65536;
const PREVIEW_LIMIT_MAX = 1_000_000;
// Retention is an integer number of days; 0 disables the sweep (contract section 10).
const RETENTION_MIN = 0;
const RETENTION_MAX = 3650;
// `GET /trash` lists at most this many entries per batch (contract section 6);
// the batch's `files`/`bytes` counters always describe the whole batch.
const TRASH_ENTRY_LIMIT = 500;
const TRASH_BATCH_NAME = /^\d{1,20}$/;
const DAY_MS = 86400000;
// Session ids are used as a file name component, so only allow a conservative
// character set (real ids are `session-<uuid>`).
const SESSION_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Resolve the DSH home directory (`DSH_HOME` wins over `~/.dsh`). */
export function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return resolve(explicit.trim());
  return join(homedir(), '.dsh');
}

/** Root folder for all plugin-owned state. */
export function stateRoot() {
  return join(dshHome(), 'session-files');
}

export function overridesRoot() {
  return join(stateRoot(), 'overrides');
}

export function overridesFile(sessionId) {
  return join(overridesRoot(), `${sessionId}.json`);
}

export function goneRoot() {
  return join(stateRoot(), 'gone');
}

export function goneFile(sessionId) {
  return join(goneRoot(), `${sessionId}.json`);
}

export function trashRoot() {
  return join(stateRoot(), 'trash');
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_SAFE.test(sessionId)) throw stateError('bad-session-id');
  return sessionId;
}

/** Normalize a workspace-relative path to posix form; return null when unsafe. */
export function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string') return null;
  let value = relPath.trim();
  if (value.length === 0 || value.length > REL_PATH_LIMIT) return null;
  if (value.includes('\0')) return null;
  value = value.replace(/\\/g, '/');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const segments = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

/** True when `target` resolves to `root` or lives below `root` (case-insensitive). */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === '') return true;
  const normalized = rel.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || isAbsolute(rel)) return false;
  const lowerRoot = rootAbs.replace(/[\\/]+$/, '').toLowerCase();
  const lowerTarget = targetAbs.toLowerCase();
  return lowerTarget.startsWith(`${lowerRoot}\\`) || lowerTarget.startsWith(`${lowerRoot}/`);
}

/**
 * Resolve `relPath` inside `workspacePath`, refusing absolute paths, `..`
 * escapes and anything that leaves the workspace.
 */
export function resolveWorkspacePath(workspacePath, relPath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) throw stateError('bad-workspace');
  const rel = normalizeRelPath(relPath);
  if (rel === null) throw stateError('bad-path');
  const root = resolve(workspacePath);
  const absolute = resolve(root, ...rel.split('/'));
  if (absolute === root || !isInside(root, absolute)) throw stateError('bad-path');
  return { root, rel, absolute };
}

// ----- state file IO -------------------------------------------------------

async function readStateFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // ignore cleanup failure; the original error matters more
    }
    throw error;
  }
}

// One write chain per state-file key; map entries disappear once settled.
const writeQueues = new Map();

function withWriteLock(key, task) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, settled);
  settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return run;
}

function withSessionLock(sessionId, task) {
  return withWriteLock(`session:${sessionId}`, task);
}

function normalizeOverrides(raw) {
  const out = {};
  const files = raw && typeof raw.files === 'object' && raw.files !== null && !Array.isArray(raw.files) ? raw.files : {};
  for (const [relPath, entry] of Object.entries(files)) {
    const rel = normalizeRelPath(relPath);
    if (rel === null || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!CLASS_SET.has(entry.cls)) continue;
    const note = typeof entry.note === 'string' && entry.note.length > 0 ? entry.note.slice(0, NOTE_LIMIT) : null;
    out[rel] = { cls: entry.cls, note };
  }
  return out;
}

// ----- public API ----------------------------------------------------------

/** @returns {Promise<Record<string, {cls: string, note: string|null}>>} */
export async function readOverrides(sessionId) {
  try {
    assertSessionId(sessionId);
  } catch {
    return {};
  }
  return normalizeOverrides(await readStateFile(overridesFile(sessionId)));
}

/**
 * Set, patch or clear the classification override for one path.
 * `patch.cls` is tri-state: omitted = keep the existing override and only patch the
 * note, `null` = clear the override entirely, a class name = set it.
 * @returns {Promise<Record<string, {cls: string, note: string|null}>>} the new override map
 */
export async function setOverride(sessionId, relPath, patch) {
  assertSessionId(sessionId);
  const rel = normalizeRelPath(relPath);
  if (rel === null) throw stateError('bad-path');
  const hasCls = Boolean(patch) && Object.prototype.hasOwnProperty.call(patch, 'cls') && patch.cls !== undefined;
  const cls = hasCls ? patch.cls : undefined;
  if (hasCls && cls !== null && !CLASS_SET.has(cls)) throw stateError('bad-cls');
  let note;
  if (patch && patch.note !== undefined) {
    if (patch.note !== null && typeof patch.note !== 'string') throw stateError('bad-note');
    const trimmed = typeof patch.note === 'string' ? patch.note.trim().slice(0, NOTE_LIMIT) : '';
    note = trimmed.length > 0 ? trimmed : null;
  }

  return withSessionLock(sessionId, async () => {
    const file = overridesFile(sessionId);
    const raw = await readStateFile(file);
    const files = raw && typeof raw.files === 'object' && raw.files !== null && !Array.isArray(raw.files) ? { ...raw.files } : {};
    const existing = files[rel] && typeof files[rel] === 'object' ? files[rel] : undefined;
    const existingCls = existing && CLASS_SET.has(existing.cls) ? existing.cls : null;
    const existingNote = typeof existing?.note === 'string' && existing.note.length > 0 ? existing.note.slice(0, NOTE_LIMIT) : null;
    let changed = false;
    if (hasCls && cls === null) {
      if (existing !== undefined) {
        delete files[rel];
        changed = true;
      }
    } else if (hasCls) {
      const next = { cls, updatedAt: Date.now() };
      const nextNote = note !== undefined ? note : existingNote;
      if (nextNote) next.note = nextNote;
      files[rel] = next;
      changed = true;
    } else if (existingCls !== null) {
      // Note-only patch: the override keeps its class, only the note changes.
      const next = { cls: existingCls, updatedAt: Date.now() };
      const nextNote = note !== undefined ? note : existingNote;
      if (nextNote) next.note = nextNote;
      files[rel] = next;
      changed = true;
    }
    if (changed) await writeJsonAtomic(file, { version: 1, sessionId, files });
    return normalizeOverrides({ files });
  });
}

// ----- pruned records ------------------------------------------------------

const GONE_LIMIT = 20000;

function normalizeGoneList(raw) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    const rel = normalizeRelPath(value);
    if (rel === null || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Records this session has pruned: temp paths whose file no longer exists (for
 * example because another session moved it to the plugin trash). Pruning is a
 * ledger-only operation: nothing on disk is touched, and a path that reappears
 * in the workspace scan is shown again.
 * @returns {Promise<string[]>} workspace-relative posix paths
 */
export async function readGone(sessionId) {
  try {
    assertSessionId(sessionId);
  } catch {
    return [];
  }
  const raw = await readStateFile(goneFile(sessionId));
  return normalizeGoneList(raw && raw.paths);
}

/**
 * Add and/or remove pruned records for one session.
 * @param {{add?: string[], remove?: string[]}} patch
 * @returns {Promise<string[]>} the new pruned list
 */
export async function updateGone(sessionId, patch) {
  assertSessionId(sessionId);
  const add = normalizeRelPathList(patch && patch.add);
  const remove = new Set(normalizeRelPathList(patch && patch.remove));
  if (add.length === 0 && remove.size === 0) return readGone(sessionId);
  return withSessionLock(sessionId, async () => {
    const file = goneFile(sessionId);
    const raw = await readStateFile(file);
    const next = normalizeGoneList([...(raw && Array.isArray(raw.paths) ? raw.paths : []), ...add]).filter(
      (rel) => !remove.has(rel),
    );
    const capped = next.length > GONE_LIMIT ? next.slice(next.length - GONE_LIMIT) : next;
    await writeJsonAtomic(file, { version: 1, sessionId, paths: capped });
    return capped;
  });
}

function normalizeRelPathList(raw) {
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const rel = normalizeRelPath(value);
    if (rel !== null && !out.includes(rel)) out.push(rel);
  }
  return out;
}

async function moveFile(source, destination) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
  }
  // Cross-device (or a locked handle): copy then unlink.
  await copyFile(source, destination);
  try {
    await unlink(source);
  } catch {
    // best effort: the trash copy exists either way
  }
}

/**
 * Move files from the workspace into the plugin trash (never `fs.rm`).
 * Unsafe/missing paths and directories are reported as skipped.
 * @returns {Promise<{deleted: string[], skipped: string[]}>}
 */
export async function trashFiles(sessionId, workspacePath, relPaths) {
  assertSessionId(sessionId);
  const requested = [];
  const skipped = [];
  for (const value of Array.isArray(relPaths) ? relPaths : []) {
    const rel = normalizeRelPath(value);
    if (rel === null) {
      skipped.push(typeof value === 'string' ? value : String(value));
      continue;
    }
    if (!requested.includes(rel)) requested.push(rel);
  }
  if (requested.length === 0) return { deleted: [], skipped };
  if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
    return { deleted: [], skipped: [...skipped, ...requested] };
  }

  return withSessionLock(sessionId, async () => {
    const deleted = [];
    const batchDir = join(trashRoot(), sessionId, String(Date.now()));
    for (const rel of requested) {
      let target;
      try {
        target = resolveWorkspacePath(workspacePath, rel);
      } catch {
        skipped.push(rel);
        continue;
      }
      let info;
      try {
        info = await stat(target.absolute);
      } catch {
        skipped.push(rel);
        continue;
      }
      if (!info.isFile()) {
        skipped.push(rel);
        continue;
      }
      try {
        const destination = join(batchDir, ...rel.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await moveFile(target.absolute, destination);
        deleted.push(rel);
      } catch {
        skipped.push(rel);
      }
    }
    return { deleted, skipped };
  });
}

function decodeText(bytes, truncated) {
  if (bytes.length === 0) return '';
  if (bytes.includes(0)) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch {
    // A truncated preview may cut a multi-byte character in half.
    if (truncated) {
      for (let cut = 1; cut <= 4 && cut < bytes.length; cut++) {
        try {
          return decoder.decode(bytes.subarray(0, bytes.length - cut));
        } catch {
          // keep trying shorter tails
        }
      }
    }
    return null;
  }
}

/**
 * Read a workspace file for the preview pane.
 * @returns {Promise<{text: string, truncated: boolean, binary: boolean, bytes: number}>}
 */
export async function previewFile(workspacePath, relPath, maxBytes = PREVIEW_LIMIT_DEFAULT) {
  const { rel: _rel, absolute } = resolveWorkspacePath(workspacePath, relPath);
  let limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) limit = PREVIEW_LIMIT_DEFAULT;
  limit = Math.max(1, Math.min(Math.floor(limit), PREVIEW_LIMIT_MAX));

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw stateError('file-not-found');
  }
  if (!info.isFile()) throw stateError('file-not-found');

  const size = Number(info.size) || 0;
  const readSize = Math.min(size, limit + 1);
  let buffer = Buffer.alloc(0);
  if (readSize > 0) {
    let handle;
    try {
      handle = await open(absolute, 'r');
      const allocated = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(allocated, 0, readSize, 0);
      buffer = allocated.subarray(0, bytesRead);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore close failure
        }
      }
    }
  }

  const truncated = size > limit;
  const slice = buffer.length > limit ? buffer.subarray(0, limit) : buffer;
  const text = decodeText(slice, truncated);
  if (text === null) return { text: '', truncated, binary: true, bytes: size };
  return { text, truncated, binary: false, bytes: size };
}

// ----- config --------------------------------------------------------------

const CONFIG_VERSION = 1;

export function configFile() {
  return join(stateRoot(), 'config.json');
}

function normalizeConfig(raw) {
  const retention = raw && Number.isInteger(raw.trashRetentionDays) ? raw.trashRetentionDays : 0;
  const days = retention >= RETENTION_MIN && retention <= RETENTION_MAX ? retention : 0;
  return { version: CONFIG_VERSION, trashRetentionDays: days };
}

/**
 * Read `$DSH_HOME/session-files/config.json`. A missing file, unreadable file or
 * invalid value all mean "retention disabled" (0), never an error.
 */
export async function readConfig() {
  return normalizeConfig(await readStateFile(configFile()));
}

/**
 * Persist the retention setting. `trashRetentionDays` is an integer in 0..3650
 * (0 disables the sweep); omitting it keeps the current value.
 */
export async function writeConfig(patch) {
  const settings = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const requested = settings.trashRetentionDays;
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < RETENTION_MIN || requested > RETENTION_MAX) {
      throw stateError('bad-retention');
    }
  }
  return withWriteLock('config', async () => {
    const current = await readConfig();
    const days = requested === undefined ? current.trashRetentionDays : requested;
    const next = { version: CONFIG_VERSION, trashRetentionDays: days };
    await writeJsonAtomic(configFile(), next);
    return next;
  });
}

// ----- trash browsing, restore and deletion --------------------------------

function compareCodePoints(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Recursively collect the regular files of one trash batch. Symlinks are skipped
 * (never followed), and `files`/`bytes` always describe the whole batch.
 */
async function collectTrashFiles(batchDir) {
  const entries = [];
  let files = 0;
  let bytes = 0;
  const stack = [{ dir: batchDir, prefix: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let listing;
    try {
      listing = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of listing) {
      if (item.isSymbolicLink()) continue;
      const relPath = current.prefix.length === 0 ? item.name : `${current.prefix}/${item.name}`;
      const absolute = join(current.dir, item.name);
      if (item.isDirectory()) {
        stack.push({ dir: absolute, prefix: relPath });
        continue;
      }
      if (!item.isFile()) continue;
      let size = 0;
      try {
        size = Math.max(0, Number((await stat(absolute)).size) || 0);
      } catch {
        size = 0;
      }
      files += 1;
      bytes += size;
      entries.push({ path: relPath, size });
    }
  }
  entries.sort((a, b) => compareCodePoints(a.path, b.path));
  return { entries, files, bytes };
}

function parseTrashBatchId(batch) {
  if (typeof batch !== 'string') throw stateError('bad-batch');
  const value = batch.trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash !== value.lastIndexOf('/')) throw stateError('bad-batch');
  const ownerSessionId = value.slice(0, slash);
  const batchName = value.slice(slash + 1);
  if (!SESSION_ID_SAFE.test(ownerSessionId) || !TRASH_BATCH_NAME.test(batchName)) throw stateError('bad-batch');
  const root = trashRoot();
  const dir = join(root, ownerSessionId, batchName);
  if (!isInside(root, dir)) throw stateError('bad-batch');
  return { ownerSessionId, batchName, dir, id: `${ownerSessionId}/${batchName}` };
}

async function readBatch(ownerSessionId, batchName) {
  if (typeof ownerSessionId !== 'string' || !SESSION_ID_SAFE.test(ownerSessionId)) return null;
  if (typeof batchName !== 'string' || !TRASH_BATCH_NAME.test(batchName)) return null;
  const root = trashRoot();
  const batchDir = join(root, ownerSessionId, batchName);
  if (!isInside(root, batchDir)) return null;
  let info;
  try {
    info = await lstat(batchDir);
  } catch {
    return null;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const collected = await collectTrashFiles(batchDir);
  return {
    id: `${ownerSessionId}/${batchName}`,
    ownerSessionId,
    createdAt: Number(batchName),
    files: collected.files,
    bytes: collected.bytes,
    entries: collected.entries.slice(0, TRASH_ENTRY_LIMIT),
    truncated: collected.entries.length > TRASH_ENTRY_LIMIT,
  };
}

/**
 * List trash batches (newest first). `scope: 'session'` only returns batches owned
 * by `sessionId`; the default 'all' returns every owner.
 * @returns {Promise<{batches: Array<object>, totals: {batches: number, files: number, bytes: number}}>}
 */
export async function listTrash(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const scope = settings.scope === 'session' ? 'session' : 'all';
  const sessionId = typeof settings.sessionId === 'string' ? settings.sessionId : '';
  const root = trashRoot();
  const batches = [];
  let owners;
  try {
    owners = await readdir(root, { withFileTypes: true });
  } catch {
    return { batches, totals: { batches: 0, files: 0, bytes: 0 } };
  }
  for (const owner of owners) {
    if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
    if (scope === 'session' && owner.name !== sessionId) continue;
    const ownerDir = join(root, owner.name);
    if (!isInside(root, ownerDir)) continue;
    let items;
    try {
      items = await readdir(ownerDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      if (!TRASH_BATCH_NAME.test(item.name)) continue;
      const record = await readBatch(owner.name, item.name);
      if (record) batches.push(record);
    }
  }
  batches.sort((a, b) => b.createdAt - a.createdAt || compareCodePoints(a.id, b.id));
  const totals = { batches: batches.length, files: 0, bytes: 0 };
  for (const record of batches) {
    totals.files += record.files;
    totals.bytes += record.bytes;
  }
  return { batches, totals };
}

async function trashSourceFile(batchDir, relPath) {
  const segments = relPath.split('/');
  let current = batchDir;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return null;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  }
  const absolute = join(batchDir, ...segments);
  if (!isInside(batchDir, absolute)) return null;
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  return { absolute };
}

/**
 * Copy one trash batch (or a subset of its paths) back into a workspace root.
 * The trash copy is left in place, existing targets are never overwritten, and
 * unsafe paths are reported rather than written.
 * @returns {Promise<{restored: string[], skipped: Array<{path: string, reason: 'exists'|'bad-path'|'missing'}>}>}
 */
export async function restoreTrashBatch(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const batch = parseTrashBatchId(settings.batch);
  const workspacePath = settings.targetWorkspacePath;
  if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) throw stateError('bad-workspace');
  const root = resolve(workspacePath);
  let info;
  try {
    info = await lstat(batch.dir);
  } catch {
    throw stateError('batch-not-found');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw stateError('batch-not-found');

  const skipped = [];
  const requested = [];
  const seen = new Set();
  if (Array.isArray(settings.paths) && settings.paths.length > 0) {
    for (const value of settings.paths) {
      const rel = normalizeRelPath(value);
      if (rel === null) {
        skipped.push({ path: typeof value === 'string' ? value : String(value), reason: 'bad-path' });
        continue;
      }
      if (seen.has(rel)) continue;
      seen.add(rel);
      requested.push(rel);
    }
  } else {
    // Omitted (or empty) `paths` means the whole batch.
    const collected = await collectTrashFiles(batch.dir);
    for (const entry of collected.entries) requested.push(entry.path);
  }

  const restored = [];
  for (const rel of requested) {
    let source;
    try {
      source = await trashSourceFile(batch.dir, rel);
    } catch {
      source = null;
    }
    if (!source) {
      skipped.push({ path: rel, reason: 'missing' });
      continue;
    }
    let target;
    try {
      target = resolveWorkspacePath(root, rel);
    } catch {
      skipped.push({ path: rel, reason: 'bad-path' });
      continue;
    }
    let existing = null;
    try {
      existing = await lstat(target.absolute);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      skipped.push({ path: rel, reason: 'exists' });
      continue;
    }
    try {
      await mkdir(dirname(target.absolute), { recursive: true });
      await copyFile(source.absolute, target.absolute, fsConstants.COPYFILE_EXCL);
      restored.push(rel);
    } catch (error) {
      const code = error && error.code;
      skipped.push({ path: rel, reason: code === 'EEXIST' ? 'exists' : 'missing' });
    }
  }
  return { restored, skipped };
}

async function removeBatchDir(batchDir, dryRun) {
  if (typeof batchDir !== 'string' || batchDir.length === 0) return false;
  const root = trashRoot();
  if (!isInside(root, batchDir)) return false;
  let info;
  try {
    info = await lstat(batchDir);
  } catch {
    return false;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (dryRun) return true;
  try {
    await rm(batchDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  // Drop the now-empty owner folder; best effort only.
  try {
    const ownerDir = dirname(batchDir);
    if (isInside(root, ownerDir) && ownerDir !== root) {
      const left = await readdir(ownerDir);
      if (left.length === 0) await rm(ownerDir, { recursive: true, force: true });
    }
  } catch {
    // leave an empty owner folder behind rather than fail the deletion
  }
  return true;
}

async function removeBatchesOlderThan(days, dryRun) {
  const listed = await listTrash({ scope: 'all' });
  const cutoff = Date.now() - days * DAY_MS;
  const removed = [];
  let files = 0;
  let bytes = 0;
  for (const record of listed.batches) {
    if (!Number.isFinite(record.createdAt) || record.createdAt >= cutoff) continue;
    let info;
    try {
      info = parseTrashBatchId(record.id);
    } catch {
      continue;
    }
    if (!(await removeBatchDir(info.dir, dryRun))) continue;
    removed.push({ batch: record.id, files: record.files, bytes: record.bytes });
    files += record.files;
    bytes += record.bytes;
  }
  return { removed, totals: { files, bytes } };
}

/**
 * Delete trash batches for real. Either a single `batch`, or every batch older
 * than `olderThanDays` (>= 1); `dryRun` reports without touching the disk.
 * @returns {Promise<{removed: Array<{batch: string, files: number, bytes: number}>, totals: {files: number, bytes: number}}>}
 */
export async function emptyTrash(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const dryRun = settings.dryRun === true;
  const batch = settings.batch;
  const hasBatch = batch !== undefined && batch !== null && batch !== '';
  const days = Number(settings.olderThanDays);
  const hasDays =
    settings.olderThanDays !== undefined && settings.olderThanDays !== null && Number.isFinite(days) && days >= 1;
  if (!hasBatch && !hasDays) throw stateError('empty-scope-required');
  if (hasBatch) {
    const info = parseTrashBatchId(batch);
    const record = await readBatch(info.ownerSessionId, info.batchName);
    if (!record) throw stateError('batch-not-found');
    const removed = [];
    let files = 0;
    let bytes = 0;
    if (await removeBatchDir(info.dir, dryRun)) {
      removed.push({ batch: record.id, files: record.files, bytes: record.bytes });
      files += record.files;
      bytes += record.bytes;
    }
    return { removed, totals: { files, bytes } };
  }
  return removeBatchesOlderThan(days, dryRun);
}

/**
 * Retention sweep: delete whole batches whose `createdAt` is older than
 * `days` days. A non-positive/non-finite `days` disables the sweep.
 * @returns {Promise<{removed: Array<{batch: string, files: number, bytes: number}>, totals: {files: number, bytes: number}}>}
 */
export async function sweepTrashOlderThan(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return { removed: [], totals: { files: 0, bytes: 0 } };
  return removeBatchesOlderThan(value, false);
}
