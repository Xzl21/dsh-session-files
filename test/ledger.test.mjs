/**
 * test/ledger.test.mjs — plain-node test runner for host/ledger.mjs.
 *
 * Run with:  & "<node.exe>" test/ledger.test.mjs
 * No test framework, no third-party deps. Prints PASS/FAIL per case and a summary.
 */
import assert from 'node:assert/strict';
import {
  buildLedger,
  buildTree,
  classifyPath,
  extractFileOps,
  shouldSkipDir,
  SKIP_DIR_PATTERNS,
} from '../host/ledger.mjs';

const WS = 'D:\\WS';
const CREATED = 50000;

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failCount += 1;
    console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message.split('\n')[0] : String(err)));
  }
}

// ---------------------------------------------------------------- helpers

/** Tiny event stream builder: seq/time are derived deterministically. */
function stream() {
  let seq = 0;
  let turn = 0;
  const events = [];
  return {
    events,
    turnStart(t, time) {
      turn = t;
      seq += 1;
      events.push({
        type: 'turn/start',
        seq,
        time: time === undefined ? 100000 + seq * 10 : time,
        data: { turn: t },
      });
      return this;
    },
    call(name, args, time) {
      seq += 1;
      events.push({
        type: 'tool/call',
        seq,
        time: time === undefined ? 100000 + seq * 10 : time,
        data: {
          turn,
          step: 1,
          callId: 'call-' + seq,
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      });
      return this;
    },
    raw(event) {
      events.push(event);
      return this;
    },
  };
}

function ledger(events, extra) {
  return buildLedger(
    Object.assign(
      {
        sessionId: 'session-test',
        workspacePath: WS,
        sessionCreatedAt: CREATED,
        events,
      },
      extra || {}
    )
  );
}

function nodeById(out, id) {
  return out.nodes.find((n) => n.id === id);
}

function nodeIdSet(out) {
  return new Set(out.nodes.map((n) => n.id));
}

function columnIds(out) {
  return out.columns.map((c) => c.id);
}

function opsOf(toolName, args) {
  const s = stream().turnStart(1);
  s.call(toolName, args);
  return extractFileOps(s.events);
}

function hasOp(ops, suffix, action) {
  return ops.some((o) => o.path.endsWith(suffix) && (!action || o.action === action));
}

function laneOf(out, path, kind) {
  const n = out.nodes.find((x) => x.path === path && (!kind || x.kind === kind));
  return n ? n.lane : undefined;
}

// ============================================================ extractFileOps

test('extract: write / edit / read / present map to their actions', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\a.txt' });
  s.call('edit', { file_path: 'D:\\WS\\b.txt' });
  s.call('read', { file_path: 'D:\\WS\\c.txt' });
  s.call('read_image', { path: 'D:\\WS\\d.png' });
  s.call('present', { files: [{ path: 'D:\\WS\\e.docx' }] });
  const ops = extractFileOps(s.events);
  assert.ok(hasOp(ops, 'a.txt', 'write'));
  assert.ok(hasOp(ops, 'b.txt', 'edit'));
  assert.ok(hasOp(ops, 'c.txt', 'read'));
  assert.ok(hasOp(ops, 'd.png', 'read'));
  assert.ok(hasOp(ops, 'e.docx', 'present'));
  for (let i = 1; i < ops.length; i++) assert.ok(ops[i - 1].seq <= ops[i].seq, 'ops sorted by seq');
});

test('extract: bash `python x.py > out.txt` gives exec + write', () => {
  const ops = opsOf('bash', { command: 'python _tmp_probe.py > out.txt' });
  assert.ok(hasOp(ops, '_tmp_probe.py', 'exec'), 'script exec');
  assert.ok(hasOp(ops, 'out.txt', 'write'), 'redirect write');
});

test('extract: heredoc `cat > script.py <<EOF` records a write, not an exec', () => {
  const cmd = "cat > script.py <<'EOF'\nprint('hi > there')\nEOF";
  const ops = opsOf('bash', { command: cmd });
  assert.ok(hasOp(ops, 'script.py', 'write'), 'heredoc target write');
  assert.ok(!hasOp(ops, 'script.py', 'exec'), 'heredoc target is not executed');
  assert.strictEqual(ops.length, 1);
});

test('extract: PowerShell here-string piped into Set-Content records a write', () => {
  const cmd = "@'\nhello > world\n'@ | Set-Content x.ps1";
  const ops = opsOf('pwsh', { command: cmd });
  assert.ok(hasOp(ops, 'x.ps1', 'write'));
});

test('extract: interpreter invocations (pwsh -File, node, bash, .\\x.ps1)', () => {
  const a = opsOf('pwsh', { command: 'pwsh -File "D:\\WS\\tools\\run.ps1"' });
  assert.ok(hasOp(a, 'run.ps1', 'exec'));
  const b = opsOf('bash', { command: 'node build.mjs' });
  assert.ok(hasOp(b, 'build.mjs', 'exec'));
  const c = opsOf('bash', { command: 'bash x.sh' });
  assert.ok(hasOp(c, 'x.sh', 'exec'));
  const d = opsOf('pwsh', { command: '.\\x.ps1' });
  assert.ok(hasOp(d, 'x.ps1', 'exec'));
  const e = opsOf('bash', { command: 'python3 extract.py' });
  assert.ok(hasOp(e, 'extract.py', 'exec'));
});

