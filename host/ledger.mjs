/**
 * host/ledger.mjs — pure session-file ledger core (CONTRACT.md §3 §4 §5).
 *
 * Hard rules for this module:
 *  - pure functions only: no fs, no env, no clock, no logging, no ctx;
 *  - deterministic: identical input => byte-identical output (stable ordering);
 *  - ESM, zero third-party deps, no node builtins needed at all.
 *
 * Exported API (CONTRACT.md §3):
 *  buildLedger(input)            -> Ledger
 *  extractFileOps(events)        -> FileOp[]
 *  classifyPath(relPath, info)   -> { autoCls, reason }
 *  buildTree({...})              -> { columns, nodes, edges, counts, warnings, workspace? }
 *  SKIP_DIR_PATTERNS             -> readonly string[] (scanner directory-name rules)
 *  shouldSkipDir(name)           -> boolean
 */

const LANES = ['deliverable', 'process', 'input', 'temp'];
const LANE_ORDER = Object.freeze({ deliverable: 0, process: 1, input: 2, temp: 3 });

const SCRIPT_EXTS = new Set(['py', 'ps1', 'sh', 'mjs', 'js', 'bat', 'cmd']);
const DELIVERABLE_DIRS = new Set(['deliverables', 'deliverable', 'release', 'final', '输出', '交付']);
// `verify` is added on top of §4's list because the Lead's mock ledger classifies
// `verify/*.txt` as `temp-dir`; keeping it keeps B's fixture and A's output aligned.
const TEMP_DIRS = new Set(['tmp', 'temp', 'scratch', 'cache', 'verify']);
const TEMP_SUFFIX_RE = /\.(tmp|bak|old|orig|swp|log)$/;
const TEMP_WORD_RE = /(^|[^a-z0-9])(tmp|temp|scratch|probe|debug|draft|snapshot|dump|intermediate)(?=$|[^a-z0-9])/;
const THROWAWAY_NAME_RE = /^(tmp|temp|probe|debug|scratch|test|check|scan|inspect)[-_]/;

// Project plumbing that is never a throwaway, even though it is small, single-turn
// and unreferenced. Without this list a one-click cleanup deletes `.gitignore`
// (dot-prefixed => temp-name) and freshly written build scripts in a real repo.
const CONFIG_BASENAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.npmrc',
  '.npmignore',
  '.dockerignore',
  '.mailmap',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.tool-versions',
  '.gitkeep',
  '.keep',
  '.prettierrc',
  '.eslintrc',
  '.stylelintrc',
  '.babelrc',
  'tsconfig.json',
  'jsconfig.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'cargo.toml',
  'go.mod',
  'go.sum',
  'gemfile',
  'composer.json',
  'makefile',
  'cmakelists.txt',
  'dockerfile',
  'license',
  'notice',
]);
// Dot-prefixed names that ARE disposable (editor/OS/tmp leftovers).
const TEMP_DOTFILE_RE = /^\.(tmp|temp|bak|old|orig|swp|swo|lock|_|ds_store|trash|nfs)/i;
const TEMP_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'setup.py',
  'cargo.toml',
  'go.mod',
  'composer.json',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'makefile',
  'cmakelists.txt',
]);

const MAX_INPUT_NODES = 40;
const MAX_DERIVED_IN = 3;
const MAX_DERIVED_EDGES = 300;
const DEFAULT_MAX_NODES = 4000;
const MAX_WORKSPACE_TEMP_PATHS = 500;

/**
 * Directory-name skip rules for the workspace scanner (CONTRACT.md §2).
 * Matching is a case-insensitive prefix test on the directory's basename, so
 * `.venv-tts`, `.git-*`, `.tmp-*`, `node_modules-*` are all covered while real
 * output directories (`build`, `dist`, `reports`) stay scannable.
 * Hosts must reuse `shouldSkipDir()` instead of re-implementing the semantics.
 */
export const SKIP_DIR_PATTERNS = Object.freeze([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.tox',
  '.next',
  '.mypy_cache',
  '.ruff_cache',
  '.termpilot',
  '.tmp',
  '.dsh-session-files',
]);

/** shouldSkipDir(name) -> boolean; prefix match on the lowercased basename. */
export function shouldSkipDir(name) {
  if (typeof name !== 'string') return false;
  const base = name.trim().toLowerCase();
  if (!base) return false;
  for (const pattern of SKIP_DIR_PATTERNS) {
    if (base === pattern || base.startsWith(pattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- primitives

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Normalise a relative posix path; returns null when it is empty or escapes upward. */
function cleanRel(p) {
  if (typeof p !== 'string') return null;
  if (p.indexOf('\u0000') !== -1) return null;
  const segs = p.split('/');
  const out = [];
  for (const raw of segs) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(raw);
  }
  return out.length ? out.join('/') : null;
}

function isAbsPath(p) {
  return /^[A-Za-z]:\//.test(p) || p.charAt(0) === '/';
}

function splitRel(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  return { name, dir, ext: extOf(name) };
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  const ext = name.slice(i + 1);
  return /^[A-Za-z0-9]+$/.test(ext) ? ext.toLowerCase() : '';
}

function isScriptExtPath(p) {
  return SCRIPT_EXTS.has(extOf(p));
}

function dirSegments(lowerRel) {
  const parts = lowerRel.split('/');
  parts.pop();
  return parts;
}

function isTempDirSeg(seg) {
  return seg.startsWith('.tmp') || TEMP_DIRS.has(seg);
}

function pathCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hhmm(ms) {
  // Local wall clock, deliberately no timezone maths (CONTRACT §5 example).
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ------------------------------------------------------------- file names

/**
 * Heuristic: does this raw token look like a file path?
 * Keeps extensions and path-ish tokens, drops flags, variables, URLs, devices.
 */
function looksLikeFile(raw) {
  if (typeof raw !== 'string') return false;
  let t = raw.trim();
  if (!t) return false;
  while (
    (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') ||
    (t.length >= 2 && t.charAt(0) === "'" && t.charAt(t.length - 1) === "'") ||
    (t.length >= 2 && t.charAt(0) === '`' && t.charAt(t.length - 1) === '`')
  ) {
    t = t.slice(1, -1).trim();
  }
  if (!t) return false;
  if (t.charAt(0) === '-') return false; // flags
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t)) return false; // URL
  if (/^\/(dev|proc|sys)(\/|$)/i.test(t)) return false; // unix devices
  if (/^nul$/i.test(t) || /^con$/i.test(t) || /^prn$/i.test(t)) return false;
  if (/[%$*?{}[\]()!]/.test(t)) return false; // variables / globs / punctuation
  if (/\s/.test(t) && !/[\\/]/.test(t)) return false; // multi-word quoted sentence, not a path
  if (t.indexOf('=') !== -1) return false; // KEY=VALUE / --opt=value
  if (t === '.' || t === '..') return false;
  if (/^\d+$/.test(t)) return false;
  const base = t.replace(/\\/g, '/').split('/').pop();
  if (!base) return false;
  const hasExt = /\.[A-Za-z0-9]{1,12}$/.test(base);
  if (hasExt) return true;
  return /[\\/]/.test(t);
}

/** Strip quotes / trailing punctuation and re-validate; returns null when not file-ish. */
function tokenToPath(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  while (t.length >= 2) {
    const a = t.charAt(0);
    const b = t.charAt(t.length - 1);
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === '`' && b === '`')) {
      t = t.slice(1, -1).trim();
      continue;
    }
    break;
  }
  t = t.replace(/[,;]+$/g, '');
  if (!looksLikeFile(t)) return null;
  return t;
}

// --------------------------------------------------------- shell tokenizer

const TOKEN_RE = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;

function tokenize(text) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

function skipQuoted(text, i) {
  const q = text.charAt(i);
  let j = i + 1;
  while (j < text.length) {
    if (text.charAt(j) === '\\' && q === '"') {
      j += 2;
      continue;
    }
    if (text.charAt(j) === q) return j + 1;
    j++;
  }
  return text.length;
}

/** Remove heredoc bodies: `cat > x.py <<'EOF' ... EOF`. */
function stripHeredocs(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = /<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (!m) continue;
    const word = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    if (!word) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== word) j++;
    i = j; // drop the body and the closing delimiter line
  }
  return out.join('\n');
}

