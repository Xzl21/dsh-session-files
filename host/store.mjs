// Durable state for dsh-session-files: per-session classification overrides,
// free-form notes, file previews and the trash directory used by cleanup.
//
// Everything is stored under $DSH_HOME (`<home>/session-files/...`) so the
// user's workspace never receives runtime data:
//   <home>/session-files/overrides/<sessionId>.json
//   <home>/session-files/trash/<sessionId>/<epochMs>/<relPath>
//
// Writes are atomic (temp file + rename) and serialized per sessionId, so two
// concurrent classify requests cannot interleave into a corrupted JSON file.
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const CLASSES = ['deliverable', 'process', 'input', 'temp'];
const CLASS_SET = new Set(CLASSES);
const NOTE_LIMIT = 2000;
const REL_PATH_LIMIT = 4096;
const PREVIEW_LIMIT_DEFAULT = 65536;
const PREVIEW_LIMIT_MAX = 1_000_000;
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

// One write chain per session id; map entries disappear once settled.
const sessionQueues = new Map();

function withSessionLock(sessionId, task) {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  sessionQueues.set(sessionId, settled);
  settled.then(() => {
    if (sessionQueues.get(sessionId) === settled) sessionQueues.delete(sessionId);
  });
  return run;
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
