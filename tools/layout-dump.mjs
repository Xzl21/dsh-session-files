// Dump the real `layout()` geometry from client.js for a ledger, so a raster
// renderer (Python + PIL) can draw an accurate preview of the file tree.
//
//   node plugins/dsh-session-files/tools/layout-dump.mjs <ledger.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ledgerPath = process.argv[2]
const outPath = process.argv[3]
if (!ledgerPath || !outPath) throw new Error('usage: layout-dump.mjs <ledger.json> <out.json>')

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useContext: () => ({}),
  createContext: () => ({}),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: { load(def) { captured = def } },
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem: () => {} },
}
globalThis.document = { createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} } }

const clientPath = path.resolve(here, '..', 'client.js')
await import(pathToFileURL(clientPath).href)
if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')
const mod = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})
const T = mod.__test
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))

const laid = T.layout(ledger.nodes, ledger.edges, T.LAYOUT_DEFAULTS)
const nodeById = new Map(ledger.nodes.map((n) => [String(n.id), n]))
const result = {
  columns: ledger.columns,
  counts: ledger.counts,
  meta: {
    sessionId: ledger.sessionId,
    workspacePath: ledger.workspacePath,
    generatedAt: ledger.generatedAt,
    live: ledger.live,
    source: ledger.source,
    warnings: ledger.warnings || [],
  },
  layout: {
    width: laid.width,
    height: laid.height,
    colCount: laid.colCount,
    colWidth: laid.colWidth,
    cardWidth: laid.cardWidth,
    cardHeight: laid.cardHeight,
    rowPitch: laid.rowPitch,
    topPad: laid.topPad,
    laneTops: laid.laneTops,
    laneHeights: laid.laneHeights,
    laneOrder: laid.laneOrder,
  },
  nodes: laid.nodes.map((n) => {
    const src = nodeById.get(String(n.id)) || {}
    return {
      id: n.id,
      name: src.name,
      path: src.path,
      cls: n.cls,
      lane: n.lane,
      col: n.col,
      kind: src.kind,
      reason: src.reason,
      autoCls: src.autoCls,
      overridden: !!src.overridden,
      exists: src.exists !== false,
      size: src.size,
      note: src.note || null,
      turns: src.turns || [],
      actions: src.actions || [],
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
    }
  }),
  edges: laid.edges.map((e) => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    path: e.path,
    x1: e.x1,
    y1: e.y1,
    x2: e.x2,
    y2: e.y2,
  })),
}

writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf8')
console.log('nodes=' + result.nodes.length + ' edges=' + result.edges.length + ' size=' + result.layout.width + 'x' + result.layout.height)