/** Remove PowerShell here-strings: `@' ... '@` (a closing `'@` may be piped onward). */
function stripHereStrings(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /@(['"])\s*$/.exec(line);
    if (m) {
      const closer = m[1] + '@';
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(closer)) j++;
      if (j < lines.length) {
        out.push(line.slice(0, m.index));
        out.push(lines[j].trim().slice(closer.length));
        i = j + 1;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

function stripMultilineLiterals(text) {
  return stripHereStrings(stripHeredocs(text));
}

/**
 * Scan for `>`, `>>`, `2>`, `&>` style redirects, quote aware.
 * Returns spans so the caller can also blank them out of the command body.
 */
function findRedirects(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '&' && text.charAt(i + 1) === '>') {
      // &> target
      let k = i + 2;
      while (k < text.length && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) k++;
      const picked = readRedirectTarget(text, k);
      out.push({ start: i, end: picked.end, target: picked.target });
      i = picked.end;
      continue;
    }
    if (ch === '>') {
      let k = i + 1;
      if (text.charAt(k) === '>') k++; // >>
      while (k < text.length && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) k++;
      const picked = readRedirectTarget(text, k);
      out.push({ start: i, end: picked.end, target: picked.target });
      i = picked.end;
      continue;
    }
    i++;
  }
  return out;
}

function readRedirectTarget(text, k) {
  let target = '';
  let end = k;
  if (k >= text.length) return { target, end };
  const q = text.charAt(k);
  if (q === '"' || q === "'" || q === '`') {
    let j = k + 1;
    while (j < text.length && text.charAt(j) !== q) j++;
    target = text.slice(k + 1, j);
    end = Math.min(text.length, j + 1);
  } else {
    let j = k;
    while (j < text.length && !/[\s;&|<>]/.test(text.charAt(j))) j++;
    target = text.slice(k, j);
    end = j;
  }
  return { target, end };
}

function redirectTargetToPath(target) {
  if (!target) return null;
  const t = target.trim();
  if (!t) return null;
  if (t.charAt(0) === '&') return null; // 2>&1, >&2
  if (/^\d+$/.test(t)) return null;
  return tokenToPath(t);
}

/** Split a command into pipeline / sequence segments, quote aware. */
function splitSegments(text) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"') {
        if (i + 1 < text.length) cur += text.charAt(++i);
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

const INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'py', 'node', 'nodejs', 'pwsh', 'powershell', 'bash', 'sh',
  'zsh', 'fish', 'cmd', 'deno', 'bun', 'ruby', 'perl', 'php', 'java', 'javac', 'dotnet',
  'tsx', 'ts-node', 'source', '.',
]);
const WRITE_VERBS = new Set([
  'set-content', 'add-content', 'out-file', 'new-item', 'tee', 'tee-object', 'touch', 'cp',
  'copy', 'copy-item', 'mv', 'move', 'move-item', 'clear-content', 'install',
]);
const DELETE_VERBS = new Set(['rm', 'del', 'erase', 'remove-item', 'rmdir', 'rd', 'unlink', 'remove']);
const READ_VERBS = new Set([
  'cat', 'type', 'get-content', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'find', 'fd',
  'ls', 'dir', 'stat', 'xxd', 'strings', 'file', 'od', 'wc', 'open', 'start', 'invoke-item',
  'diff', 'cmp', 'test-path', 'get-item', 'get-childitem', 'gci',
]);

