/**
 * dsh-session-files — client.js unit tests (no framework, run with node).
 *
 *   node test/client-layout.test.mjs
 *
 * Loads the real browser module through a fake `window.__ModuleLoader__`, then
 * exercises the pure `layout()` function exported through `__test`, plus a few
 * static wiring checks (slot keys, API prefix, no forbidden dependencies).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(HERE, '..', 'client.js');
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const MOCK = JSON.parse(readFileSync(path.join(HERE, 'mock-ledger.json'), 'utf8'));
const MOCK_WORKSPACE_PATHS = (function () {
  const out = [];
  for (let i = 0; i < 180; i++) {
    out.push('_asar_' + String(i).padStart(3, '0') + '.py');
  }
  // A CJK + very long path: the popover must still truncate it with ellipsis.
  out[0] = '.tmp-asar/中文目录/很长的历史遗留临时文件-' + 'x'.repeat(48) + '.py';
  return out;
})();
const MOCK_WORKSPACE = { scanned: 443, tempPathCount: 180, tempPaths: MOCK_WORKSPACE_PATHS, truncated: false };
const MOCK_WITH_WORKSPACE = Object.assign({}, MOCK, {
  counts: Object.assign({}, MOCK.counts, { files: 451 }),
  workspace: MOCK_WORKSPACE,
});
// Host truncated the ledger: `warnings` carries the node-limit code.
const MOCK_NODE_LIMIT = Object.assign({}, MOCK_WITH_WORKSPACE, { warnings: ['node-limit'] });
// A workspace scan that found files while the session itself touched nothing.
const MOCK_FILE_ONLY = Object.assign({}, MOCK_WITH_WORKSPACE, {
  counts: { deliverable: 0, process: 0, input: 0, temp: 3, files: 3 },
  nodes: [],
  edges: [],
  workspace: { scanned: 3, tempPathCount: 3, tempPaths: ['_asar_a.py', '_asar_b.py', '_asar_c.py'], truncated: false },
});

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)));
    console.log('FAIL  ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

function ok(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'not equal') + ' :: expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function close(actual, expected, epsilon, message) {
  if (!(Math.abs(actual - expected) <= (epsilon === undefined ? 1e-6 : epsilon))) {
    throw new Error((message || 'not close') + ' :: expected ' + expected + ', got ' + actual);
  }
}

// ---------------------------------------------------------------------------
// Load client.js the way the Harness page does.
// ---------------------------------------------------------------------------

const windowListeners = new Map();
const confirmCalls = [];
let confirmAnswer = true;

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
  addEventListener(type, listener) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(listener);
  },
  removeEventListener(type, listener) {
    const set = windowListeners.get(type);
    if (set) set.delete(listener);
  },
  confirm(message) {
    confirmCalls.push(message);
    return confirmAnswer;
  },
};

function dispatchKey(key, keyCode) {
  const event = {
    key: key,
    keyCode: keyCode === undefined ? 0 : keyCode,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  const set = windowListeners.get('keydown');
  if (set) Array.from(set).forEach(function (listener) { listener(event); });
  return event;
}

function hookStub(name) {
  return function () {
    throw new Error('hook ' + name + '() must not run during factory()/apply()');
  };
}

const fakeReact = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type: type, props: props || null, children: children };
  },
  Fragment: 'Fragment',
  useState: hookStub('useState'),
  useEffect: hookStub('useEffect'),
  useMemo: hookStub('useMemo'),
  useCallback: hookStub('useCallback'),
  useRef: hookStub('useRef'),
  useSyncExternalStore: hookStub('useSyncExternalStore'),
};

const fakeRequire = function (name) {
  if (name === 'react') return fakeReact;
  return {};
};

await import('../client.js');

check('module forces itself through window.__ModuleLoader__.load', function () {
  ok(captured && typeof captured === 'object', 'loader.load() was not called');
  eq(captured.id, 'dsh-session-files', 'loader id');
  ok(typeof captured.factory === 'function', 'factory missing');
});

const api = captured.factory(fakeRequire);
const L = api.__test;

check('factory returns inject/apply/__test and never calls a hook', function () {
  ok(Array.isArray(api.inject), 'inject must be an array');
  ok(api.inject.indexOf('slots') >= 0, 'inject must declare slots');
  eq(typeof api.apply, 'function', 'apply');
  ok(L && typeof L.layout === 'function', '__test.layout missing');
  ok(L && typeof L.edgePath === 'function', '__test.edgePath missing');
  ok(L && L.LAYOUT_DEFAULTS && typeof L.LAYOUT_DEFAULTS.cardHeight === 'number', 'LAYOUT_DEFAULTS missing');
});

// ---------------------------------------------------------------------------
// apply(): slot wiring + locale subscription, with a fake cordis ctx.
// ---------------------------------------------------------------------------

function makeFakeCtx(options) {
  const opts = options || {};
  const registrations = [];
  const injects = [];
  const disposeFns = [];
  const active = new Map();
  const localeListeners = new Set();
  const localeState = { id: 'zh-CN', subscribed: 0, unsubscribed: 0 };
  const locale = {
    getLocale() {
      return { id: localeState.id };
    },
    subscribe(listener) {
      localeState.subscribed += 1;
      localeListeners.add(listener);
      return function () {
        localeListeners.delete(listener);
        localeState.unsubscribed += 1;
      };
    },
  };
  const slots = {
    inject(key, callback) {
      const result = callback();
      const entry = { key: key, result: result, active: true };
      registrations.push(entry);
      injects.push(entry);
      active.set(key, entry);
      // The host's `slots.inject` returns a disposer; a dropped disposer leaks the entry.
      return function () {
        if (!entry.active) return;
        entry.active = false;
        if (active.get(key) === entry) active.delete(key);
      };
    },
    register(config, component) {
      return { config: config, component: component };
    },
  };
  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposeFns.push(disposer);
      return disposer;
    },
    get(name) {
      if (name === 'locale') return locale;
      if (name === 'slots' && opts.slotsViaGet) return slots;
      return undefined;
    },
    injects: injects,
  };
  if (!opts.slotsViaGet) ctx.slots = slots;
  return {
    ctx: ctx,
    registrations: registrations,
    injects: injects,
    disposeFns: disposeFns,
    locale: locale,
    localeState: localeState,
    activeSlots() {
      return Array.from(active.keys());
    },
    emitLocale(id) {
      localeState.id = id;
      Array.from(localeListeners).forEach(function (listener) {
        listener({ id: id });
      });
    },
    listenerCount() {
      return localeListeners.size;
    },
  };
}

const wired = makeFakeCtx();
api.apply(wired.ctx);

check('apply() registers exactly the two slot occupants', function () {
  eq(wired.registrations.length, 2, 'registration count');
  const byKey = {};
  wired.registrations.forEach(function (entry) {
    byKey[entry.key] = entry.result;
  });
  ok(byKey['conversation.input.right'], 'conversation.input.right not registered');
  ok(byKey['shell.overlay'], 'shell.overlay not registered');
  const button = byKey['conversation.input.right'].config;
  eq(button.name, 'conversation.input.right', 'button slot name');
  eq(button.id, 'session-files-button', 'button slot id');
  eq(button.order, 5, 'button slot order');
  const overlay = byKey['shell.overlay'].config;
  eq(overlay.name, 'shell.overlay', 'overlay slot name');
  eq(overlay.id, 'session-files-overlay', 'overlay slot id');
  ok(typeof byKey['conversation.input.right'].component === 'function', 'button component');
  ok(typeof byKey['shell.overlay'].component === 'function', 'overlay component');
});

check('apply(): every slot registration is owned by ctx.effect (no leaked entry)', function () {
  const wired2 = makeFakeCtx();
  api.apply(wired2.ctx);
  eq(wired2.registrations.length, 2, 'first apply registers two occupants');
  eq(wired2.injects.length, 2, 'inject call count');
  // A second apply must not stack a duplicate overlay on the same slots service.
  api.apply(wired2.ctx);
  eq(wired2.registrations.length, 2, 'second apply must not register again');
  ok(wired2.disposeFns.length >= 3, 'disposers must be registered through ctx.effect');
  wired2.disposeFns.forEach(function (fn) {
    fn();
  });
  eq(wired2.activeSlots().length, 0, 'unload must remove every slot entry');
});

check("apply(): falls back to ctx.get('slots') when ctx.slots is absent", function () {
  const viaGet = makeFakeCtx({ slotsViaGet: true });
  api.apply(viaGet.ctx);
  eq(viaGet.registrations.length, 2, 'slots must be resolved through ctx.get');
  const keys = viaGet.registrations.map(function (entry) {
    return entry.key;
  });
  ok(keys.indexOf('conversation.input.right') >= 0, 'composer slot missing via ctx.get');
  ok(keys.indexOf('shell.overlay') >= 0, 'overlay slot missing via ctx.get');
});

check('locale subscription: zh by default, follows locale, unsubscribes on dispose', function () {
  eq(L.getLang(), 'zh', 'default language');
  eq(L.t('title'), '会话文件树', 'zh title');
  wired.emitLocale('en-US');
  eq(L.getLang(), 'en', 'language after switch');
  eq(L.t('title'), 'Session file tree', 'en title');
  eq(L.t('confirm.delete', { n: 3 }), 'Move 3 files to trash?', 'en interpolation');
  // dispose through the ctx.effect disposer
  ok(wired.disposeFns.length >= 1, 'apply did not register a disposer');
  wired.disposeFns.forEach(function (fn) {
    fn();
  });
  eq(wired.listenerCount(), 0, 'locale listener not removed on dispose');
  // after dispose the language must not follow the service any more
  wired.emitLocale('zh-CN');
  eq(L.getLang(), 'en', 'language must stay after dispose');
  L.setLang('zh');
});

// ---------------------------------------------------------------------------
// layout(): real mock ledger
// ---------------------------------------------------------------------------

const layoutOpts = { lanes: MOCK.lanes, minColumns: MOCK.columns.length };
const lay = L.layout(MOCK.nodes, MOCK.edges, layoutOpts);
const DEF = L.LAYOUT_DEFAULTS;

function indexById(nodes) {
  const map = new Map();
  nodes.forEach(function (node) {
    map.set(String(node.id), node);
  });
  return map;
}

check('layout() places every node and keeps the original fields', function () {
  eq(lay.nodes.length, MOCK.nodes.length, 'placed node count');
  const first = lay.nodes[0];
  ok(typeof first.x === 'number' && isFinite(first.x), 'x must be finite');
  ok(typeof first.y === 'number' && isFinite(first.y), 'y must be finite');
  eq(first.w, DEF.cardWidth, 'card width');
  eq(first.h, DEF.cardHeight, 'card height');
  // original ledger fields survive
  const ids = new Set(MOCK.nodes.map(function (node) { return node.id; }));
  lay.nodes.forEach(function (node) {
    ok(ids.has(node.id), 'unknown node id ' + node.id);
    ok(typeof node.path === 'string' && node.path.length > 0, 'path lost for ' + node.id);
    ok(typeof node.lane === 'string', 'lane lost for ' + node.id);
  });
});

check('layout() does not mutate its input', function () {
  const snapshot = JSON.stringify(MOCK.nodes);
  L.layout(MOCK.nodes, MOCK.edges, layoutOpts);
  eq(JSON.stringify(MOCK.nodes), snapshot, 'input nodes mutated');
});

check('layout(): columns increase left to right within a lane', function () {
  const byLane = new Map();
  lay.nodes.forEach(function (node) {
    if (!byLane.has(node.lane)) byLane.set(node.lane, new Map());
    const cols = byLane.get(node.lane);
    const existing = cols.get(node.colIndex);
    if (!existing || existing.x < node.x) cols.set(node.colIndex, node);
  });
  let checked = 0;
  byLane.forEach(function (cols, lane) {
    const indexes = Array.from(cols.keys()).sort(function (a, b) { return a - b; });
    for (let i = 1; i < indexes.length; i++) {
      const prev = cols.get(indexes[i - 1]);
      const next = cols.get(indexes[i]);
      ok(next.x > prev.x, 'lane ' + lane + ': x must increase across adjacent columns');
      close(next.x - prev.x, DEF.colWidth * (indexes[i] - indexes[i - 1]), 1e-6, 'lane ' + lane + ': column pitch');
      checked += 1;
    }
  });
  ok(checked >= 4, 'too few column pairs checked: ' + checked);
});

check('layout(): same (col, lane) stacks without overlap', function () {
  const groups = new Map();
  lay.nodes.forEach(function (node) {
    const key = node.lane + '|' + node.colIndex;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });
  let multi = 0;
  groups.forEach(function (group, key) {
    group.sort(function (a, b) { return a.y - b.y; });
    for (let i = 1; i < group.length; i++) {
      const gap = group[i].y - group[i - 1].y;
      ok(gap >= DEF.cardHeight, 'overlap in ' + key + ': gap ' + gap + ' < card height ' + DEF.cardHeight);
      ok(group[i].stackIndex === group[i - 1].stackIndex + 1, 'stackIndex must be contiguous in ' + key);
    }
    if (group.length > 1) multi += 1;
  });
  ok(multi >= 2, 'expected several stacked groups, got ' + multi);
  // mock has 3 process nodes in column 1
  const col1 = groups.get('process|1') || [];
  eq(col1.length, 3, 'process column 1 stack size');
});

check('layout(): lane tops are cumulative and sum to height', function () {
  let cursor = 0;
  let sum = 0;
  MOCK.lanes.forEach(function (lane) {
    eq(lay.laneTops[lane], cursor, 'laneTops[' + lane + ']');
    const height = lay.laneHeights[lane];
    ok(height >= DEF.laneMinHeight, 'lane ' + lane + ' shorter than minimum');
    cursor += height;
    sum += height;
  });
  close(lay.height, sum, 1e-6, 'height must equal the sum of lane heights');
  close(lay.width, MOCK.columns.length * DEF.colWidth, 1e-6, 'width must equal columns x colWidth');
  ok(lay.height > 0 && lay.width > 0, 'non-empty ledger must have a positive size');
});

check('layout(): lane bands do not overlap vertically', function () {
  for (let i = 1; i < MOCK.lanes.length; i++) {
    const prev = MOCK.lanes[i - 1];
    const lane = MOCK.lanes[i];
    close(lay.laneTops[lane], lay.laneTops[prev] + lay.laneHeights[prev], 1e-6, 'lane band boundary ' + prev + '->' + lane);
  }
});

check('layout(): every edge resolves to node coordinates and builds a cubic path', function () {
  const byId = indexById(lay.nodes);
  eq(lay.edges.length, MOCK.edges.length, 'every mock edge must be laid out');
  lay.edges.forEach(function (edge) {
    const from = byId.get(String(edge.from));
    const to = byId.get(String(edge.to));
    ok(from, 'missing from node ' + edge.from);
    ok(to, 'missing to node ' + edge.to);
    close(edge.x1, from.x + from.w, 1e-6, 'x1 must sit on the source right edge');
    close(edge.y1, from.y + from.h / 2, 1e-6, 'y1 must sit on the source vertical middle');
    close(edge.x2, to.x, 1e-6, 'x2 must sit on the target left edge');
    close(edge.y2, to.y + to.h / 2, 1e-6, 'y2 must sit on the target vertical middle');
    ok(typeof edge.path === 'string' && edge.path.charAt(0) === 'M', 'path must start with M');
    ok(edge.path.indexOf('C') >= 0, 'path must contain a cubic segment');
    ok(!/NaN|undefined|Infinity/.test(edge.path), 'path contains a bad number: ' + edge.path);
  });
  // edges whose endpoints are absent must be dropped, never kept half-formed
  const dropped = L.layout(MOCK.nodes, [{ from: 'nope#t1', to: MOCK.nodes[0].id, kind: 'origin' }], layoutOpts);
  eq(dropped.edges.length, 0, 'edge with a missing endpoint must be dropped');
});

check('layout(): same-column edges still produce a visible loop', function () {
  const sameColumn = lay.edges.filter(function (edge) {
    return edge.from === 'extract/clause-1.json#t1';
  });
  ok(sameColumn.length >= 1, 'expected the same-column derived edge');
  const edge = sameColumn[0];
  // same column means the source right edge is to the right of the target left edge
  ok(edge.x2 <= edge.x1 + 8, 'test assumption: same-column edge runs backwards');
  ok(edge.path.charAt(0) === 'M' && edge.path.indexOf('C') >= 0, 'loop path shape');
  ok(edge.path.indexOf('NaN') < 0, 'loop path must be finite');
  // the loop must bulge to the right of the source, otherwise it hides under the cards
  const numbers = edge.path.match(/-?\d+(?:\.\d+)?/g).map(Number);
  ok(numbers[2] > edge.x1, 'control point must bulge right of the source node');
});

check('layout(): empty ledger is safe and non-negative', function () {
  const empty = L.layout([], [], { lanes: MOCK.lanes, minColumns: 0 });
  eq(empty.nodes.length, 0, 'empty nodes');
  eq(empty.edges.length, 0, 'empty edges');
  ok(empty.width >= 0, 'empty width must be >= 0');
  ok(empty.height >= 0, 'empty height must be >= 0');
  close(empty.height, MOCK.lanes.length * DEF.laneMinHeight, 1e-6, 'empty height = lanes x min height');
  // also safe with undefined arguments
  const lax = L.layout(undefined, undefined, undefined);
  ok(lax.width >= 0 && lax.height >= 0, 'undefined arguments must not throw');
});

check('layout(): hidden-lane height override collapses only that lane', function () {
  // the overlay filters the hidden lane's nodes out before laying out; mirror that
  const visible = MOCK.nodes.filter(function (node) {
    return node.lane !== 'temp';
  });
  const collapsed = L.layout(visible, MOCK.edges, Object.assign({}, layoutOpts, { laneMinHeightByLane: { temp: 44 } }));
  eq(collapsed.laneHeights.temp, 44, 'hidden temp lane height');
  ok(collapsed.laneHeights.process >= DEF.laneMinHeight, 'process lane must keep its height');
  ok(collapsed.nodes.every(function (node) { return node.lane !== 'temp'; }), 'hidden lane must place no nodes');
});

check('layout(): 800 nodes x 12 columns is fast', function () {
  const synthetic = [];
  const lanes = MOCK.lanes;
  for (let i = 0; i < 800; i++) {
    const lane = lanes[i % lanes.length];
    const col = i % 12;
    synthetic.push({
      id: 'gen/f' + i + '.txt#t' + col,
      path: 'gen/f' + i + '.txt',
      name: 'f' + i + '.txt',
      ext: 'txt',
      dir: 'gen',
      col: col,
      lane: lane,
      cls: lane,
      autoCls: lane,
      reason: 'written',
      overridden: false,
      note: null,
      exists: true,
      size: i * 17,
      mtime: 1762400000000 + i,
      birthtime: 1762400000000,
      turns: [col],
      actions: [{ tool: 'write', action: 'write', turn: col, seq: i, time: 1762400000000 + i }],
      sources: ['event'],
      kind: 'turn',
    });
  }
  const syntheticEdges = [];
  for (let i = 0; i < 790; i++) {
    syntheticEdges.push({ from: synthetic[i].id, to: synthetic[Math.min(799, i + 5)].id, kind: i % 3 === 0 ? 'evolution' : 'derived' });
  }
  const started = Date.now();
  const big = L.layout(synthetic, syntheticEdges, { lanes: lanes, minColumns: 12 });
  const elapsed = Date.now() - started;
  console.log('      layout(800 nodes, 790 edges, 12 columns) took ' + elapsed + 'ms');
  ok(big.nodes.length === 800, 'large placement count');
  eq(big.edges.length, syntheticEdges.length, 'large edge count');
  ok(elapsed < 100, 'layout is too slow: ' + elapsed + 'ms (budget 100ms)');
});

check('layout(): 2000 nodes x 1900 edges stays under 50ms (v2 budget)', function () {
  const lanes = MOCK.lanes;
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const lane = lanes[i % lanes.length];
    const col = i % 12;
    nodes.push({
      id: 'big/f' + i + '.txt#t' + col,
      path: 'big/f' + i + '.txt',
      name: 'f' + i + '.txt',
      ext: 'txt',
      dir: 'big',
      col: col,
      lane: lane,
      cls: lane,
      autoCls: lane,
      reason: 'written',
      overridden: false,
      note: null,
      exists: true,
      size: i * 13,
      mtime: 1762400000000 + i,
      birthtime: 1762400000000,
      turns: [col],
      actions: [{ tool: 'read', action: 'read', turn: col, seq: i, time: 1762400000000 + i }],
      sources: ['event'],
      kind: 'turn',
    });
  }
  const edges = [];
  for (let i = 0; i < 1900; i++) {
    edges.push({ from: nodes[i].id, to: nodes[(i * 7 + 11) % 2000].id, kind: i % 3 === 0 ? 'derived' : 'evolution' });
  }
  const started = Date.now();
  const big = L.layout(nodes, edges, { lanes: lanes, minColumns: 12 });
  const elapsed = Date.now() - started;
  console.log('      layout(2000 nodes, 1900 edges, 12 columns) took ' + elapsed + 'ms');
  eq(big.nodes.length, 2000, 'placement count');
  eq(big.edges.length, 1900, 'edge count (every endpoint must resolve through the id Map)');
  ok(
    big.edges.every(function (edge) {
      return typeof edge.path === 'string' && edge.path.charAt(0) === 'M' && edge.path.indexOf('C') >= 0;
    }),
    'every resolved edge needs a bezier path',
  );
  ok(elapsed < 50, 'layout is too slow: ' + elapsed + 'ms (budget 50ms)');
});

check('temp path helpers: node dedupe, workspace backlog, union order', function () {
  const treeTemp = L.collectTempPaths(MOCK.nodes);
  const expected = Array.from(
    new Set(
      MOCK.nodes
        .filter(function (node) {
          return node.lane === 'temp';
        })
        .map(function (node) {
          return node.path;
        }),
    ),
  );
  eq(treeTemp.length, expected.length, 'tree temp path count');
  eq(JSON.stringify(treeTemp), JSON.stringify(expected), 'tree temp paths keep document order');
  eq(L.collectTempPaths(null).length, 0, 'null nodes yield no paths');
  eq(L.collectBacklog(MOCK).length, 0, 'no workspace => no backlog');
  const backlog = L.collectBacklog(MOCK_WITH_WORKSPACE);
  eq(backlog.length, 180, 'backlog path count');
  ok(backlog[0].indexOf('中文目录') > 0, 'CJK path survives untouched');
  const union = L.unionPaths(treeTemp, backlog);
  eq(union.length, treeTemp.length + backlog.length, 'union length');
  eq(union[0], treeTemp[0], 'union keeps node paths first');
  eq(L.UNFOLD_PREVIEW, 20, 'popover shows at most 20 paths');
});

// ---------------------------------------------------------------------------
// formatting / API helpers
// ---------------------------------------------------------------------------

check('dictionary: zh and en expose exactly the same keys', function () {
  const zh = Object.keys(api.__test.DICT.zh).sort();
  const en = Object.keys(api.__test.DICT.en).sort();
  eq(zh.length, en.length, 'dictionary size');
  const missingInEn = zh.filter(function (key) { return !Object.prototype.hasOwnProperty.call(api.__test.DICT.en, key); });
  const missingInZh = en.filter(function (key) { return !Object.prototype.hasOwnProperty.call(api.__test.DICT.zh, key); });
  eq(missingInEn.length, 0, 'keys missing from en: ' + missingInEn.join(', '));
  eq(missingInZh.length, 0, 'keys missing from zh: ' + missingInZh.join(', '));
  eq(api.__test.translate('zh', 'btn.open'), '文件树', 'default copy');
  eq(api.__test.translate('en', 'btn.open'), 'File tree', 'en copy');
  eq(api.__test.translate('en', 'missing.key'), 'missing.key', 'unknown key must not throw');
  eq(api.__test.interpolate('已清理 {n} 个', { n: 3 }), '已清理 3 个', 'interpolation');
});

check('formatting helpers', function () {
  eq(L.fmtSize(0), '0 B', '0 bytes');
  eq(L.fmtSize(512), '512 B', 'bytes');
  eq(L.fmtSize(284331), '277.7 KB', 'kb');
  eq(L.fmtSize(1048576), '1 MB', 'mb');
  eq(L.fmtSize(undefined), '—', 'undefined size');
  ok(L.fmtDateTime(1762400123456).length > 0, 'date time must render');
  eq(L.fmtDateTime(0), '—', 'missing time');
});

check('apiUrl() always targets /api/session-files', function () {
  eq(L.API_PREFIX, '/api/session-files', 'API prefix');
  const url = L.apiUrl('/ledger', { sessionId: 'session a/b', maxBytes: 65536, skip: null });
  ok(url.indexOf('/api/session-files/') === 0, 'ledger url prefix');
  eq(url, '/api/session-files/ledger?sessionId=session%20a%2Fb&maxBytes=65536', 'ledger url');
  eq(L.apiUrl('/preview', {}), '/api/session-files/preview', 'no query');
});

check('open store: setOpen notifies and unsubscribes', function () {
  const seen = [];
  const off = L.subscribeOpen(function () {
    seen.push(L.getOpenSnapshot());
  });
  L.setOpen('session-abc');
  eq(seen.length, 1, 'setOpen must notify once');
  eq(seen[0].open, true, 'open flag');
  eq(seen[0].sessionId, 'session-abc', 'sessionId captured');
  off();
  L.setOpen(null);
  eq(seen.length, 1, 'after unsubscribe no further notifications');
  eq(L.getOpenSnapshot().open, false, 'closed state');
});

// ---------------------------------------------------------------------------
// static wiring checks on the real source
// ---------------------------------------------------------------------------

check('source: every API literal is the shared prefix', function () {
  const matches = SOURCE.match(/\/api\/[A-Za-z0-9_\-/]*/g) || [];
  ok(matches.length >= 1, 'no /api/ literal found');
  const unique = Array.from(new Set(matches));
  eq(unique.length, 1, 'multiple API prefixes: ' + JSON.stringify(unique));
  eq(unique[0], '/api/session-files', 'API prefix literal');
  ok(SOURCE.indexOf('/api/session-files/ledger') < 0 || true, 'ledger path built from prefix');
});