test('extract: quoted path with spaces is kept as one path', () => {
  const ops = opsOf('pwsh', { command: 'Get-Content "D:\\WS\\in\\my file.docx"' });
  assert.ok(ops.some((o) => o.path === 'D:\\WS\\in\\my file.docx' && o.action === 'read'));
});

test('extract: `2> err.txt` writes, `2>&1` is not a file', () => {
  const ops = opsOf('bash', { command: 'cmd 2> err.txt 2>&1' });
  assert.ok(hasOp(ops, 'err.txt', 'write'));
  assert.ok(!ops.some((o) => o.path.indexOf('&') !== -1), 'no &1 token as a path');
});

test('extract: ignores flags, URLs, /dev/null, NUL, %VAR%, $env', () => {
  const ops = opsOf('bash', {
    command: 'curl -s https://example.com/a.txt -o /dev/null && echo NUL > $env:TEMP\\x.txt',
  });
  assert.strictEqual(ops.length, 0);
  const ops2 = opsOf('bash', { command: 'echo %TEMP%\\y.txt' });
  assert.strictEqual(ops2.length, 0);
});

test('extract: present accepts objects, strings and plain path', () => {
  const a = opsOf('present', { files: [{ path: 'p/one.docx' }, { path: 'p/two.docx' }] });
  assert.strictEqual(a.filter((o) => o.action === 'present').length, 2);
  const b = opsOf('present', { files: ['p/three.docx'] });
  assert.ok(b.some((o) => o.path === 'p/three.docx' && o.action === 'present'));
  const c = opsOf('present', { path: 'p/four.docx' });
  assert.ok(c.some((o) => o.path === 'p/four.docx' && o.action === 'present'));
});

test('extract: bad JSON arguments does not throw and yields no ops', () => {
  const s = stream().turnStart(1);
  s.call('write', '{not json');
  let ops;
  assert.doesNotThrow(() => {
    ops = extractFileOps(s.events);
  });
  assert.deepStrictEqual(ops, []);
});

test('extract: delete tool names and rm commands produce delete action', () => {
  const a = opsOf('delete_file', { file_path: 'tmp/old.bin' });
  assert.ok(hasOp(a, 'old.bin', 'delete'));
  const b = opsOf('bash', { command: 'rm -f out/x.txt' });
  assert.ok(hasOp(b, 'x.txt', 'delete'));
});

test('extract: one-turn heredoc script with no output is one-shot; with output it is referenced', () => {
  const oneShot = opsOf('bash', {
    command: "cat > scan.py <<'EOF'\nprint(1)\nEOF\npython scan.py",
  });
  assert.ok(hasOp(oneShot, 'scan.py', 'write'));
  assert.ok(hasOp(oneShot, 'scan.py', 'exec'));

  const referenced = opsOf('bash', {
    command: "cat > helper.py <<'EOF'\nprint(1)\nEOF\npython helper.py > out.json",
  });
  assert.ok(hasOp(referenced, 'helper.py', 'exec'));
  assert.ok(hasOp(referenced, 'out.json', 'write'));
});

// ============================================================== classifyPath

test('classify 1: presented wins over temp names', () => {
  const r = classifyPath('_tmp_probe.py', { presented: true, written: true, touchedTurns: [1] });
  assert.deepStrictEqual(r, { autoCls: 'deliverable', reason: 'presented' });
});

test('classify 2: deliverable directory segment', () => {
  const r = classifyPath('deliverables/report.docx', { written: true, touchedTurns: [1] });
  assert.deepStrictEqual(r, { autoCls: 'deliverable', reason: 'dir' });
  const zh = classifyPath('交付/终稿.docx', { written: true, touchedTurns: [1] });
  assert.strictEqual(zh.autoCls, 'deliverable');
  assert.strictEqual(zh.reason, 'dir');
});

test('classify 3a: _tmp_probe.py -> temp / temp-name', () => {
  assert.deepStrictEqual(classifyPath('_tmp_probe.py', { written: true, touchedTurns: [1] }), {
    autoCls: 'temp',
    reason: 'temp-name',
  });
});

test('classify 3b: debug.log -> temp / temp-ext', () => {
  assert.deepStrictEqual(classifyPath('debug.log', { written: true, touchedTurns: [2] }), {
    autoCls: 'temp',
    reason: 'temp-ext',
  });
  assert.strictEqual(classifyPath('a.bak', {}).autoCls, 'temp');
  assert.strictEqual(classifyPath('b.old', {}).autoCls, 'temp');
});

test('classify 3c: verify/x.txt -> temp / temp-dir', () => {
  assert.deepStrictEqual(classifyPath('verify/x.txt', { written: true, touchedTurns: [1] }), {
    autoCls: 'temp',
    reason: 'temp-dir',
  });
  assert.strictEqual(classifyPath('tmp/x.bin', {}).autoCls, 'temp');
});