function commandBasename(token) {
  let t = String(token).trim().replace(/^&/, '');
  t = t.replace(/\\/g, '/');
  const base = t.indexOf('/') !== -1 ? t.slice(t.lastIndexOf('/') + 1) : t;
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * Extract file operations out of one shell-ish command string.
 * Recognised shapes: quoted/backticked paths, redirects, heredocs, here-strings,
 * interpreter invocations, direct `.\x.ps1` invocations, explicit write/delete verbs.
 */
function parseCommand(rawCommand) {
  const ops = [];
  const seen = new Set();
  const add = (rawPath, action) => {
    const p = tokenToPath(rawPath);
    if (!p) return;
    const key = action + '\u0000' + p;
    if (seen.has(key)) return;
    seen.add(key);
    ops.push({ path: p, action });
  };

  let text = String(rawCommand).replace(/\r\n?/g, '\n');
  text = stripMultilineLiterals(text);

  const redirects = findRedirects(text);
  for (const r of redirects) {
    const p = redirectTargetToPath(r.target);
    if (p) add(p, 'write');
  }

  // Blank out redirect spans (and their targets) before token-level parsing.
  let body = '';
  let cursor = 0;
  for (const r of redirects) {
    body += text.slice(cursor, r.start) + ' ';
    cursor = r.end;
  }
  body += text.slice(cursor);

  for (const seg of splitSegments(body)) {
    parseCommandSegment(seg, add);
  }

  // Global fallback: a script file appearing anywhere in the command is executed
  // unless it was already classified as a write / delete target.
  const assigned = new Set(ops.map((o) => o.path));
  for (const tok of tokenize(body)) {
    const p = tokenToPath(tok);
    if (!p) continue;
    if (!isScriptExtPath(p)) continue;
    if (assigned.has(p)) continue;
    assigned.add(p);
    add(p, 'exec');
  }

  return ops;
}

function parseCommandSegment(segText, add) {
  const tokens = tokenize(segText);
  if (tokens.length === 0) return;
  let vi = 0;
  while (vi < tokens.length) {
    const t = tokens[vi];
    if (!t) {
      vi++;
      continue;
    }
    if (t === '<' || t === '>' || t === '>>' || t === '<<' || /^\d?>$/.test(t) || t.startsWith('<<')) {
      vi++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      vi++;
      continue;
    }
    break;
  }
  if (vi >= tokens.length) return;
  const verbRaw = tokens[vi];
  const verb = commandBasename(verbRaw);
  const rest = tokens.slice(vi + 1);
  const fileTokens = [];
  for (const t of rest) {
    const p = tokenToPath(t);
    if (p) fileTokens.push(p);
  }

  if (INTERPRETERS.has(verb)) {
    let first = true;
    for (const p of fileTokens) {
      if (first) {
        add(p, 'exec');
        first = false;
      } else {
        add(p, 'read');
      }
    }
    return;
  }
  if (WRITE_VERBS.has(verb)) {
    for (const p of fileTokens) add(p, 'write');
    return;
  }
  if (DELETE_VERBS.has(verb)) {
    for (const p of fileTokens) add(p, 'delete');
    return;
  }
  if (READ_VERBS.has(verb)) {
    for (const p of fileTokens) add(p, 'read');
    return;
  }

  const verbPath = tokenToPath(verbRaw);
  if (verbPath && isScriptExtPath(verbPath)) {
    // `.\x.ps1`, `/tmp/x.sh`, bare `helper.py` used as a command.
    add(verbPath, 'exec');
    for (const p of fileTokens) add(p, 'read');
    return;
  }
  for (const p of fileTokens) {
    if (isScriptExtPath(p)) add(p, 'exec');
  }
}

// ----------------------------------------------------------- event parsing

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'terminal', 'run', 'powershell', 'cmd', 'sh', 'zsh', 'fish', 'exec']);
const FALLBACK_PATH_KEYS = ['file_path', 'path', 'file', 'output', 'files'];

function parseToolArguments(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

function collectPathStrings(args, keys) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const visit = (v) => {
    if (typeof v === 'string') {
      add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === 'object') {
      if (typeof v.path === 'string') add(v.path);
      if (typeof v.file_path === 'string') add(v.file_path);
      if (typeof v.file === 'string') add(v.file);
      if (typeof v.output === 'string') add(v.output);
      if (typeof v.relPath === 'string') add(v.relPath);
    }
  };
  for (const k of keys) {
    if (!args || !Object.prototype.hasOwnProperty.call(args, k)) continue;
    visit(args[k]);
  }
  return out;
}

function extractFileOpsDetailed(events) {
  const list = Array.isArray(events) ? events : [];
  const fileOps = [];
  const warnings = [];
  const warn = (key) => {
    if (warnings.indexOf(key) === -1) warnings.push(key);
  };
  const seen = new Set();
  const pushOp = (rawPath, action, tool, turn, seq, time) => {
    if (typeof rawPath !== 'string') {
      warn('bad-event');
      return;
    }
    const p = rawPath.trim();
    if (!p) return;
    const key = p + '\u0000' + action + '\u0000' + turn + '\u0000' + seq + '\u0000' + tool;
    if (seen.has(key)) return;
    seen.add(key);
    fileOps.push({ path: p, action, tool, turn, seq, time });
  };

  let currentTurn = 0;
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') {
      warn('bad-event');
      continue;
    }
    const type = typeof ev.type === 'string' ? ev.type : '';
    const data = ev.data;
    if (type === 'turn/start') {
      if (data && typeof data === 'object' && isNum(data.turn)) currentTurn = data.turn;
      else warn('bad-event');
      continue;
    }
    if (type !== 'tool/call') continue;
    if (!data || typeof data !== 'object') {
      warn('bad-event');
      continue;
    }
    const tool = typeof data.name === 'string' ? data.name.trim() : '';
    if (!tool) {
      warn('bad-event');
      continue;
    }
    const turn = isNum(data.turn) ? data.turn : currentTurn;
    const seq = isNum(ev.seq) ? ev.seq : 0;
    const time = isNum(ev.time) ? ev.time : 0;
    const args = parseToolArguments(data.arguments);
    if (args === null) {
      warn('bad-json');
      continue;
    }
    const lower = tool.toLowerCase();
    const pushAll = (paths, action) => {
      for (const p of paths) pushOp(p, action, tool, turn, seq, time);
    };

    if (SHELL_TOOLS.has(lower) && typeof args.command === 'string') {
      for (const op of parseCommand(args.command)) pushOp(op.path, op.action, tool, turn, seq, time);
      continue;
    }

    if (lower === 'write') {
      pushAll(collectPathStrings(args, ['file_path', 'path', 'file']), 'write');
      continue;
    }
    if (lower === 'edit') {
      pushAll(collectPathStrings(args, ['file_path', 'path', 'file']), 'edit');
      continue;
    }
    if (lower === 'read' || lower === 'read_image') {
      pushAll(collectPathStrings(args, ['file_path', 'path', 'file']), 'read');
      continue;
    }
    if (lower === 'present') {
      pushAll(collectPathStrings(args, ['files', 'path', 'file_path', 'file', 'paths']), 'present');
      continue;
    }
    if (lower.indexOf('delete') !== -1 || /(^|[-_])rm([-_]|$)/.test(lower)) {
      pushAll(collectPathStrings(args, ['file_path', 'path', 'file', 'files', 'paths']), 'delete');
      continue;
    }
    if (lower === 'glob' || lower === 'grep') {
      const paths = collectPathStrings(args, ['path', 'file_path']).filter((p) => looksLikeFile(p));
      pushAll(paths, 'read');
      continue;
    }
    if (lower.startsWith('office')) {
      const paths = collectPathStrings(args, ['path', 'file', 'file_path', 'output', 'files', 'outputs']);
      if (paths.length) {
        pushAll(paths, 'write');
        continue;
      }
      const fallback = collectPathStrings(args, FALLBACK_PATH_KEYS);
      if (fallback.length) pushAll(fallback, 'write');
      continue;
    }

    // Generic fallback: any tool carrying file-ish keys.
    const action = /write|edit/.test(lower) ? 'write' : 'read';
    const fallback = collectPathStrings(args, FALLBACK_PATH_KEYS);
    pushAll(fallback, action);
  }

  fileOps.sort(
    (a, b) =>
      a.seq - b.seq ||
      a.turn - b.turn ||
      pathCmp(a.path, b.path) ||
      pathCmp(a.action, b.action) ||
      pathCmp(a.tool, b.tool)
  );
  return { fileOps, warnings };
}