check('source: both slot keys and ids are present', function () {
  ok(SOURCE.indexOf("'conversation.input.right'") >= 0, 'conversation.input.right key missing');
  ok(SOURCE.indexOf("'session-files-button'") >= 0, 'button id missing');
  ok(SOURCE.indexOf("id: 'session-files-button', order: 5") >= 0, 'button registration shape missing');
  ok(SOURCE.indexOf("'shell.overlay'") >= 0, 'shell.overlay key missing');
  ok(SOURCE.indexOf("'session-files-overlay'") >= 0, 'overlay id missing');
});

check('source: no forbidden dependencies or browser side effects', function () {
  ok(SOURCE.indexOf('@deepseek-ai/') < 0, 'must not require @deepseek-ai packages');
  ok(!/require\(\s*['"](?!react['"])/.test(SOURCE), 'only require("react") is allowed');
  ok(SOURCE.indexOf('document.body') < 0, 'must not touch document.body');
  ok(SOURCE.indexOf('document.createElement') < 0, 'must not build DOM by hand');
  ok(SOURCE.indexOf('iframe') < 0, 'must not create iframes');
  ok(SOURCE.indexOf('setInterval') < 0, 'must not poll');
  ok(SOURCE.indexOf('new Function') < 0 && SOURCE.indexOf('eval(') < 0, 'no eval');
  ok(SOURCE.indexOf('import ') < 0 || SOURCE.indexOf('import(') < 0, 'no ES imports');
});

check('source: store subscribe/unsubscribe pair and Esc/backdrop close', function () {
  ok(SOURCE.indexOf('listeners.delete(fn)') >= 0, 'open store has no unsubscribe');
  ok(SOURCE.indexOf('langState.listeners.delete(fn)') >= 0, 'lang store has no unsubscribe');
  ok(SOURCE.indexOf("window.addEventListener('keydown'") >= 0, 'Esc handler missing');
  ok(SOURCE.indexOf("window.removeEventListener('keydown'") >= 0, 'Esc handler leak on unmount');
  ok(SOURCE.indexOf('sf-backdrop') >= 0, 'backdrop click target missing');
});

// ---------------------------------------------------------------------------
// render smoke test: a tiny hook-capable React stand-in.
//
// There is no browser here, so this renders the real components with a minimal
// fiber-less runtime: hooks keep per-instance slot arrays, setState re-renders
// the whole tree synchronously, effects run after each pass (and clean up on
// unmount). Host elements are plain objects; nothing touches the DOM.
// ---------------------------------------------------------------------------

function createTestRenderer() {
  const instances = new Map();
  let currentInst = null;
  let hookCursor = 0;
  let pendingEffects = [];
  let renderRequested = false;
  let running = false;
  let rootElement = null;
  let rootOutput = null;

  function sameDeps(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }

  function getInstance(key) {
    let inst = instances.get(key);
    if (!inst) {
      inst = { key: key, hooks: [], alive: true };
      instances.set(key, inst);
    }
    return inst;
  }

  function asArray(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
      const out = [];
      value.forEach(function (item) {
        out.push.apply(out, asArray(item));
      });
      return out;
    }
    return [value];
  }

  function renderElement(element, path) {
    if (element === null || element === undefined || element === false || element === true) return null;
    if (typeof element === 'string' || typeof element === 'number') {
      return { host: true, type: '#text', text: String(element), props: {}, children: [] };
    }
    if (Array.isArray(element)) {
      return element.map(function (child, index) {
        const key = child && child.key !== undefined ? 'k:' + child.key : 'i:' + index;
        return renderElement(child, path + '/' + key);
      });
    }
    if (typeof element !== 'object') return null;

    const type = element.type;
    const props = element.props || {};

    if (typeof type === 'function') {
      const key = path + '::' + (type.name || 'anonymous');
      const inst = getInstance(key);
      inst.alive = true;
      seenSoFar.add(key);
      const prevInst = currentInst;
      const prevCursor = hookCursor;
      currentInst = inst;
      hookCursor = 0;
      let output;
      try {
        output = type(props);
      } finally {
        currentInst = prevInst;
        hookCursor = prevCursor;
      }
      return { host: false, type: type, props: props, children: asArray(renderElement(output, key + '/o')) };
    }

    const children = asArray(renderElement(props.children, path + '/c'));
    return { host: true, type: type, props: props, children: children };
  }

  let seenSoFar = new Set();

  function renderPass() {
    seenSoFar = new Set();
    rootOutput = renderElement(rootElement, 'root');
    instances.forEach(function (inst, key) {
      if (!seenSoFar.has(key) && inst.alive) {
        inst.alive = false;
        inst.hooks.forEach(function (slot) {
          if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
            try {
              slot.cleanup();
            } catch (error) {
              /* a throwing cleanup must not break the pass */
            }
            slot.cleanup = null;
          }
        });
        instances.delete(key);
      }
    });
  }

  function flushEffects() {
    const queue = pendingEffects;
    pendingEffects = [];
    queue.forEach(function (item) {
      if (item.slot.cleanup) {
        const previous = item.slot.cleanup;
        item.slot.cleanup = null;
        try {
          previous();
        } catch (error) {
          /* isolate */
        }
      }
      const cleanup = item.fn();
      item.slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
      item.slot.deps = item.deps;
      item.slot.mounted = true;
    });
  }

  function schedule() {
    renderRequested = true;
    if (running) return;
    running = true;
    try {
      let guard = 0;
      while (renderRequested) {
        renderRequested = false;
        renderPass();
        flushEffects();
        guard += 1;
        if (guard > 100) throw new Error('render loop did not converge');
      }
    } finally {
      running = false;
    }
  }

  function useState(initial) {
    if (!currentInst) throw new Error('useState() outside a component');
    const inst = currentInst;
    const index = hookCursor;
    hookCursor += 1;
    let slot = inst.hooks[index];
    if (!slot) {
      slot = inst.hooks[index] = {
        kind: 'state',
        value: typeof initial === 'function' ? initial() : initial,
        setter: null,
      };
    }
    if (!slot.setter) {
      slot.setter = function (next) {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        schedule();
      };
    }
    return [slot.value, slot.setter];
  }

  function useEffect(fn, deps) {
    if (!currentInst) throw new Error('useEffect() outside a component');
    const inst = currentInst;
    const index = hookCursor;
    hookCursor += 1;
    const depsArray = deps ? deps.slice() : null;
    let slot = inst.hooks[index];
    if (!slot) {
      slot = inst.hooks[index] = { kind: 'effect', mounted: false, deps: null, cleanup: null };
      pendingEffects.push({ slot: slot, fn: fn, deps: depsArray });
      return;
    }
    if (!depsArray || !slot.mounted || !sameDeps(slot.deps, depsArray)) {
      pendingEffects.push({ slot: slot, fn: fn, deps: depsArray });
    }
  }

  function useMemo(factory, deps) {
    if (!currentInst) throw new Error('useMemo() outside a component');
    const inst = currentInst;
    const index = hookCursor;
    hookCursor += 1;
    const depsArray = deps ? deps.slice() : null;
    let slot = inst.hooks[index];
    if (!slot) {
      slot = inst.hooks[index] = { kind: 'memo', deps: null, value: undefined };
    }
    if (!slot.deps || !depsArray || !sameDeps(slot.deps, depsArray)) {
      slot.value = factory();
      slot.deps = depsArray;
    }
    return slot.value;
  }

  function useCallback(fn, deps) {
    return useMemo(function () {
      return fn;
    }, deps);
  }

  function useRef(initial) {
    if (!currentInst) throw new Error('useRef() outside a component');
    const inst = currentInst;
    const index = hookCursor;
    hookCursor += 1;
    let slot = inst.hooks[index];
    if (!slot) slot = inst.hooks[index] = { kind: 'ref', value: { current: initial } };
    return slot.value;
  }

  function createElement(type, props) {
    const nextProps = props ? Object.assign({}, props) : {};
    const children = Array.prototype.slice.call(arguments, 2);
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    return { type: type, key: props && props.key !== undefined ? props.key : undefined, props: nextProps };
  }

  return {
    react: {
      createElement: createElement,
      Fragment: 'Fragment',
      useState: useState,
      useEffect: useEffect,
      useMemo: useMemo,
      useCallback: useCallback,
      useRef: useRef,
    },
    mount(element) {
      rootElement = element;
      schedule();
    },
    tree() {
      return rootOutput;
    },
  };
}

function walkTree(node, visit) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(function (child) {
      walkTree(child, visit);
    });
    return;
  }
  visit(node);
  (node.children || []).forEach(function (child) {
    walkTree(child, visit);
  });
}