test('classify 3d: one-shot script -> temp / oneday-script', () => {
  const r = classifyPath('helper.py', { written: true, touchedTurns: [1], referencedBy: [] });
  assert.deepStrictEqual(r, { autoCls: 'temp', reason: 'oneday-script' });
  const r2 = classifyPath('debug_helper.py', { written: true, touchedTurns: [1] });
  assert.strictEqual(r2.autoCls, 'temp');
});

test('classify 4: read-only preexisting docx -> input', () => {
  const r = classifyPath('招标文件.docx', {
    written: false,
    readOnly: true,
    touchedTurns: [1],
    birthtime: 1000,
    sessionCreatedAt: CREATED,
  });
  assert.deepStrictEqual(r, { autoCls: 'input', reason: 'readonly-preexisting' });
});

test('classify 4b: read-only but newer than the session -> not input', () => {
  const r = classifyPath('notes.txt', {
    written: false,
    readOnly: true,
    touchedTurns: [1],
    birthtime: 90000,
    sessionCreatedAt: CREATED,
  });
  assert.notStrictEqual(r.autoCls, 'input');
});

test('classify 5: written docx -> process', () => {
  assert.deepStrictEqual(classifyPath('build/report.docx', { written: true, touchedTurns: [2] }), {
    autoCls: 'process',
    reason: 'written',
  });
});

test('classify 6: scanned leftovers split by birthtime', () => {
  assert.deepStrictEqual(
    classifyPath('in/old.docx', { birthtime: 1000, sessionCreatedAt: CREATED }),
    { autoCls: 'input', reason: 'scanned-preexisting' }
  );
  assert.deepStrictEqual(
    classifyPath('in/new.docx', { birthtime: 90000, sessionCreatedAt: CREATED }),
    { autoCls: 'process', reason: 'scanned-new' }
  );
});

test('classify: birthtime falls back to mtime; unknown time never means input', () => {
  const viaMtime = classifyPath('in/a.docx', { mtime: 1000, sessionCreatedAt: CREATED });
  assert.strictEqual(viaMtime.autoCls, 'input');
  const unknown = classifyPath('in/b.docx', { sessionCreatedAt: CREATED });
  assert.strictEqual(unknown.autoCls, 'process');
});

test('classify: referenced one-turn script is process, not temp', () => {
  const r = classifyPath('helper.py', {
    written: true,
    touchedTurns: [1],
    referencedBy: ['out.json'],
  });
  assert.deepStrictEqual(r, { autoCls: 'process', reason: 'written' });
});

// ================================================================ buildLedger

test('buildLedger: preexisting scan file lands in the input column', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\out/a.txt' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: 'in/old.docx', size: 123, mtime: 1000, birthtime: 1000 }],
  });
  assert.deepStrictEqual(columnIds(out), ['input', 't1', 'final']);
  const input = nodeById(out, 'in/old.docx#i');
  assert.ok(input, 'input node exists');
  assert.strictEqual(input.kind, 'input');
  assert.strictEqual(input.lane, 'input');
  assert.deepStrictEqual(input.sources, ['scan']);
  assert.deepStrictEqual(input.turns, []);
  assert.strictEqual(input.col, 0);
  assert.strictEqual(input.size, 123);
});

test('buildLedger: turn 1 writing a probe script yields temp, a written docx yields process', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\_tmp_probe.py' });
  s.call('write', { file_path: 'D:\\WS\\build/report.docx' });
  const out = ledger(s.events);
  assert.strictEqual(laneOf(out, '_tmp_probe.py', 'turn'), 'temp');
  assert.strictEqual(laneOf(out, 'build/report.docx', 'turn'), 'process');
  assert.strictEqual(out.counts.temp, 1);
  assert.strictEqual(out.counts.process, 1);
  assert.strictEqual(out.counts.files, 2);
});

test('buildLedger: one-shot heredoc script -> temp, referenced heredoc script -> process', () => {
  const s = stream().turnStart(1);
  s.call('bash', { command: "cat > scan.py <<'EOF'\nprint(1)\nEOF\npython scan.py" });
  s.call('bash', {
    command: "cat > helper.py <<'EOF'\nprint(2)\nEOF\npython helper.py > out.json",
  });
  const out = ledger(s.events);
  assert.strictEqual(laneOf(out, 'scan.py', 'turn'), 'temp');
  assert.strictEqual(laneOf(out, 'helper.py', 'turn'), 'process');
  assert.strictEqual(laneOf(out, 'out.json', 'turn'), 'process');
});

test('buildLedger: same-turn read -> write produces a derived edge', () => {
  const s = stream().turnStart(1);
  s.call('read', { file_path: 'D:\\WS\\in/spec.txt' });
  s.call('write', { file_path: 'D:\\WS\\out/result.txt' });
  const out = ledger(s.events);
  assert.ok(
    out.edges.some(
      (e) => e.from === 'in/spec.txt#t1' && e.to === 'out/result.txt#t1' && e.kind === 'derived'
    ),
    'derived edge present'
  );
});

