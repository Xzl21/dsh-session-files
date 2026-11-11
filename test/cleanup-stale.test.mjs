/**
 * test/cleanup-stale.test.mjs — stale temp records must not survive their file.
 *
 * Regression for: the panel said "178 temp files" while cleanup moved nothing,
 * because temp ledger records were never forgotten after the file had already been
 * moved to the plugin trash (by another session, or by an earlier cleanup). The fix
 * has three parts, two of which are covered here:
 *   1. host/ledger.mjs  — buildTree({ gonePaths }) prunes final-lane `temp` records;
 *   2. host/store.mjs   — gone/<sessionId>.json remembers what was pruned;
 *   3. index.js         — /delete reports the forgotten paths as `pruned`
 *                         (needs a live host context, covered by integration.real.mjs).
 *
 * Run with:  & "<node.exe>" test/cleanup-stale.test.mjs
 * No test framework, no third-party deps.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'sf-gone-'));
process.env.DSH_HOME = HOME;

const { buildTree } = await import('../host/ledger.mjs');
const { readGone, updateGone, goneRoot } = await import('../host/store.mjs');

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

async function testAsync(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failCount += 1;
    console.log('FAIL ' + name + ' :: ' + (err && err.message ? err.message.split('\n')[0] : String(err)));
  }
}

// ---------------------------------------------------------------- helpers

const OPS = [
  { path: 'verify/dbg.py', action: 'write', tool: 'write', turn: 1, seq: 2, time: 1002 },
  { path: 'notes/a.md', action: 'read', tool: 'read', turn: 2, seq: 3, time: 1003 },
];

function tree(extra) {
  return buildTree({
    fileOps: OPS,
    scanFiles: [],
    scanTotal: 0,
    overrides: {},
    sessionCreatedAt: null,
    ...extra,
  });
}

const laneOf = (built, path) => {
  const node = built.nodes.find((n) => n.path === path);
  return node ? node.lane : null;
};

// ---------------------------------------------------------------- ledger

test('a temp record is kept when nothing says the file is gone', () => {
  const built = tree();
  assert.equal(laneOf(built, 'verify/dbg.py'), 'temp');
  assert.equal(built.counts.temp, 1);
});

test('a gone temp record is forgotten (temp count drops)', () => {
  const built = tree({ gonePaths: ['verify/dbg.py'] });
  assert.equal(laneOf(built, 'verify/dbg.py'), null);
  assert.equal(built.counts.temp, 0);
  assert.equal(laneOf(built, 'notes/a.md'), 'process');
});

test('pruning is case/spelling tolerant like the rest of the ledger', () => {
  const built = tree({ gonePaths: ['VERIFY\\DBG.PY'] });
  assert.equal(laneOf(built, 'verify/dbg.py'), null);
});

test('a file that came back on disk is not hidden by a stale gone record', () => {
  const built = tree({
    gonePaths: ['verify/dbg.py'],
    scanFiles: [{ relPath: 'verify/dbg.py', birthtime: 10, mtime: 20, size: 3 }],
    scanTotal: 1,
  });
  assert.equal(laneOf(built, 'verify/dbg.py'), 'temp');
});

test('a non-temp record is never forgotten', () => {
  const built = tree({ gonePaths: ['notes/a.md'] });
  assert.equal(laneOf(built, 'notes/a.md'), 'process');
});

test('a manual temp override is what decides pruning', () => {
  // Same path, written (so autoCls=process), but the user marked it temp: it is
  // throwaway bookkeeping and may be forgotten once the file is gone.
  const overrides = { 'out/report.docx': { cls: 'temp' } };
  const built = tree({
    fileOps: [...OPS, { path: 'out/report.docx', action: 'write', tool: 'write', turn: 2, seq: 4, time: 1004 }],
    overrides,
    gonePaths: ['out/report.docx'],
  });
  assert.equal(laneOf(built, 'out/report.docx'), null);
});

test('a manual non-temp override keeps its record', () => {
  const overrides = { 'verify/dbg.py': { cls: 'process' } };
  const built = tree({ overrides, gonePaths: ['verify/dbg.py'] });
  assert.equal(laneOf(built, 'verify/dbg.py'), 'process');
});

// ---------------------------------------------------------------- store

await testAsync('updateGone writes under $DSH_HOME/session-files/gone and reads back', async () => {
  await updateGone('session-a', { add: ['verify/dbg.py', 'verify/bookmarks.txt'] });
  const read = await readGone('session-a');
  assert.deepEqual(read, ['verify/dbg.py', 'verify/bookmarks.txt']);
  assert.ok(goneRoot().endsWith(join('session-files', 'gone')));
  assert.deepEqual(readdirSync(goneRoot()), ['session-a.json']);
});

await testAsync('updateGone add/remove de-duplicates and normalises paths', async () => {
  await updateGone('session-b', { add: ['a\\b.py', './a/b.py', '/abs/x.py', ''] });
  assert.deepEqual(await readGone('session-b'), ['a/b.py']);
  await updateGone('session-b', { add: ['c/d.py'] });
  await updateGone('session-b', { remove: ['a/b.py'] });
  assert.deepEqual(await readGone('session-b'), ['c/d.py']);
});

await testAsync('readGone on an unknown session is empty, not an error', async () => {
  assert.deepEqual(await readGone('session-never-seen'), []);
});

await testAsync('the gone list is capped', async () => {
  const many = [];
  for (let i = 0; i < 20010; i += 1) many.push(`d/f${i}.py`);
  await updateGone('session-c', { add: many });
  const read = await readGone('session-c');
  assert.equal(read.length, 20000);
  assert.equal(read[read.length - 1], 'd/f20009.py');
});

// ---------------------------------------------------------------- summary

rmSync(HOME, { recursive: true, force: true });
console.log('');
console.log(`cleanup-stale: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exitCode = 1;