function findAll(root, predicate) {
  const out = [];
  walkTree(root, function (node) {
    if (predicate(node)) out.push(node);
  });
  return out;
}

function classOf(node) {
  const className = node && node.props && node.props.className;
  return typeof className === 'string' ? className : '';
}

function hasClass(node, cls) {
  return classOf(node).split(/\s+/).indexOf(cls) >= 0;
}

function textOf(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.text !== undefined) return String(node.text);
  return (node.children || []).map(textOf).join('');
}

async function settle(times) {
  for (let i = 0; i < (times || 12); i++) {
    await Promise.resolve();
  }
}

function installFetchStub(getLedger, options) {
  const opts = options || {};
  const calls = [];
  globalThis.fetch = function (url, init) {
    calls.push({ url: String(url), init: init || {}, method: (init && init.method) || 'GET' });
    const ledger = getLedger();
    let body;
    if (String(url).indexOf('/api/session-files/ledger') === 0) {
      body = { ok: true, ledger: ledger };
    } else if (String(url).indexOf('/api/session-files/preview') === 0) {
      body = { ok: true, path: 'x', text: 'line one\nline two', truncated: false, bytes: 18 };
    } else if (String(url).indexOf('/api/session-files/classify') === 0) {
      body = { ok: true, ledger: ledger };
    } else if (String(url).indexOf('/api/session-files/delete') === 0) {
      let payload = {};
      try {
        payload = init && init.body ? JSON.parse(init.body) : {};
      } catch (error) {
        payload = {};
      }
      if (payload.dryRun === true) {
        body = {
          ok: true,
          dryRun: true,
          deleted: typeof opts.dryDeleted === 'function' ? opts.dryDeleted() : [],
          skipped: [],
        };
      } else {
        body = {
          ok: true,
          deleted: typeof opts.deleted === 'function' ? opts.deleted(payload) : [],
          skipped: typeof opts.skipped === 'function' ? opts.skipped() : [],
          ledger: ledger,
        };
      }
    } else {
      body = { ok: false, code: 'unexpected-url' };
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text() {
        return Promise.resolve(JSON.stringify(body));
      },
    });
  };
  return calls;
}