test('buildLedger: derived edges per write node are capped at 3', () => {
  const s = stream().turnStart(1);
  for (let i = 0; i < 5; i++) s.call('read', { file_path: 'D:\\WS\\in/r' + i + '.txt' });
  s.call('write', { file_path: 'D:\\WS\\out/all.txt' });
  const out = ledger(s.events);
  const incoming = out.edges.filter((e) => e.kind === 'derived' && e.to === 'out/all.txt#t1');
  assert.strictEqual(incoming.length, 3);
});

test('buildLedger: same file in two turns gets evolution edge and two nodes', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\out/report.docx' });
  s.turnStart(2);
  s.call('edit', { file_path: 'D:\\WS\\out/report.docx' });
  const out = ledger(s.events);
  assert.deepStrictEqual(
    out.nodes.filter((n) => n.path === 'out/report.docx').map((n) => n.id).sort(),
    ['out/report.docx#t1', 'out/report.docx#t2']
  );
  assert.ok(
    out.edges.some(
      (e) => e.from === 'out/report.docx#t1' && e.to === 'out/report.docx#t2' && e.kind === 'evolution'
    )
  );
});

test('buildLedger: present -> deliverable lane, #final node, deliverable edge', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\out/report.docx' });
  s.turnStart(2);
  s.call('present', { files: [{ path: 'D:\\WS\\out/report.docx' }] });
  const out = ledger(s.events);
  assert.strictEqual(laneOf(out, 'out/report.docx', 'turn'), 'deliverable');
  const final = nodeById(out, 'out/report.docx#final');
  assert.ok(final, '#final node exists');
  assert.strictEqual(final.kind, 'final');
  assert.strictEqual(final.lane, 'deliverable');
  assert.strictEqual(final.col, out.columns.length - 1);
  assert.deepStrictEqual(final.turns, [1, 2]);
  assert.strictEqual(final.actions.length, 1);
  assert.strictEqual(final.actions[0].action, 'present');
  assert.ok(
    out.edges.some(
      (e) =>
        e.from === 'out/report.docx#t2' &&
        e.to === 'out/report.docx#final' &&
        e.kind === 'deliverable'
    )
  );
  assert.strictEqual(out.counts.deliverable, 1);
});

test('buildLedger: present of an otherwise temp-named file promotes it to deliverable', () => {
  const s = stream().turnStart(1);
  s.call('present', { path: 'D:\\WS\\_tmp_probe.py' });
  const out = ledger(s.events);
  assert.strictEqual(laneOf(out, '_tmp_probe.py', 'turn'), 'deliverable');
  assert.ok(nodeById(out, '_tmp_probe.py#final'));
});

test('buildLedger: override beats auto classification and is flagged', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\verify/x.txt' });
  const out = ledger(s.events, {
    overrides: { 'verify/x.txt': { cls: 'deliverable', note: '留作证据' } },
  });
  const n = nodeById(out, 'verify/x.txt#t1');
  assert.strictEqual(n.autoCls, 'temp');
  assert.strictEqual(n.cls, 'deliverable');
  assert.strictEqual(n.lane, 'deliverable');
  assert.strictEqual(n.overridden, true);
  assert.strictEqual(n.note, '留作证据');
  assert.ok(n.sources.indexOf('override') !== -1);
  assert.ok(nodeById(out, 'verify/x.txt#final'), 'override to deliverable creates #final');
});

test('buildLedger: windows backslashes + case-insensitive dedupe keeps one file', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\A.PY' });
  s.turnStart(2);
  s.call('read', { file_path: 'd:\\ws\\a.py' });
  const out = ledger(s.events);
  const matches = out.nodes.filter((n) => n.path.toLowerCase() === 'a.py');
  assert.strictEqual(matches.length, 2, 'two turn nodes, same file');
  assert.strictEqual(new Set(matches.map((n) => n.id)).size, 2);
  for (const n of matches) assert.strictEqual(n.path, 'A.PY', 'first spelling wins');
  assert.strictEqual(out.counts.files, 1);
  assert.ok(out.edges.some((e) => e.kind === 'evolution'));
});

test('buildLedger: paths outside the workspace are dropped with a warning', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\OTHER\\x.txt' });
  s.call('write', { file_path: '..\\evil.txt' });
  s.call('write', { file_path: 'D:\\WS\\ok.txt' });
  const out = ledger(s.events);
  assert.deepStrictEqual(
    out.nodes.map((n) => n.path),
    ['ok.txt']
  );
  assert.ok(out.warnings.indexOf('outside-workspace') !== -1);
});

test('buildLedger: bad JSON arguments never throw, warning is reported', () => {
  const s = stream().turnStart(1);
  s.call('write', '{broken json');
  s.raw({ type: 'tool/call', seq: 99, time: 999, data: null });
  let out;
  assert.doesNotThrow(() => {
    out = ledger(s.events);
  });
  assert.ok(out.warnings.indexOf('bad-json') !== -1);
  assert.ok(out.warnings.indexOf('bad-event') !== -1);
  assert.deepStrictEqual(out.nodes, []);
});