/**
 * extractFileOps(events) -> FileOp[]
 * Malformed input never throws; the affected events are skipped.
 */
export function extractFileOps(events) {
  return extractFileOpsDetailed(events).fileOps;
}

// -------------------------------------------------------------- relativize

function relativizePath(rawPath, workspacePath) {
  if (typeof rawPath !== 'string') return null;
  let s = rawPath.trim();
  if (!s) return null;
  if (s.indexOf('\u0000') !== -1) return null;
  s = toPosix(s);
  if (/^file:\/\//i.test(s)) {
    try {
      s = toPosix(decodeURIComponent(s.replace(/^file:\/\//i, '')));
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  }
  if (workspacePath && typeof workspacePath === 'string') {
    let ws = toPosix(workspacePath).replace(/\/+$/, '');
    if (!ws) return null;
    const lowerS = s.toLowerCase();
    const lowerWs = ws.toLowerCase();
    if (lowerS === lowerWs) return null;
    if (lowerS.startsWith(lowerWs + '/')) return cleanRel(s.slice(ws.length + 1));
    if (!isAbsPath(s)) return cleanRel(s);
    return null;
  }
  // workspace unknown: input is expected to be relative already
  if (isAbsPath(s)) return null;
  return cleanRel(s);
}

// -------------------------------------------------------------- classify

/**
 * classifyPath(relPath, info) -> { autoCls, reason }
 * CONTRACT.md §4, priority 1 -> 6. `info` may omit fields.
 */
export function classifyPath(relPath, info) {
  const data = info && typeof info === 'object' ? info : {};
  const p = typeof relPath === 'string' ? cleanRel(toPosix(relPath)) : null;
  const rel = p || '';
  const lower = rel.toLowerCase();
  const segs = lower.split('/');
  const base = segs.length ? segs[segs.length - 1] : '';
  const dirs = segs.slice(0, -1);

  const written = data.written === true;
  const presented = data.presented === true;
  const turns = Array.isArray(data.touchedTurns) ? data.touchedTurns.filter(isNum) : [];
  const refs = Array.isArray(data.referencedBy) ? data.referencedBy.filter((x) => typeof x === 'string') : [];
  const created = isNum(data.sessionCreatedAt) ? data.sessionCreatedAt : null;
  const birth = isNum(data.birthtime) ? data.birthtime : isNum(data.mtime) ? data.mtime : null;
  const preexisting = birth !== null && created !== null && birth <= created;
  const readOnly =
    data.readOnly === undefined ? !written && !presented && turns.length > 0 : data.readOnly === true;

  // 1. presented -> deliverable
  if (presented) return { autoCls: 'deliverable', reason: 'presented' };
  // 2. path inside a deliverable directory segment
  if (dirs.some((d) => DELIVERABLE_DIRS.has(d))) return { autoCls: 'deliverable', reason: 'dir' };
  // 3. temp patterns — project plumbing (dotfiles, manifests, tooling files) is exempt
  const configFile = CONFIG_BASENAMES.has(base) || (base.startsWith('.') && !TEMP_DOTFILE_RE.test(base));
  if (!configFile) {
    const explicitTemp =
      THROWAWAY_NAME_RE.test(base) ||
      TEMP_SUFFIX_RE.test(base) ||
      base.startsWith('_') ||
      base.startsWith('~') ||
      TEMP_DOTFILE_RE.test(base) ||
      TEMP_BASENAMES.has(base);
    if (explicitTemp) {
      if (THROWAWAY_NAME_RE.test(base)) return { autoCls: 'temp', reason: 'oneday-script' };
      if (TEMP_SUFFIX_RE.test(base)) return { autoCls: 'temp', reason: 'temp-ext' };
      return { autoCls: 'temp', reason: 'temp-name' };
    }
    if (dirs.some(isTempDirSeg)) return { autoCls: 'temp', reason: 'temp-dir' };
    // Below this line the rules are heuristics on top of "did the session touch it?"
    // and "is this file part of a project?" — applying them blindly deletes project
    // tooling (`tools/layout-dump.mjs` matched the word rule "dump" and was trashed).
    const touched = written || presented || turns.length > 0;
    const projectDir = data.projectDir === true;
    if (touched && !projectDir) {
      if (TEMP_WORD_RE.test(base)) return { autoCls: 'temp', reason: 'temp-name' };
      // one-shot script: written, only in one turn, referenced by no other artifact
      if (isScriptExtPath(base) && written && turns.length <= 1 && refs.length === 0) {
        return { autoCls: 'temp', reason: 'oneday-script' };
      }
    }
  }
  // 4. read-only, never written, and older than the session
  if (readOnly && preexisting) return { autoCls: 'input', reason: 'readonly-preexisting' };
  // 5. written during the session
  if (written) return { autoCls: 'process', reason: 'written' };
  // 6. scanned-only leftovers
  if (preexisting) return { autoCls: 'input', reason: 'scanned-preexisting' };
  return { autoCls: 'process', reason: 'scanned-new' };
}

// ---------------------------------------------------------------- buildTree

function normalizeOverrides(raw) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!value || typeof value !== 'object') continue;
    const rel = cleanRel(toPosix(key));
    if (!rel) continue;
    const entry = { cls: null, note: null };
    if (typeof value.cls === 'string' && LANES.indexOf(value.cls) !== -1) entry.cls = value.cls;
    if (typeof value.note === 'string') entry.note = value.note;
    if (!entry.cls && entry.note === null) continue;
    map.set(rel.toLowerCase(), entry);
  }
  return map;
}

function normalizeLimit(raw, fallback) {
  return isNum(raw) && Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function normalizeTurnTimes(raw) {
  const map = new Map();
  if (!raw) return map;
  if (raw instanceof Map) {
    for (const [k, v] of raw) if (isNum(k) && isNum(v)) map.set(k, v);
    return map;
  }
  if (typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      const turn = Number(k);
      if (isNum(turn) && isNum(raw[k])) map.set(turn, raw[k]);
    }
  }
  return map;
}

function actionsFor(ops) {
  const seen = new Set();
  const out = [];
  for (const op of ops) {
    const key = op.action + '|' + op.tool + '|' + op.seq + '|' + op.turn;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tool: op.tool, action: op.action, turn: op.turn, seq: op.seq, time: op.time });
  }
  out.sort(
    (a, b) =>
      a.seq - b.seq || a.turn - b.turn || pathCmp(a.action, b.action) || pathCmp(a.tool, b.tool)
  );
  return out;
}