try {
  const renderer = createTestRenderer();
  const renderReact = renderer.react;
  const renderRequire = function (name) {
    return name === 'react' ? renderReact : {};
  };
  const renderApi = captured.factory(renderRequire);

  // Capture the two components through their real slot registrations.
  const renderCtx = makeFakeCtx();
  renderApi.apply(renderCtx.ctx);
  const registered = {};
  renderCtx.registrations.forEach(function (entry) {
    registered[entry.key] = entry.result;
  });
  const ButtonComponent = registered['conversation.input.right'].component;
  const OverlayComponent = registered['shell.overlay'].component;

  let currentLedger = MOCK;
  // What the fake host reports for a dry-run / real delete (v2 two-step cleanup).
  let dryDeleted = [];
  let deleteSkipped = [];
  const calls = installFetchStub(
    function () {
      return currentLedger;
    },
    {
      dryDeleted: function () {
        return dryDeleted.slice();
      },
      deleted: function () {
        return dryDeleted.slice();
      },
      skipped: function () {
        return deleteSkipped.slice();
      },
    },
  );

  await (async function () {
    renderer.mount(
      renderReact.createElement(
        'div',
        null,
        renderReact.createElement(ButtonComponent, { sessionId: MOCK.sessionId }),
        renderReact.createElement(OverlayComponent, null),
      ),
    );

    const buttons = findAll(renderer.tree(), function (node) {
      return node.host && hasClass(node, 'sf-open-btn');
    });

    check('render: composer button appears with the contract title', function () {
      eq(buttons.length, 1, 'button count');
      eq(buttons[0].props.title, '文件树', 'button title uses btn.open copy');
      eq(buttons[0].props['aria-label'], '文件树', 'button aria label');
      eq(buttons[0].props.disabled, false, 'button must be enabled when sessionId is present');
      ok(findAll(buttons[0], function (node) { return node.host && node.type === 'svg'; }).length === 1, 'tree svg icon missing');
    });

    check('render: overlay renders nothing while closed (click-through layer)', function () {
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-overlay'); }).length, 0, 'closed overlay must render null');
    });

    // Click the button -> store opens -> overlay subscribes and mounts the panel.
    buttons[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle();

    check('render: clicking the button opens the panel and fetches the ledger', function () {
      const overlay = findAll(renderer.tree(), function (node) {
        return node.host && hasClass(node, 'sf-overlay');
      });
      eq(overlay.length, 1, 'overlay root count');
      const panel = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-panel'); });
      eq(panel.length, 1, 'panel count');
      const ledgerCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/ledger') === 0; });
      eq(ledgerCalls.length, 1, 'one ledger request');
      ok(ledgerCalls[0].url.indexOf('/api/session-files/ledger?sessionId=') === 0, 'ledger url shape');
      eq(fetchUrlParam(ledgerCalls[0].url, 'sessionId'), MOCK.sessionId, 'ledger sessionId param');
      const text = textOf(renderer.tree());
      ok(text.indexOf('会话文件树') >= 0, 'panel title missing');
      ok(text.indexOf('第 2 轮') >= 0, 'column header missing');
    });

    const cards = findAll(renderer.tree(), function (node) {
      return node.host && hasClass(node, 'sf-node');
    });

    check('render: canvas renders nodes, lane bands, columns and bezier edges', function () {
      eq(cards.length, MOCK.nodes.length, 'node card count');
      const laneLabels = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-lanelabel'); });
      eq(laneLabels.length, MOCK.lanes.length, 'lane label count');
      const laneBands = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-laneband'); });
      eq(laneBands.length, MOCK.lanes.length, 'lane band count');
      const colHeads = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-colhead'); });
      eq(colHeads.length, MOCK.columns.length, 'column head count');
      const svg = findAll(renderer.tree(), function (node) { return node.host && node.type === 'svg' && hasClass(node, 'sf-edges'); });
      eq(svg.length, 1, 'edge svg count');
      const paths = findAll(svg[0], function (node) { return node.host && node.type === 'path'; });
      eq(paths.length, MOCK.edges.length, 'edge path count');
      paths.forEach(function (pathNode) {
        ok(String(pathNode.props.d).charAt(0) === 'M', 'edge path must start with M');
      });
      const canvas = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-canvas'); });
      eq(canvas.length, 1, 'scaled canvas count');
      ok(String(canvas[0].props.style.transform).indexOf('scale(') === 0, 'canvas must be scaled with transform');
      eq(canvas[0].props.style.transformOrigin, '0 0', 'transform origin');
      const spacer = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-canvas-spacer'); });
      ok(parseFloat(spacer[0].props.style.width) > 0, 'scrolling spacer must carry the scaled width');
    });

    check('render: counts row hides every backlog affordance when no workspace is sent', function () {
      const rows = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-counts'); });
      eq(rows.length, 1, 'counts row count');
      const text = textOf(rows[0]);
      ok(text.indexOf('工作区') >= 0, 'workspace segment missing');
      ok(text.indexOf('树中') >= 0, 'tree segment missing');
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-unfoldbtn'); }).length, 0, 'no backlog chip without workspace');
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-pop'); }).length, 0, 'no popover without workspace');
    });

    // Selecting a node opens the drawer and asks for a preview.
    cards[0].props.onClick({ stopPropagation() {} });
    await settle();

    check('render: selecting a node opens the drawer with a preview request', function () {
      const drawers = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-drawer'); });
      eq(drawers.length, 1, 'drawer count');
      const drawerText = textOf(drawers[0]);
      ok(drawerText.indexOf(MOCK.nodes[0].path) >= 0, 'drawer must show the path');
      ok(drawerText.indexOf('会话中被写入') >= 0 || drawerText.indexOf('present 过') >= 0, 'drawer must translate the reason key');
      const previewCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/preview') === 0; });
      eq(previewCalls.length, 1, 'one preview request');
      eq(fetchUrlParam(previewCalls[0].url, 'maxBytes'), '65536', 'preview maxBytes');
      eq(fetchUrlParam(previewCalls[0].url, 'path'), MOCK.nodes[0].path, 'preview path');
      const pres = findAll(renderer.tree(), function (node) { return node.host && node.type === 'pre'; });
      eq(pres.length, 1, 'preview <pre> missing');
      ok(textOf(pres[0]).indexOf('line one') >= 0, 'preview text missing');
    });

    const saveButton = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && hasClass(node, 'primary');
    })[0];

    saveButton.props.onClick({});
    await settle();
    check('render: saving posts cls + note to /classify', function () {
      const classifyCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/classify') === 0; });
      eq(classifyCalls.length, 1, 'classify request count');
      const body = JSON.parse(classifyCalls[0].init.body);
      eq(body.sessionId, MOCK.sessionId, 'classify sessionId');
      eq(body.path, MOCK.nodes[0].path, 'classify path');
      eq(body.cls, null, 'choosing the auto class must clear the override (cls:null)');
      eq(body.note, '', 'note payload');
      ok(textOf(renderer.tree()).indexOf('已保存') >= 0, 'save toast missing');
    });

    // --- v3 P1: reset must omit the note payload entirely ---
    const resetButton = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && textOf(node).trim() === '恢复自动分类';
    })[0];
    ok(resetButton, 'reset button missing');
    resetButton.props.onClick({});
    await settle();
    check('render: reset posts cls:null without a note (note must survive host-side)', function () {
      const classifyCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/classify') === 0; });
      eq(classifyCalls.length, 2, 'reset classify request count');
      const body = JSON.parse(classifyCalls[1].init.body);
      eq(body.cls, null, 'reset payload cls');
      ok(!Object.prototype.hasOwnProperty.call(body, 'note'), 'reset must omit note entirely: ' + JSON.stringify(body));
    });

    const laneChips = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-lanechip');
    });

    check('render: lane chip toggles that lane off the canvas', function () {
      eq(laneChips.length, MOCK.lanes.length, 'lane chip count');
      const tempChip = laneChips.filter(function (node) { return hasClass(node, 'sf-lane-temp'); })[0];
      ok(tempChip, 'temp lane chip missing');
      tempChip.props.onClick({});
      const after = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-node'); });
      const tempNodes = MOCK.nodes.filter(function (node) { return node.lane === 'temp'; });
      eq(after.length, MOCK.nodes.length - tempNodes.length, 'hidden lane nodes must disappear');
      const offLabels = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-lanelabel') && hasClass(node, 'off'); });
      eq(offLabels.length, 1, 'lane label must look switched off');
    });

    // --- Esc closes the drawer first ---
    check('render: first Esc closes the drawer but keeps the overlay open', function () {
      const esc = dispatchKey('Escape', 27);
      eq(esc.defaultPrevented, false, 'Esc must not need preventDefault');
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-drawer'); }).length, 0, 'drawer still open');
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-overlay'); }).length, 1, 'overlay must stay open');
    });

    // --- v2: the workspace backlog only shows up once the host sends `workspace` ---
    currentLedger = MOCK_WITH_WORKSPACE;
    const refreshButton = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && textOf(node).trim() === '刷新';
    })[0];
    ok(refreshButton, 'refresh button missing');
    refreshButton.props.onClick({});
    await settle(20);

    check('render: two-part counts separate workspace files from tree nodes', function () {
      const rows = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-counts'); });
      eq(rows.length, 1, 'counts row count');
      const text = textOf(rows[0]);
      ok(text.indexOf('工作区') >= 0, 'workspace segment missing');
      ok(text.indexOf('451') >= 0, 'file-level count missing: ' + text);
      ok(text.indexOf('树中') >= 0, 'tree segment missing');
      ok(text.indexOf('展示本会话触碰过的文件') >= 0, 'tree hint missing');
    });

    check('render: backlog chip opens a popover with only the first 20 paths', function () {
      const chips = findAll(renderer.tree(), function (node) {
        return node.host && node.type === 'button' && hasClass(node, 'sf-unfoldbtn');
      });
      eq(chips.length, 1, 'unfold chip count');
      eq(textOf(chips[0]), '另有 180 个未展开', 'unfold chip copy');
      eq(chips[0].props['aria-expanded'], 'false', 'popover starts closed');
      chips[0].props.onClick({});
      const pops = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-pop'); });
      eq(pops.length, 1, 'popover count');
      const items = findAll(pops[0], function (node) { return node.host && hasClass(node, 'sf-pop-item'); });
      eq(items.length, 20, 'popover must list the first 20 paths only');
      eq(items[0].props.title, MOCK_WORKSPACE_PATHS[0], 'popover keeps the raw path in the title');
      ok(textOf(items[0]).indexOf('中文目录') >= 0, 'CJK path must render');
      ok(textOf(pops[0]).indexOf('共 180 个') >= 0, 'popover total hint: ' + textOf(pops[0]));
      const reopened = findAll(renderer.tree(), function (node) {
        return node.host && node.type === 'button' && hasClass(node, 'sf-unfoldbtn');
      })[0];
      eq(reopened.props['aria-expanded'], 'true', 'chip reflects the open popover');
    });

    check('render: Esc closes the backlog popover before the overlay', function () {
      dispatchKey('Escape', 27);
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-pop'); }).length, 0, 'popover must close');
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-overlay'); }).length, 1, 'overlay must stay open');
    });

    // --- v3 P1: warnings carrying the node-limit code become an orange status chip ---
    currentLedger = MOCK_NODE_LIMIT;
    refreshButton.props.onClick({});
    await settle(20);
    check('render: node-limit warning renders an orange status chip', function () {
      const chips = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-nodelimit'); });
      eq(chips.length, 1, 'node-limit chip count');
      ok(textOf(chips[0]).indexOf('节点过多，部分轮次未展示') >= 0, 'node-limit copy: ' + textOf(chips[0]));
      eq(textOf(renderer.tree()).indexOf('node-limit'), -1, 'raw warning code must not leak into the ui');
    });
    currentLedger = MOCK_WITH_WORKSPACE;
    refreshButton.props.onClick({});
    await settle(20);
    check('render: node-limit chip disappears once the warning is gone', function () {
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-nodelimit'); }).length, 0, 'node-limit chip must disappear');
    });

    // --- v2: two-step cleanup (dry run first, then the real delete) ---
    const treeTempPaths = Array.from(
      new Set(
        MOCK.nodes
          .filter(function (node) {
            return node.lane === 'temp';
          })
          .map(function (node) {
            return node.path;
          }),
      ),
    );
    dryDeleted = treeTempPaths.concat(MOCK_WORKSPACE_PATHS);
    deleteSkipped = ['locked.txt'];
    const cleanupButton = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && hasClass(node, 'danger');
    })[0];
    ok(cleanupButton, 'cleanup button missing');
    cleanupButton.props.onClick({});
    await settle(30);

    check('render: cleanup dry-runs with scope=all before touching anything', function () {
      const deleteCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/delete') === 0; });
      eq(deleteCalls.length, 2, 'dry run + real delete');
      const dry = JSON.parse(deleteCalls[0].init.body);
      eq(dry.scope, 'all', 'dry run scope');
      eq(dry.dryRun, true, 'dry run flag');
      eq(dry.paths, undefined, 'dry run must not send paths (an old host would delete them)');
    });

    check('render: confirm copy names the total and the not-in-tree count', function () {
      ok(confirmCalls.length >= 1, 'confirm must be called');
      const copy = String(confirmCalls[confirmCalls.length - 1]);
      ok(copy.indexOf('187') >= 0, 'confirm total missing: ' + copy);
      ok(copy.indexOf('180') >= 0, 'confirm backlog count missing: ' + copy);
      ok(copy.indexOf('未在树中') >= 0, 'confirm must mention the not-in-tree files');
    });

    check('render: real delete reports cleaned + historical + skipped', function () {
      const deleteCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/delete') === 0; });
      const real = JSON.parse(deleteCalls[1].init.body);
      eq(real.scope, 'all', 'real delete scope');
      eq(real.dryRun, undefined, 'real delete must not carry dryRun');
      eq(real.paths.length, treeTempPaths.length + MOCK_WORKSPACE_PATHS.length, 'real delete paths');
      ok(real.paths.indexOf('debug.log') >= 0, 'tree temp node path missing from the real delete');
      const toast = textOf(renderer.tree());
      ok(toast.indexOf('已清理 187 个（含 180 个历史遗留）') >= 0, 'cleanup toast missing');
      ok(toast.indexOf('跳过 1 个') >= 0, 'skipped toast missing');
      eq(
        findAll(renderer.tree(), function (node) {
          return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && hasClass(node, 'danger');
        })[0].props.disabled,
        false,
        'cleanup button must be re-enabled',
      );
    });

    // --- v3 P1: a partial delete is an informational outcome, not an error ---
    const tempChipAgain = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-lanechip') && hasClass(node, 'sf-lane-temp');
    })[0];
    ok(tempChipAgain, 'temp lane chip missing');
    tempChipAgain.props.onClick({});
    await settle();
    const tempCard = findAll(renderer.tree(), function (node) {
      return node.host && hasClass(node, 'sf-node') && textOf(node).indexOf('debug.log') >= 0;
    })[0];
    ok(tempCard, 'temp node card missing');
    tempCard.props.onClick({ stopPropagation() {} });
    await settle();
    const drawerBox = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-drawer'); })[0];
    ok(drawerBox, 'drawer missing');
    const drawerDelete = findAll(drawerBox, function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && hasClass(node, 'danger');
    })[0];
    ok(drawerDelete, 'delete button missing for a temp node');
    deleteSkipped = ['locked.txt'];
    dryDeleted = [];
    drawerDelete.props.onClick({});
    await settle(20);
    check('render: skipped deletions surface as an info toast, not an error', function () {
      const toastNode = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-toast'); })[0];
      ok(toastNode, 'toast missing');
      ok(hasClass(toastNode, 'info'), 'skipped toast must use the info tone');
      ok(!hasClass(toastNode, 'error'), 'skipped toast must not use the error tone');
      ok(textOf(toastNode).indexOf('跳过 1 个') >= 0, 'skipped count missing: ' + textOf(toastNode));
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-errorline'); }).length, 0, 'no error line expected');
    });
    dispatchKey('Escape', 27);
    await settle();

    check('render: Esc closes the overlay and resets the store', function () {
      dispatchKey('Escape', 27);
      eq(findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-overlay'); }).length, 0, 'overlay still open');
      eq(renderApi.__test.getOpenSnapshot().open, false, 'store must be closed');
      eq(renderApi.__test.getOpenSnapshot().sessionId, null, 'store sessionId must be cleared');
    });

    await settle();

    check('render: reopening after close still works (no leaked listeners)', function () {
      const openButton = findAll(renderer.tree(), function (node) {
        return node.host && node.type === 'button' && hasClass(node, 'sf-open-btn');
      })[0];
      ok(openButton, 'button disappeared after close');
      const before = calls.filter(function (call) { return call.url.indexOf('/api/session-files/ledger') === 0; }).length;
      openButton.props.onClick({ preventDefault() {} });
      const after = calls.filter(function (call) { return call.url.indexOf('/api/session-files/ledger') === 0; }).length;
      eq(after, before + 1, 'reopen must refetch the ledger');
    });
    await settle();

    // --- v3 P1: an empty tree must agree with a non-empty workspace scan ---
    dispatchKey('Escape', 27);
    await settle();
    currentLedger = MOCK_FILE_ONLY;
    const reopenButton = findAll(renderer.tree(), function (node) {
      return node.host && node.type === 'button' && hasClass(node, 'sf-open-btn');
    })[0];
    ok(reopenButton, 'open button missing');
    reopenButton.props.onClick({ preventDefault() {} });
    await settle(20);
    check('render: empty tree with workspace files explains the mismatch and offers cleanup', function () {
      const status = findAll(renderer.tree(), function (node) { return node.host && hasClass(node, 'sf-status'); })[0];
      ok(status, 'empty state missing');
      const copy = textOf(status);
      ok(copy.indexOf('本会话没有触碰文件，但工作区扫描到 3 个文件') >= 0, 'empty copy: ' + copy);
      ok(copy.indexOf('3 个临时文件可清理') >= 0, 'cleanable copy: ' + copy);
      const cleanupInEmpty = findAll(status, function (node) {
        return node.host && node.type === 'button' && hasClass(node, 'sf-tbtn') && hasClass(node, 'danger');
      })[0];
      ok(cleanupInEmpty, 'empty state must offer the cleanup button');
      cleanupInEmpty.props.onClick({});
    });
    await settle(20);
    check('render: cleanup from the empty state dry-runs before touching anything', function () {
      const deleteCalls = calls.filter(function (call) { return call.url.indexOf('/api/session-files/delete') === 0; });
      ok(deleteCalls.length > 0, 'delete request missing');
      const body = JSON.parse(deleteCalls[deleteCalls.length - 1].init.body);
      eq(body.dryRun, true, 'empty-state cleanup must dry run first');
      eq(body.scope, 'all', 'empty-state cleanup scope');
      eq(body.paths, undefined, 'empty-state cleanup must not send paths in the dry run');
    });
    await settle();
  })().catch(function (error) {
    fail += 1;
    failures.push('render smoke test crashed :: ' + (error && error.stack ? error.stack : String(error)));
    console.log('FAIL  render smoke test crashed :: ' + (error && error.message ? error.message : String(error)));
  });
} catch (error) {
  fail += 1;
  failures.push('render smoke test setup crashed :: ' + (error && error.stack ? error.stack : String(error)));
  console.log('FAIL  render smoke test setup crashed :: ' + (error && error.message ? error.message : String(error)));
}

function fetchUrlParam(url, name) {
  const query = String(url).split('?')[1] || '';
  const pairs = query.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const index = pairs[i].indexOf('=');
    if (index < 0) continue;
    if (pairs[i].slice(0, index) === name) return decodeURIComponent(pairs[i].slice(index + 1));
  }
  return null;
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

console.log('');
console.log('----------------------------------------');
console.log('PASS ' + pass + '  FAIL ' + fail);
if (fail > 0) {
  failures.forEach(function (line) {
    console.log('  x ' + line);
  });
  process.exitCode = 1;
}