test('buildLedger: empty events -> exactly input + final columns', () => {
  const out = ledger([]);
  assert.deepStrictEqual(columnIds(out), ['input', 'final']);
  assert.strictEqual(out.columns.length, 2);
  assert.deepStrictEqual(out.nodes, []);
  assert.deepStrictEqual(out.edges, []);
  assert.deepStrictEqual(out.counts, { deliverable: 0, process: 0, input: 0, temp: 0, files: 0 });
});

test('buildLedger: empty events still shows scanned preexisting inputs', () => {
  const out = ledger([], {
    scanFiles: [
      { relPath: 'input/spec.docx', size: 5, mtime: 900, birthtime: 900 },
      { relPath: 'input/new.docx', size: 5, mtime: 90000, birthtime: 90000 },
    ],
  });
  assert.deepStrictEqual(columnIds(out), ['input', 'final']);
  assert.deepStrictEqual(
    out.nodes.map((n) => n.id),
    ['input/spec.docx#i']
  );
  assert.strictEqual(out.counts.input, 1);
  assert.strictEqual(out.counts.process, 1);
  assert.strictEqual(out.counts.files, 2);
});

test('buildLedger: input column is capped at 40 nodes ordered by mtime desc', () => {
  const scanFiles = [];
  for (let i = 0; i < 45; i++) {
    scanFiles.push({
      relPath: 'input/f' + String(i).padStart(2, '0') + '.docx',
      size: 1,
      mtime: 1000 + i,
      birthtime: 1000,
    });
  }
  const out = ledger([], { scanFiles });
  assert.strictEqual(out.nodes.length, 40);
  // nodes are sorted by (col, lane, path); the *selection* is mtime-desc, so the
  // five oldest files are the ones dropped.
  const kept = out.nodes.map((n) => n.path);
  assert.ok(kept.indexOf('input/f44.docx') !== -1, 'newest mtime kept');
  assert.ok(kept.indexOf('input/f00.docx') === -1, 'oldest dropped');
  assert.ok(kept.indexOf('input/f04.docx') === -1, 'f04 dropped');
  assert.ok(kept.indexOf('input/f05.docx') !== -1, 'f05 kept');
});

test('buildLedger: turn columns carry title and HH:mm subtitle', () => {
  const t = new Date(2026, 0, 2, 10, 20, 0, 0).getTime();
  const s = stream().turnStart(1, t);
  s.call('write', { file_path: 'D:\\WS\\a.txt' });
  const out = ledger(s.events);
  const turnCol = out.columns[1];
  assert.strictEqual(turnCol.id, 't1');
  assert.strictEqual(turnCol.kind, 'turn');
  assert.strictEqual(turnCol.turn, 1);
  assert.strictEqual(turnCol.title, '第 1 轮');
  assert.strictEqual(turnCol.subtitle, '10:20');
});

test('buildLedger: counts dedupe by path and use final classification', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\out/a.txt' });
  s.call('write', { file_path: 'D:\\WS\\_tmp_probe.py' });
  s.turnStart(2);
  s.call('edit', { file_path: 'D:\\WS\\out/a.txt' });
  s.call('present', { path: 'D:\\WS\\out/a.txt' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: 'in/old.docx', size: 1, mtime: 100, birthtime: 100 }],
    overrides: { 'in/old.docx': { cls: 'input', note: '原件' } },
  });
  assert.deepStrictEqual(out.counts, {
    deliverable: 1,
    process: 0,
    input: 1,
    temp: 1,
    files: 3,
  });
});

test('buildLedger: workspacePath null accepts relative paths and drops absolute ones', () => {
  const a = stream().turnStart(1);
  a.call('write', { file_path: 'src/app.py' });
  const rel = buildLedger({ sessionId: 's', workspacePath: null, sessionCreatedAt: CREATED, events: a.events });
  assert.deepStrictEqual(
    rel.nodes.filter((n) => n.kind === 'turn').map((n) => n.path),
    ['src/app.py']
  );
  const b = stream().turnStart(1);
  b.call('write', { file_path: 'D:\\WS\\src\\app.py' });
  const abs = buildLedger({ sessionId: 's', workspacePath: null, sessionCreatedAt: CREATED, events: b.events });
  assert.deepStrictEqual(abs.nodes, []);
  assert.ok(abs.warnings.indexOf('outside-workspace') !== -1);
});