function turnNodeId(path, turn) {
  return path + '#t' + turn;
}

function inputNodeId(path) {
  return path + '#i';
}

function finalNodeId(path) {
  return path + '#final';
}

/**
 * buildTree({ fileOps, scanFiles, scanTotal?, sessionCreatedAt, overrides, limits,
 *            turnTimes?, gonePaths?, warnings? }) -> { columns, nodes, edges, counts, warnings, workspace? }
 * `fileOps[].path` and `scanFiles[].relPath` are expected to be workspace-relative.
 * `scanTotal` is the scanner's full file count *before* maxScanFiles truncation
 * (CONTRACT.md §5 `workspace.scanned`); defaults to `scanFiles.length`.
 * `gonePaths` lists records the host has pruned (temp paths whose file no longer
 * exists, e.g. moved to trash by another session's cleanup). A pruned path that
 * shows up in the scan again is honoured normally.
 */
export function buildTree(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const rawOps = Array.isArray(opts.fileOps) ? opts.fileOps : [];
  const rawScan = Array.isArray(opts.scanFiles) ? opts.scanFiles : [];
  const overrides = normalizeOverrides(opts.overrides);
  const sessionCreatedAt = isNum(opts.sessionCreatedAt) ? opts.sessionCreatedAt : null;
  const maxNodes = normalizeLimit(opts.limits && opts.limits.maxNodes, DEFAULT_MAX_NODES);
  const turnTimes = normalizeTurnTimes(opts.turnTimes);
  const goneKeys = new Set();
  for (const raw of Array.isArray(opts.gonePaths) ? opts.gonePaths : []) {
    if (typeof raw !== 'string') continue;
    const rel = cleanRel(toPosix(raw));
    if (rel) goneKeys.add(rel.toLowerCase());
  }
  const scanTotal =
    isNum(opts.scanTotal) && opts.scanTotal >= 0 ? Math.floor(opts.scanTotal) : null;

  // Directories holding a project manifest: heuristics never fire underneath them,
  // so a repo's own dotfiles and tool scripts survive "clean up temp files".
  const manifestDirs = new Set();
  for (const raw of rawScan) {
    const rel = raw && typeof raw.relPath === 'string' ? cleanRel(toPosix(raw.relPath)) : null;
    if (!rel) continue;
    const slash = rel.lastIndexOf('/');
    const base = (slash === -1 ? rel : rel.slice(slash + 1)).toLowerCase();
    if (!MANIFEST_BASENAMES.has(base)) continue;
    manifestDirs.add(slash === -1 ? '' : rel.slice(0, slash).toLowerCase());
  }
  const inProjectDir = (rel) => {
    // Only sub-directory manifests count: a root manifest would blanket the whole
    // workspace and make every probe script look like project code.
    if (manifestDirs.size === 0) return false;
    const lower = rel.toLowerCase();
    let dir = lower;
    for (;;) {
      const slash = dir.lastIndexOf('/');
      if (slash === -1) return false;
      dir = dir.slice(0, slash);
      if (dir !== '' && manifestDirs.has(dir)) return true;
    }
  };

  const warnings = [];
  const warn = (key) => {
    if (typeof key === 'string' && warnings.indexOf(key) === -1) warnings.push(key);
  };
  if (Array.isArray(opts.warnings)) for (const w of opts.warnings) warn(w);

  // ---- normalise ops (relative posix, stable order)
  const ops = [];
  for (const raw of rawOps) {
    if (!raw || typeof raw !== 'object') {
      warn('bad-path');
      continue;
    }
    const rel = typeof raw.path === 'string' ? cleanRel(toPosix(raw.path)) : null;
    if (!rel) {
      warn('bad-path');
      continue;
    }
    ops.push({
      path: rel,
      key: rel.toLowerCase(),
      action: typeof raw.action === 'string' ? raw.action : 'read',
      tool: typeof raw.tool === 'string' ? raw.tool : '',
      turn: isNum(raw.turn) ? raw.turn : 0,
      seq: isNum(raw.seq) ? raw.seq : 0,
      time: isNum(raw.time) ? raw.time : 0,
    });
  }
  ops.sort(
    (a, b) =>
      a.seq - b.seq ||
      a.turn - b.turn ||
      pathCmp(a.path, b.path) ||
      pathCmp(a.action, b.action) ||
      pathCmp(a.tool, b.tool)
  );

  // ---- normalise scan entries (first spelling wins per case-insensitive key)
  const scanByKey = new Map();
  for (const raw of rawScan) {
    if (!raw || typeof raw !== 'object') {
      warn('bad-path');
      continue;
    }
    const rawPath = typeof raw.relPath === 'string' ? raw.relPath : typeof raw.path === 'string' ? raw.path : null;
    const rel = rawPath === null ? null : cleanRel(toPosix(rawPath));
    if (!rel) {
      warn('bad-path');
      continue;
    }
    const key = rel.toLowerCase();
    if (scanByKey.has(key)) continue;
    scanByKey.set(key, {
      relPath: rel,
      size: isNum(raw.size) ? raw.size : 0,
      mtime: isNum(raw.mtime) ? raw.mtime : null,
      birthtime: isNum(raw.birthtime) ? raw.birthtime : isNum(raw.mtime) ? raw.mtime : null,
    });
  }

  // ---- group ops by case-insensitive path key; first spelling wins
  const entries = new Map(); // key -> entry
  const entryFor = (key, displayPath) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, path: displayPath, ops: [], scan: null };
      entries.set(key, entry);
    }
    return entry;
  };
  for (const op of ops) entryFor(op.key, op.path).ops.push(op);
  for (const [key, scan] of scanByKey) {
    const entry = entryFor(key, scan.relPath);
    if (!entry.scan) entry.scan = scan;
  }

  // ---- reference map: scripts that produced another artifact in the same tool call
  const callWrites = new Map(); // seq -> Set<key>
  for (const entry of entries.values()) {
    for (const op of entry.ops) {
      if (op.action === 'write' || op.action === 'edit' || op.action === 'present') {
        let set = callWrites.get(op.seq);
        if (!set) {
          set = new Set();
          callWrites.set(op.seq, set);
        }
        set.add(entry.key);
      }
    }
  }
  const refMap = new Map(); // key -> Set<referencing key>
  for (const entry of entries.values()) {
    for (const op of entry.ops) {
      if (op.action !== 'exec' && op.action !== 'read') continue;
      const writes = callWrites.get(op.seq);
      if (!writes) continue;
      for (const w of writes) {
        if (w === entry.key) continue;
        let set = refMap.get(entry.key);
        if (!set) {
          set = new Set();
          refMap.set(entry.key, set);
        }
        set.add(w);
      }
    }
  }

  // ---- per-path info + classification
  for (const entry of entries.values()) {
    const touchedTurns = [];
    {
      const seen = new Set();
      for (const op of entry.ops) {
        if (seen.has(op.turn)) continue;
        seen.add(op.turn);
        touchedTurns.push(op.turn);
      }
      touchedTurns.sort((a, b) => a - b);
    }
    const written = entry.ops.some((o) => o.action === 'write' || o.action === 'edit');
    const presented = entry.ops.some((o) => o.action === 'present');
    const hasRead = entry.ops.some((o) => o.action === 'read' || o.action === 'exec');
    const readOnly = !written && !presented && hasRead;
    const refs = refMap.has(entry.key) ? Array.from(refMap.get(entry.key)).sort(pathCmp) : [];
    const info = {
      written,
      presented,
      readOnly,
      touchedTurns,
      birthtime: entry.scan ? entry.scan.birthtime : null,
      mtime: entry.scan ? entry.scan.mtime : null,
      sessionCreatedAt,
      referencedBy: refs,
      projectDir: inProjectDir(entry.path),
    };
    const auto = classifyPath(entry.path, info);
    const override = overrides.get(entry.key);
    const overrideCls = override && override.cls ? override.cls : null;
    entry.info = info;
    entry.touchedTurns = touchedTurns;
    entry.written = written;
    entry.presented = presented;
    entry.deleted = entry.ops.some((o) => o.action === 'delete');
    entry.autoCls = auto.autoCls;
    entry.autoReason = auto.reason;
    entry.cls = overrideCls || auto.autoCls;
    entry.overridden = overrideCls !== null;
    entry.note = override && typeof override.note === 'string' ? override.note : null;
    entry.hasOverride = !!override;
  }

  // ---- pruned records: temp paths this session touched whose file is gone.
  // Another session (or the OS) may move a file to the plugin trash; this session's
  // event log still mentions it. Once the host records such a path as gone, drop the
  // entry so the tree stops counting a file that is not there any more. A path that
  // comes back on disk (entry.scan) is kept: pruning only forgets, it never hides.
  // Runs after classification so only final-lane `temp` records are forgotten — a
  // written/edited/presented artifact or a non-temp override keeps its record.
  if (goneKeys.size > 0) {
    for (const [key, entry] of entries) {
      if (!goneKeys.has(key)) continue;
      if (entry.scan) continue;
      if (entry.cls !== 'temp') continue;
      entries.delete(key);
    }
  }

  // ---- columns
  const turnNumbers = [];
  {
    const seen = new Set();
    for (const entry of entries.values()) {
      for (const turn of entry.touchedTurns) {
        if (seen.has(turn)) continue;
        seen.add(turn);
        turnNumbers.push(turn);
      }
    }
    turnNumbers.sort((a, b) => a - b);
  }
  const colOfTurn = new Map();
  turnNumbers.forEach((turn, i) => colOfTurn.set(turn, i + 1));
  const finalCol = turnNumbers.length + 1;

  const turnOpTime = new Map();
  for (const entry of entries.values()) {
    for (const op of entry.ops) {
      if (!(op.time > 0)) continue;
      const current = turnOpTime.get(op.turn);
      if (current === undefined || op.time < current) turnOpTime.set(op.turn, op.time);
    }
  }

  const columns = [{ id: 'input', kind: 'input', title: '输入', subtitle: '会话开始前' }];
  for (const turn of turnNumbers) {
    const t = turnTimes.has(turn) ? turnTimes.get(turn) : turnOpTime.has(turn) ? turnOpTime.get(turn) : null;
    columns.push({
      id: 't' + turn,
      kind: 'turn',
      title: '第 ' + turn + ' 轮',
      subtitle: t === null ? '' : hhmm(t),
      turn,
    });
  }
  columns.push({ id: 'final', kind: 'final', title: '交付', subtitle: '最终产物' });

  // ---- nodes
  const nodes = [];
  const sourcesFor = (entry, inputColumn) => {
    const out = [];
    if (!inputColumn && entry.ops.length) out.push('event');
    if (entry.scan) out.push('scan');
    if (entry.hasOverride) out.push('override');
    return out;
  };
  const baseNode = (entry, suffix, col, kind, inputColumn) => {
    const parts = splitRel(entry.path);
    const scan = entry.scan;
    return {
      id: entry.path + '#' + suffix,
      path: entry.path,
      name: parts.name,
      ext: parts.ext,
      dir: parts.dir,
      col,
      lane: entry.cls,
      cls: entry.cls,
      autoCls: entry.autoCls,
      reason: entry.overridden ? 'override' : entry.autoReason,
      overridden: entry.overridden,
      note: entry.note,
      exists: scan ? true : !entry.deleted,
      size: scan ? scan.size : 0,
      mtime: scan ? scan.mtime : null,
      birthtime: scan ? scan.birthtime : null,
      turns: [],
      actions: [],
      sources: sourcesFor(entry, inputColumn),
      kind,
    };
  };

  // input column: scanned files that are preexisting, were never written, and
  // whose final class (after overrides) is not temp. Temp leftovers are carried
  // by the workspace.tempPaths backlog, not by the input lane (CONTRACT.md §5):
  // the input lane answers "what did I hand the agent", not "what junk was here".
  {
    const candidates = [];
    for (const entry of entries.values()) {
      if (!entry.scan) continue;
      if (entry.written || entry.presented) continue;
      if (entry.cls === 'temp') continue;
      // CONTRACT.md §4/§5: preexisting uses `birthtime ?? mtime`; this must be
      // exactly the same fallback classifyPath() uses, never a stricter test.
      const bt = entry.scan.birthtime !== null ? entry.scan.birthtime : entry.scan.mtime;
      if (bt === null || sessionCreatedAt === null || bt > sessionCreatedAt) continue;
      candidates.push(entry);
    }
    // CONTRACT.md §5: final lane `input` first, then `process`; within a lane
    // newest mtime first, relPath codepoint order as the deterministic tie-break.
    const inputLaneRank = (entry) => (entry.cls === 'input' ? 0 : entry.cls === 'process' ? 1 : 2);
    candidates.sort((a, b) => {
      const ar = inputLaneRank(a);
      const br = inputLaneRank(b);
      if (ar !== br) return ar - br;
      const am = a.scan.mtime === null ? -Infinity : a.scan.mtime;
      const bm = b.scan.mtime === null ? -Infinity : b.scan.mtime;
      if (am !== bm) return bm - am;
      return pathCmp(a.path, b.path);
    });
    for (const entry of candidates.slice(0, MAX_INPUT_NODES)) {
      const node = baseNode(entry, 'i', 0, 'input', true);
      node.turns = [];
      node.actions = [];
      nodes.push(node);
    }
  }

  // turn columns: one node per (path, touched turn)
  const firstTurnNode = new Map();
  const lastTurnNode = new Map();
  for (const entry of entries.values()) {
    const turns = entry.touchedTurns;
    if (turns.length === 0) continue;
    firstTurnNode.set(entry.key, turnNodeId(entry.path, turns[0]));
    lastTurnNode.set(entry.key, turnNodeId(entry.path, turns[turns.length - 1]));
    for (const turn of turns) {
      const node = baseNode(entry, 't' + turn, colOfTurn.get(turn), 'turn', false);
      node.turns = [turn];
      node.actions = actionsFor(entry.ops.filter((op) => op.turn === turn));
      nodes.push(node);
    }
  }

  // final column: only paths whose final classification is deliverable
  for (const entry of entries.values()) {
    if (entry.cls !== 'deliverable') continue;
    const node = baseNode(entry, 'final', finalCol, 'final', false);
    node.turns = entry.touchedTurns.slice();
    node.actions = actionsFor(entry.ops.filter((op) => op.action === 'present'));
    nodes.push(node);
  }

  const kindRank = (kind) => (kind === 'input' ? 0 : kind === 'turn' ? 1 : 2);
  nodes.sort((a, b) => {
    if (a.col !== b.col) return a.col - b.col;
    const la = LANE_ORDER[a.lane] === undefined ? 99 : LANE_ORDER[a.lane];
    const lb = LANE_ORDER[b.lane] === undefined ? 99 : LANE_ORDER[b.lane];
    if (la !== lb) return la - lb;
    const pc = pathCmp(a.path, b.path);
    if (pc !== 0) return pc;
    return kindRank(a.kind) - kindRank(b.kind);
  });

  let kept = nodes;
  if (nodes.length > maxNodes) {
    kept = nodes.slice(0, maxNodes);
    warn('node-limit');
  }
  const nodeIds = new Set(kept.map((n) => n.id));

  // ---- edges
  const edges = [];
  const edgeSeen = new Set();
  const pushEdge = (from, to, kind) => {
    if (!nodeIds.has(from) || !nodeIds.has(to)) return;
    const key = kind + '|' + from + '|' + to;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind });
  };

  for (const entry of entries.values()) {
    const turns = entry.touchedTurns;
    if (turns.length === 0) continue;
    // origin: input node -> first turn node
    if (nodeIds.has(inputNodeId(entry.path))) {
      pushEdge(inputNodeId(entry.path), turnNodeId(entry.path, turns[0]), 'origin');
    }
    // evolution: adjacent turn nodes of the same file
    for (let i = 1; i < turns.length; i++) {
      pushEdge(turnNodeId(entry.path, turns[i - 1]), turnNodeId(entry.path, turns[i]), 'evolution');
    }
  }

  // derived: same turn, read/exec source -> write target, nearest seq first
  const readersByTurn = new Map(); // turn -> Map<key, number[]>
  const writersByTurn = new Map(); // turn -> Map<key, number>
  for (const entry of entries.values()) {
    for (const op of entry.ops) {
      if (op.action === 'read' || op.action === 'exec') {
        let byKey = readersByTurn.get(op.turn);
        if (!byKey) {
          byKey = new Map();
          readersByTurn.set(op.turn, byKey);
        }
        let seqs = byKey.get(entry.key);
        if (!seqs) {
          seqs = [];
          byKey.set(entry.key, seqs);
        }
        seqs.push(op.seq);
      } else if (op.action === 'write' || op.action === 'edit') {
        let byKey = writersByTurn.get(op.turn);
        if (!byKey) {
          byKey = new Map();
          writersByTurn.set(op.turn, byKey);
        }
        const prev = byKey.get(entry.key);
        if (prev === undefined || op.seq < prev) byKey.set(entry.key, op.seq);
      }
    }
  }
  const writerOrder = [];
  for (const [turn, byKey] of writersByTurn) {
    for (const [key, seq] of byKey) writerOrder.push({ turn, key, seq });
  }
  writerOrder.sort((a, b) => a.turn - b.turn || a.seq - b.seq || pathCmp(a.key, b.key));
  const derivedLimited = { hit: false };
  outer: for (const w of writerOrder) {
    const readers = readersByTurn.get(w.turn);
    if (!readers) continue;
    const candidates = [];
    for (const [rkey, seqs] of readers) {
      if (rkey === w.key) continue;
      let best = Infinity;
      let nearest = Infinity;
      for (const s of seqs) {
        const d = Math.abs(s - w.seq);
        if (d < best) {
          best = d;
          nearest = s;
        }
      }
      candidates.push({ key: rkey, dist: best, seq: nearest });
    }
    candidates.sort((a, b) => a.dist - b.dist || a.seq - b.seq || pathCmp(a.key, b.key));
    let added = 0;
    for (const c of candidates) {
      if (added >= MAX_DERIVED_IN) break;
      if (edges.length >= MAX_DERIVED_EDGES) {
        derivedLimited.hit = true;
        break outer;
      }
      pushEdge(turnNodeId(c.key, w.turn), turnNodeId(w.key, w.turn), 'derived');
      added++;
    }
  }
  if (derivedLimited.hit) warn('derived-limit');

  // deliverable: last turn node -> final node
  for (const entry of entries.values()) {
    if (entry.cls !== 'deliverable') continue;
    const last = lastTurnNode.get(entry.key);
    if (!last) continue;
    pushEdge(last, finalNodeId(entry.path), 'deliverable');
  }

  const kindOrder = { origin: 0, evolution: 1, derived: 2, deliverable: 3 };
  edges.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] || pathCmp(a.from, b.from) || pathCmp(a.to, b.to)
  );

  // ---- counts: one file counted once, by final classification
  const counts = { deliverable: 0, process: 0, input: 0, temp: 0, files: 0 };
  {
    const keys = Array.from(entries.keys()).sort(pathCmp);
    for (const key of keys) {
      const entry = entries.get(key);
      if (Object.prototype.hasOwnProperty.call(counts, entry.cls)) counts[entry.cls]++;
      counts.files++;
    }
  }

  // ---- workspace backlog: temp files classified on disk but never in `nodes`
  // (CONTRACT.md §5). `counts` stays file-level; this is the cleanup-only half.
  const nodePathKeys = new Set();
  for (const node of kept) nodePathKeys.add(node.path.toLowerCase());
  const workspaceTempPaths = [];
  for (const entry of entries.values()) {
    if (entry.cls !== 'temp') continue;
    if (nodePathKeys.has(entry.key)) continue;
    workspaceTempPaths.push(entry.path);
  }
  workspaceTempPaths.sort(pathCmp);
  const tempPathCount = workspaceTempPaths.length;
  let workspace = null;
  if (tempPathCount > 0) {
    const shown = workspaceTempPaths.slice(0, MAX_WORKSPACE_TEMP_PATHS);
    workspace = {
      // `scanTotal` is the scanner's count before maxScanFiles truncation; when
      // the host does not provide it we can only report the files we received.
      scanned: Math.max(scanTotal === null ? scanByKey.size : scanTotal, scanByKey.size),
      tempPathCount,
      tempPaths: shown,
      truncated: tempPathCount > shown.length,
    };
  }

  return { columns, nodes: kept, edges, counts, warnings, ...(workspace ? { workspace } : {}) };
}