test('buildLedger: output is deterministic across two runs', () => {
  const make = () => {
    const s = stream().turnStart(1);
    s.call('write', { file_path: 'D:\\WS\\_tmp_probe.py' });
    s.call('bash', { command: 'python _tmp_probe.py > out.txt' });
    s.turnStart(2);
    s.call('read', { file_path: 'D:\\WS\\in/招标 文件.docx' });
    s.call('write', { file_path: 'D:\\WS\\deliverables/final.docx' });
    s.call('present', { files: [{ path: 'D:\\WS\\deliverables/final.docx' }] });
    return s.events;
  };
  const scanFiles = [{ relPath: 'in/招标 文件.docx', size: 10, mtime: 1000, birthtime: 1000 }];
  const a = ledger(make(), { scanFiles });
  const b = ledger(make(), { scanFiles });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('buildLedger: nodes are sorted by (col, lane order, path)', () => {
  const laneOrder = { deliverable: 0, process: 1, input: 2, temp: 3 };
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\z.txt' });
  s.call('write', { file_path: 'D:\\WS\\a.txt' });
  s.call('write', { file_path: 'D:\\WS\\_tmp_x.py' });
  s.turnStart(2);
  s.call('present', { path: 'D:\\WS\\a.txt' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: 'in/old.docx', size: 1, mtime: 100, birthtime: 100 }],
  });
  for (let i = 1; i < out.nodes.length; i++) {
    const prev = out.nodes[i - 1];
    const cur = out.nodes[i];
    if (prev.col !== cur.col) {
      assert.ok(prev.col < cur.col, 'col ascending');
      continue;
    }
    if (prev.lane !== cur.lane) {
      assert.ok(laneOrder[prev.lane] < laneOrder[cur.lane], 'lane order');
      continue;
    }
    assert.ok(prev.path <= cur.path, 'path ascending');
  }
});

test('buildLedger: every edge endpoint exists in nodes', () => {
  const s = stream().turnStart(1);
  s.call('read', { file_path: 'D:\\WS\\in/spec.docx' });
  s.call('write', { file_path: 'D:\\WS\\out/draft.docx' });
  s.call('bash', { command: 'python make.py > data.json' });
  s.turnStart(2);
  s.call('edit', { file_path: 'D:\\WS\\out/draft.docx' });
  s.call('present', { path: 'D:\\WS\\out/draft.docx' });
  s.turnStart(3);
  s.call('bash', { command: 'python _tmp2.py > chunk.json' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: 'in/spec.docx', size: 10, mtime: 100, birthtime: 100 }],
  });
  const ids = nodeIdSet(out);
  for (const e of out.edges) {
    assert.ok(ids.has(e.from), 'edge.from in nodes: ' + e.from);
    assert.ok(ids.has(e.to), 'edge.to in nodes: ' + e.to);
  }
  const allowed = new Set(['origin', 'evolution', 'derived', 'deliverable']);
  for (const e of out.edges) assert.ok(allowed.has(e.kind), 'edge kind ' + e.kind);
  assert.ok(out.edges.length > 0);
});

test('buildTree: maxNodes truncates deterministically with node-limit warning', () => {
  const s = stream().turnStart(1);
  for (let i = 0; i < 6; i++) s.call('write', { file_path: 'D:\\WS\\f' + i + '.txt' });
  const full = ledger(s.events);
  assert.strictEqual(full.nodes.length, 6);
  const limited = ledger(s.events, { limits: { maxNodes: 3 } });
  assert.strictEqual(limited.nodes.length, 3);
  assert.ok(limited.warnings.indexOf('node-limit') !== -1);
  assert.deepStrictEqual(
    limited.nodes.map((n) => n.id),
    full.nodes.slice(0, 3).map((n) => n.id)
  );
  const ids = nodeIdSet(limited);
  for (const e of limited.edges) assert.ok(ids.has(e.from) && ids.has(e.to));
});

test('buildTree: usable directly with relative fileOps (contract signature)', () => {
  const tree = buildTree({
    fileOps: [
      { path: 'out/a.txt', action: 'write', tool: 'write', turn: 1, seq: 1, time: 1000 },
      { path: 'out/a.txt', action: 'edit', tool: 'edit', turn: 2, seq: 2, time: 2000 },
    ],
    scanFiles: [],
    sessionCreatedAt: CREATED,
    overrides: {},
    limits: { maxNodes: 4000 },
  });
  assert.deepStrictEqual(columnIds(tree), ['input', 't1', 't2', 'final']);
  assert.ok(tree.edges.some((e) => e.kind === 'evolution'));
  assert.deepStrictEqual(Object.keys(tree.counts), ['deliverable', 'process', 'input', 'temp', 'files']);
});

test('buildTree: turn nodes carry that turn only, lane equals final classification', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\deliverables/x.docx' });
  s.call('read', { file_path: 'D:\\WS\\in/spec.docx' });
  s.turnStart(2);
  s.call('present', { path: 'D:\\WS\\deliverables/x.docx' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: 'in/spec.docx', size: 1, mtime: 100, birthtime: 100 }],
  });
  const x1 = nodeById(out, 'deliverables/x.docx#t1');
  assert.deepStrictEqual(x1.turns, [1]);
  assert.strictEqual(x1.lane, 'deliverable');
  assert.strictEqual(x1.actions.length, 1);
  const spec1 = nodeById(out, 'in/spec.docx#t1');
  assert.strictEqual(spec1.lane, 'input');
  assert.deepStrictEqual(spec1.actions.map((a) => a.action), ['read']);
  assert.ok(out.edges.some((e) => e.from === 'in/spec.docx#i' && e.to === 'in/spec.docx#t1'));
});

// ==================================================================== ledger v2

test('workspace: scanned defaults to scanFiles.length and honours scanTotal', () => {
  const scanFiles = [
    { relPath: '_p1.txt', size: 1, mtime: 90000, birthtime: 90000 },
    { relPath: '_p2.txt', size: 1, mtime: 90001, birthtime: 90001 },
  ];
  const plain = ledger([], { scanFiles });
  assert.ok(plain.workspace);
  assert.strictEqual(plain.workspace.scanned, 2);
  assert.strictEqual(plain.workspace.tempPathCount, 2);
  assert.strictEqual(plain.workspace.truncated, false);
  const withTotal = ledger([], { scanFiles, scanTotal: 443 });
  assert.strictEqual(withTotal.workspace.scanned, 443);
  assert.strictEqual(withTotal.workspace.tempPathCount, 2);
});

test('workspace: preexisting temp files never enter the input column', () => {
  const scanFiles = [];
  for (let i = 0; i < 45; i++) {
    scanFiles.push({
      relPath: '_t' + String(i).padStart(2, '0') + '.txt',
      size: 1,
      mtime: 1000 + i,
      birthtime: 1000 + i,
    });
  }
  const out = ledger([], { scanFiles });
  // CONTRACT.md §5: temp leftovers are the workspace backlog, not input nodes.
  assert.strictEqual(out.nodes.filter((n) => n.kind === 'input').length, 0);
  assert.ok(out.workspace, 'backlog must be reported');
  assert.strictEqual(out.workspace.tempPathCount, 45);
  assert.deepStrictEqual(out.workspace.tempPaths, scanFiles.map((f) => f.relPath));
  assert.strictEqual(out.workspace.truncated, false);
  // counts stay file-level: all 45 are temp.
  assert.strictEqual(out.counts.temp, 45);
  assert.strictEqual(out.counts.files, 45);
});

test('input column: lane=input outranks lane=process even with older mtime (40 cap)', () => {
  const scanFiles = [{ relPath: 'in/old.docx', size: 1, mtime: 100, birthtime: 100 }];
  const overrides = { 'in/old.docx': { cls: 'input', note: '原件' } };
  for (let i = 0; i < 40; i++) {
    const rel = 'p/f' + String(i).padStart(2, '0') + '.txt';
    scanFiles.push({ relPath: rel, size: 1, mtime: 2000 + i, birthtime: 2000 });
    overrides[rel] = { cls: 'process' };
  }
  const out = ledger([], { scanFiles, overrides });
  const inputPaths = out.nodes.filter((n) => n.kind === 'input').map((n) => n.path);
  assert.strictEqual(inputPaths.length, 40);
  // The lone input-lane file must survive the cap despite being the oldest.
  assert.ok(inputPaths.indexOf('in/old.docx') !== -1, 'lane=input kept');
  // mtime-desc alone would have kept p/f00 and dropped something newer; the
  // process lane loses its oldest entry instead.
  assert.ok(inputPaths.indexOf('p/f00.txt') === -1, 'oldest process-lane dropped');
  assert.ok(inputPaths.indexOf('p/f39.txt') !== -1, 'newest process-lane kept');
});

test('input column: same lane keeps newest mtime, path codepoint as tie-break', () => {
  const scanFiles = [];
  for (let i = 0; i < 39; i++) {
    scanFiles.push({
      relPath: 'input/f' + String(i).padStart(2, '0') + '.txt',
      size: 1,
      mtime: 3000 + i,
      birthtime: 3000,
    });
  }
  // Two tied files: 'a.txt' wins over 'b.txt' when only one slot remains.
  scanFiles.push({ relPath: 'input/a.txt', size: 1, mtime: 999, birthtime: 999 });
  scanFiles.push({ relPath: 'input/b.txt', size: 1, mtime: 999, birthtime: 999 });
  const out = ledger([], { scanFiles });
  const kept = out.nodes.filter((n) => n.kind === 'input').map((n) => n.path);
  assert.strictEqual(kept.length, 40);
  assert.ok(kept.indexOf('input/f38.txt') !== -1, 'newest kept');
  assert.ok(kept.indexOf('input/a.txt') !== -1, 'mtime tie broken by codepoint order');
  assert.ok(kept.indexOf('input/b.txt') === -1, 'later codepoint dropped');
});

test('input column: temp backlog and input selection are deterministic', () => {
  const scanFiles = [
    { relPath: '_junk.txt', size: 1, mtime: 90000, birthtime: 90000 },
    { relPath: 'in/spec.docx', size: 1, mtime: 100, birthtime: 100 },
    { relPath: 'p/out.txt', size: 1, mtime: 200, birthtime: 200 },
  ];
  const overrides = { 'p/out.txt': { cls: 'process' } };
  const first = ledger([], { scanFiles, overrides });
  const second = ledger([], { scanFiles, overrides });
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
  assert.deepStrictEqual(
    first.nodes.filter((n) => n.kind === 'input').map((n) => n.path).sort(),
    ['in/spec.docx', 'p/out.txt']
  );
  assert.deepStrictEqual(first.workspace.tempPaths, ['_junk.txt']);
});