// -------------------------------------------------------------- buildLedger

function extractTurnTimes(events) {
  const map = new Map();
  if (!Array.isArray(events)) return map;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || ev.type !== 'turn/start') continue;
    const data = ev.data;
    if (!data || typeof data !== 'object' || !isNum(data.turn)) continue;
    if (!isNum(ev.time)) continue;
    const prev = map.get(data.turn);
    if (prev === undefined || ev.time < prev) map.set(data.turn, ev.time);
  }
  return map;
}

function lastEventTime(events) {
  let max = null;
  if (!Array.isArray(events)) return max;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !isNum(ev.time)) continue;
    if (max === null || ev.time > max) max = ev.time;
  }
  return max;
}

/**
 * buildLedger(input) -> Ledger (CONTRACT.md §5).
 * Purely derived from `input`; `generatedAt` comes from input.generatedAt (C may
 * stamp it) or otherwise from the latest event time — never from the wall clock.
 */
export function buildLedger(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const workspacePath =
    typeof opts.workspacePath === 'string' && opts.workspacePath.trim() ? opts.workspacePath : null;
  const sessionCreatedAt = isNum(opts.sessionCreatedAt) ? opts.sessionCreatedAt : null;

  const extracted = extractFileOpsDetailed(opts.events);
  const warnings = extracted.warnings.slice();
  const warn = (key) => {
    if (warnings.indexOf(key) === -1) warnings.push(key);
  };

  const relOps = [];
  for (const op of extracted.fileOps) {
    const rel = relativizePath(op.path, workspacePath);
    if (!rel) {
      warn('outside-workspace');
      continue;
    }
    relOps.push({
      path: rel,
      action: op.action,
      tool: op.tool,
      turn: op.turn,
      seq: op.seq,
      time: op.time,
    });
  }

  const relScan = [];
  const rawScan = Array.isArray(opts.scanFiles) ? opts.scanFiles : [];
  for (const raw of rawScan) {
    if (!raw || typeof raw !== 'object') continue;
    const rawPath = typeof raw.relPath === 'string' ? raw.relPath : typeof raw.path === 'string' ? raw.path : null;
    const rel = rawPath === null ? null : relativizePath(rawPath, workspacePath);
    if (!rel) {
      warn('outside-workspace');
      continue;
    }
    relScan.push({
      relPath: rel,
      size: isNum(raw.size) ? raw.size : 0,
      mtime: isNum(raw.mtime) ? raw.mtime : null,
      birthtime: isNum(raw.birthtime) ? raw.birthtime : isNum(raw.mtime) ? raw.mtime : null,
    });
  }

  const generatedAt = isNum(opts.generatedAt)
    ? opts.generatedAt
    : lastEventTime(opts.events) !== null
    ? lastEventTime(opts.events)
    : sessionCreatedAt !== null
    ? sessionCreatedAt
    : 0;

  const tree = buildTree({
    fileOps: relOps,
    scanFiles: relScan,
    scanTotal: isNum(opts.scanTotal) && opts.scanTotal >= 0 ? Math.floor(opts.scanTotal) : null,
    sessionCreatedAt,
    overrides: opts.overrides,
    gonePaths: opts.gonePaths,
    limits: opts.limits,
    turnTimes: extractTurnTimes(opts.events),
    warnings,
  });

  return {
    sessionId: typeof opts.sessionId === 'string' ? opts.sessionId : '',
    workspacePath,
    sessionCreatedAt,
    generatedAt,
    live: opts.live === true,
    source: opts.source === 'live' ? 'live' : 'log',
    counts: tree.counts,
    ...(tree.workspace ? { workspace: tree.workspace } : {}),
    lanes: LANES.slice(),
    columns: tree.columns,
    nodes: tree.nodes,
    edges: tree.edges,
    warnings: tree.warnings,
  };
}