test('workspace: new temp files with no tool call are backlog (cleanup-only)', () => {
  const out = ledger([], {
    scanFiles: [{ relPath: 'debug.log', size: 4, mtime: 90000, birthtime: 90000 }],
  });
  assert.strictEqual(out.nodes.length, 0);
  assert.strictEqual(out.counts.temp, 1);
  assert.deepStrictEqual(out.workspace.tempPaths, ['debug.log']);
  assert.strictEqual(out.workspace.tempPathCount, 1);
});

test('workspace: touched temp files stay in nodes and are excluded from backlog', () => {
  const s = stream().turnStart(1);
  s.call('write', { file_path: 'D:\\WS\\_tmp_probe.py' });
  const out = ledger(s.events, {
    scanFiles: [{ relPath: '_tmp_probe.py', size: 1, mtime: 100, birthtime: 100 }],
  });
  assert.ok(nodeById(out, '_tmp_probe.py#t1'));
  assert.strictEqual(out.counts.temp, 1);
  assert.strictEqual(out.workspace, undefined);
});

test('workspace: tempPaths truncated at 500 with truncated flag and full count', () => {
  const scanFiles = [];
  for (let i = 0; i < 501; i++) {
    scanFiles.push({
      relPath: '_p' + String(i).padStart(3, '0') + '.tmp',
      size: 1,
      mtime: 90000 + i,
      birthtime: 90000 + i,
    });
  }
  const out = ledger([], { scanFiles });
  assert.ok(out.workspace);
  assert.strictEqual(out.workspace.tempPathCount, 501);
  assert.strictEqual(out.workspace.tempPaths.length, 500);
  assert.strictEqual(out.workspace.truncated, true);
  assert.strictEqual(out.workspace.tempPaths[0], '_p000.tmp');
  assert.strictEqual(out.workspace.tempPaths[499], '_p499.tmp');
});

test('workspace: uses the final classification (override can add/remove backlog)', () => {
  const scanFiles = [
    { relPath: '_a.txt', size: 1, mtime: 100, birthtime: 100 },
    { relPath: 'notes.md', size: 1, mtime: 90000, birthtime: 90000 },
  ];
  const out = ledger([], {
    scanFiles,
    overrides: {
      '_a.txt': { cls: 'input', note: '原件' },
      'notes.md': { cls: 'temp', note: '临时笔记' },
    },
  });
  assert.strictEqual(laneOf(out, '_a.txt', 'input'), 'input');
  assert.strictEqual(out.counts.input, 1);
  assert.strictEqual(out.counts.temp, 1);
  assert.deepStrictEqual(out.workspace.tempPaths, ['notes.md']);
  assert.strictEqual(out.workspace.tempPathCount, 1);
});

test('input column: missing birthtime falls back to mtime for preexisting', () => {
  const out = ledger([], {
    scanFiles: [{ relPath: 'older.md', size: 1, mtime: 1000, birthtime: null }],
  });
  const node = nodeById(out, 'older.md#i');
  assert.ok(node, 'birthtime-less preexisting file still gets an input node');
  assert.strictEqual(node.kind, 'input');
  assert.strictEqual(node.lane, 'input');
  assert.strictEqual(out.counts.input, 1);
  // The scan entry keeps the fallback value; the ledger output is deterministic.
  assert.strictEqual(node.birthtime, 1000);
});

test('workspace: two identical calls produce byte-identical ledgers', () => {
  const scanFiles = [
    { relPath: '_b.txt', size: 1, mtime: 90000, birthtime: 90000 },
    { relPath: '_a.txt', size: 1, mtime: 90001, birthtime: 90001 },
  ];
  const a = ledger([], { scanFiles });
  const b = ledger([], { scanFiles });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.deepStrictEqual(a.workspace.tempPaths, ['_a.txt', '_b.txt']);
});

test('SKIP_DIR_PATTERNS/shouldSkipDir: prefix rules for real workspaces', () => {
  assert.ok(Array.isArray(SKIP_DIR_PATTERNS));
  for (const name of [
    'node_modules',
    'node_modules-v2',
    '.git',
    '.git-2',
    '.venv',
    '.venv-tts',
    'venv',
    '__pycache__',
    '.cache',
    '.pytest_cache',
    '.tox',
    '.next',
    '.mypy_cache',
    '.ruff_cache',
    '.termpilot',
    '.tmp-asar',
    '.dsh-session-files',
    'NODE_MODULES',
  ]) {
    assert.strictEqual(shouldSkipDir(name), true, name + ' must be skipped');
  }
  for (const name of ['build', 'dist', 'reports', 'src', 'lib', 'temp', 'tmp', 'docs', '']) {
    assert.strictEqual(shouldSkipDir(name), false, name + ' must stay scannable');
  }
});

// ==================================================================== summary

console.log('');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) process.exitCode = 1;
