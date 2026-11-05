/**
 * dsh-session-files — Client half.
 *
 * One plain ES module loaded through window.__ModuleLoader__.load(). No JSX, no
 * imports, no npm dependencies: only `require('react')` and browser globals.
 *
 * Registers exactly two slots:
 *   conversation.input.right  (list, scope session)  -> compact icon button, props.sessionId
 *   shell.overlay             (list, scope root)     -> full screen file tree
 *
 * The two components talk through a module level store, because shell.overlay
 * receives no sessionId. The overlay layer is click-through, so the overlay
 * component renders null while closed and a pointer-events:auto root while open.
 *
 * Contract: CONTRACT.md §5 (ledger JSON), §6 (HTTP), §7 (copy).
 */

const LOADER = typeof window !== 'undefined' && window && window.__ModuleLoader__ ? window.__ModuleLoader__ : null;

if (LOADER && typeof LOADER.load === 'function') {
  LOADER.load({
    id: 'dsh-session-files',
    factory: function (require) {
      const React = require('react');
      const h = React.createElement;
      const useState = React.useState;
      const useEffect = React.useEffect;
      const useMemo = React.useMemo;
      const useCallback = React.useCallback;
      const useRef = React.useRef;

      // ---------------------------------------------------------------------
      // constants
      // ---------------------------------------------------------------------

      const API_PREFIX = '/api/session-files';
      const LANES = ['deliverable', 'process', 'input', 'temp'];
      const LANE_SET = { deliverable: true, process: true, input: true, temp: true };

      const LAYOUT_DEFAULTS = {
        colWidth: 240,
        cardWidth: 200,
        cardHeight: 66,
        rowPitch: 82,
        topPad: 20,
        bottomPad: 20,
        laneMinHeight: 132,
        laneMinHeightByLane: null,
        lanes: LANES,
        minColumns: 0,
      };

      const ZOOM_MIN = 0.4;
      const ZOOM_MAX = 2;
      const ZOOM_STEP = 0.1;
      // Max backlog paths listed in the "not expanded" popover.
      const UNFOLD_PREVIEW = 20;
      const PREVIEW_MAX_BYTES = 65536;

      // ---------------------------------------------------------------------
      // copy (CONTRACT §7, zh default; extra keys are this file's own labels)
      // ---------------------------------------------------------------------

      const DICT = {
        zh: {
          'title': '会话文件树',
          'lane.deliverable': '交付',
          'lane.process': '过程',
          'lane.input': '输入',
          'lane.temp': '临时',
          'btn.open': '文件树',
          'action.refresh': '刷新',
          'action.cleanup': '清理全部临时文件',
          'action.delete': '删除',
          'action.save': '保存',
          'action.reset': '恢复自动分类',
          'action.close': '关闭',
          'action.retry': '重试',
          'confirm.delete': '把 {n} 个文件移到回收站？',
          'confirm.cleanup': '把 {n} 个临时文件移到回收站？',
          'confirm.cleanupAll': '将把 {n} 个临时文件移入回收站（其中 {m} 个未在树中）。继续？',
          'empty': '这个会话还没有产生文件',
          'empty.hint': '文件工具被调用后，文件会出现在这里。',
          'empty.workspace': '本会话没有触碰文件，但工作区扫描到 {n} 个文件（其中 {m} 个临时文件可清理）',
          'loading': '正在读取会话文件…',
          'error.network': '读取失败：Host 半未生效或需要重启 DSH',
          'error.op': '操作失败',
          'error.title': '出错了',
          'label.code': '错误码',
          'label.session': '会话',
          'label.source': '来源',
          'label.workspace': '工作区',
          'label.generated': '生成于',
          'label.files': '文件',
          'label.path': '路径',
          'label.lane': '道',
          'label.auto': '自动分类',
          'label.reason': '原因',
          'label.size': '大小',
          'label.mtime': '修改时间',
          'label.turns': '轮次',
          'label.actions': '动作',
          'label.note': '备注',
          'label.preview': '预览',
          'label.warnings': '警告',
          'label.unknown': '未知',
          'label.lane.filter': '点击切换这一道的显示',
          'note.ph': '备注…',
          'source.live': '实时',
          'source.log': '历史日志',
          'toast.cleaned': '已清理 {n} 个临时文件',
          'toast.skipped': '跳过 {n} 个',
          'toast.cleaning': '正在统计临时文件…',
          'toast.cleanedAll': '已清理 {n} 个（含 {m} 个历史遗留）',
          'toast.saved': '已保存',
          'toast.deleted': '已删除 {n} 个（移到回收站）',
          'cleanup.none': '没有临时文件需要清理',
          'tag.overridden': '已手动分类',
          'node.gone': '文件已不存在',
          'preview.empty': '（空文件）',
          'preview.binary': '二进制文件，无法预览',
          'preview.truncated': '内容已截断（仅显示前 64 KB）',
          'preview.loading': '正在读取预览…',
          'zoom.in': '放大',
          'zoom.out': '缩小',
          'zoom.reset': '重置缩放',
          'counts.workspace': '工作区',
          'counts.files': '{n} 个文件',
          'counts.tree': '树中',
          'counts.nodes': '{n} 个节点',
          'counts.tree.hint': '展示本会话触碰过的文件',
          'counts.unfold': '另有 {n} 个未展开',
          'counts.unfold.hint': '被判为临时、但没有被任何工具调用触达，所以不在树中',
          'counts.unfold.more': '… 共 {n} 个',
          'counts.unfold.truncated': '列表已截断（最多 500 条）',
          'counts.unfold.seen': '显示前 {shown} 条',
          'counts.nodeLimit': '节点过多，部分轮次未展示（会话过大）',
          'edge.origin': '出现',
          'edge.evolution': '演变',
          'edge.derived': '派生',
          'edge.deliverable': '交付',
          'reason.presented': 'present 过',
          'reason.dir': '位于交付目录',
          'reason.temp-name': '文件名或目录像临时文件',
          'reason.temp-ext': '临时扩展名',
          'reason.temp-dir': '位于临时目录',
          'reason.oneday-script': '一次性脚本',
          'reason.readonly-preexisting': '会话前已存在，只读',
          'reason.written': '会话中被写入',
          'reason.scanned-preexisting': '扫描发现，会话前已存在',
          'reason.scanned-new': '扫描发现，会话中新增',
          'reason.override': '手动分类',
        },
        en: {
          'title': 'Session file tree',
          'lane.deliverable': 'Deliverable',
          'lane.process': 'Process',
          'lane.input': 'Input',
          'lane.temp': 'Temp',
          'btn.open': 'File tree',
          'action.refresh': 'Refresh',
          'action.cleanup': 'Clean up all temp files',
          'action.delete': 'Delete',
          'action.save': 'Save',
          'action.reset': 'Auto',
          'action.close': 'Close',
          'action.retry': 'Retry',
          'confirm.delete': 'Move {n} files to trash?',
          'confirm.cleanup': 'Move {n} temp files to trash?',
          'confirm.cleanupAll': 'Move {n} temp files to trash ({m} of them not in the tree). Continue?',
          'empty': 'No files yet in this session',
          'empty.hint': 'Files appear here once a file tool runs.',
          'empty.workspace': 'This session touched no files, but the workspace scan found {n} file(s) ({m} temp file(s) can be cleaned up)',
          'loading': 'Reading session files…',
          'error.network': 'Failed: host half not live (restart DSH?)',
          'error.op': 'Operation failed',
          'error.title': 'Something went wrong',
          'label.code': 'Code',
          'label.session': 'Session',
          'label.source': 'Source',
          'label.workspace': 'Workspace',
          'label.generated': 'Generated',
          'label.files': 'files',
          'label.path': 'Path',
          'label.lane': 'Lane',
          'label.auto': 'Auto class',
          'label.reason': 'Reason',
          'label.size': 'Size',
          'label.mtime': 'Modified',
          'label.turns': 'Turns',
          'label.actions': 'Actions',
          'label.note': 'Note',
          'label.preview': 'Preview',
          'label.warnings': 'Warnings',
          'label.unknown': 'unknown',
          'label.lane.filter': 'Toggle this lane',
          'note.ph': 'Note…',
          'source.live': 'Live',
          'source.log': 'Log',
          'toast.cleaned': 'Cleaned up {n} temp files',
          'toast.skipped': 'Skipped {n}',
          'toast.cleaning': 'Counting temp files…',
          'toast.cleanedAll': 'Cleaned {n} ({m} historical)',
          'toast.saved': 'Saved',
          'toast.deleted': 'Deleted {n} file(s) (moved to trash)',
          'cleanup.none': 'No temp files to clean up',
          'tag.overridden': 'Manually classified',
          'node.gone': 'File no longer exists',
          'preview.empty': '(empty file)',
          'preview.binary': 'Binary file, cannot preview',
          'preview.truncated': 'Truncated (first 64 KB only)',
          'preview.loading': 'Loading preview…',
          'zoom.in': 'Zoom in',
          'zoom.out': 'Zoom out',
          'zoom.reset': 'Reset zoom',
          'counts.workspace': 'Workspace',
          'counts.files': '{n} files',
          'counts.tree': 'In tree',
          'counts.nodes': '{n} nodes',
          'counts.tree.hint': 'files this session touched',
          'counts.unfold': '{n} more not expanded',
          'counts.unfold.hint': 'Classified temp, but no tool call touched them, so they are not in the tree',
          'counts.unfold.more': '… {n} total',
          'counts.unfold.truncated': 'List truncated (500 max)',
          'counts.unfold.seen': 'showing first {shown}',
          'counts.nodeLimit': 'Too many nodes: some turns are not shown (very large session)',
          'edge.origin': 'origin',
          'edge.evolution': 'evolution',
          'edge.derived': 'derived',
          'edge.deliverable': 'deliverable',
          'reason.presented': 'presented',
          'reason.dir': 'deliverable directory',
          'reason.temp-name': 'temp-looking name',
          'reason.temp-ext': 'temp extension',
          'reason.temp-dir': 'temp directory',
          'reason.oneday-script': 'one-shot script',
          'reason.readonly-preexisting': 'pre-existing, read only',
          'reason.written': 'written in session',
          'reason.scanned-preexisting': 'scanned, pre-existing',
          'reason.scanned-new': 'scanned, created in session',
          'reason.override': 'manual',
        },
      };

      const langState = { lang: 'zh', listeners: new Set() };

      function normalizeLang(tag) {
        if (typeof tag !== 'string') return null;
        const v = tag.trim().toLowerCase();
        if (!v) return null;
        return v.indexOf('zh') === 0 ? 'zh' : 'en';
      }

      function notifyLang() {
        const listeners = Array.from(langState.listeners);
        for (let i = 0; i < listeners.length; i++) {
          try {
            listeners[i]();
          } catch (err) {
            /* a broken listener must not break the others */
          }
        }
      }

      function setLang(tag) {
        const next = normalizeLang(tag);
        if (!next || next === langState.lang) return;
        langState.lang = next;
        notifyLang();
      }

      function getLang() {
        return langState.lang;
      }

      function subscribeLang(fn) {
        if (typeof fn !== 'function') return function () {};
        langState.listeners.add(fn);
        return function () {
          langState.listeners.delete(fn);
        };
      }

      function interpolate(text, params) {
        const src = String(text);
        if (!params || typeof params !== 'object') return src;
        return src.replace(/\{(\w+)\}/g, function (match, key) {
          const value = params[key];
          return value === undefined || value === null ? match : String(value);
        });
      }

      function translate(lang, key, params) {
        const table = DICT[lang] || DICT.zh;
        const text = table[key] !== undefined ? table[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
        return interpolate(text, params);
      }

      function t(key, params) {
        return translate(langState.lang, key, params);
      }

      function useLang() {
        const [lang, setLocalLang] = useState(function () {
          return getLang();
        });
        useEffect(function () {
          return subscribeLang(function () {
            setLocalLang(getLang());
          });
        }, []);
        return lang;
      }

      // ---------------------------------------------------------------------
      // locale service (defensive: ctx.get('locale') or ctx.locale)
      // ---------------------------------------------------------------------

      function safeLocaleSnapshot(service) {
        if (!service) return null;
        try {
          if (typeof service.getLocale === 'function') return service.getLocale();
        } catch (err) {
          /* fall through */
        }
        try {
          if (typeof service.getSnapshot === 'function') return service.getSnapshot();
        } catch (err) {
          /* fall through */
        }
        try {
          if (typeof service.get === 'function') return service.get();
        } catch (err) {
          /* fall through */
        }
        try {
          if (service.locale !== undefined) return service.locale;
          if (service.snapshot !== undefined) return service.snapshot;
        } catch (err) {
          /* fall through */
        }
        return null;
      }

      function detectLang(service) {
        const snap = safeLocaleSnapshot(service);
        if (typeof snap === 'string') return normalizeLang(snap);
        if (!snap || typeof snap !== 'object') return null;
        const tag = snap.id || snap.locale || snap.tag || snap.lang || snap.language || null;
        return normalizeLang(tag);
      }

      function resolveLocaleService(ctx) {
        try {
          if (ctx && typeof ctx.get === 'function') {
            const fromGet = ctx.get('locale');
            if (fromGet) return fromGet;
          }
        } catch (err) {
          /* fall through */
        }
        try {
          if (ctx && ctx.locale) return ctx.locale;
        } catch (err) {
          /* fall through */
        }
        return null;
      }

      function subscribeLocale(service, onChange) {
        if (!service || typeof service.subscribe !== 'function') return function () {};
        let off = null;
        try {
          off = service.subscribe(onChange);
        } catch (err) {
          off = null;
        }
        return function () {
          try {
            if (typeof off === 'function') off();
            else if (off && typeof off.dispose === 'function') off.dispose();
            else if (off && typeof off.unsubscribe === 'function') off.unsubscribe();
            else if (typeof service.unsubscribe === 'function') service.unsubscribe(onChange);
          } catch (err) {
            /* ignore */
          }
        };
      }

      // ---------------------------------------------------------------------
      // formatting helpers
      // ---------------------------------------------------------------------

      function fmtSize(bytes) {
        const n = Number(bytes);
        if (!isFinite(n) || n < 0) return '—';
        if (n < 1024) return n + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = n / 1024;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
          value /= 1024;
          index += 1;
        }
        const rounded = Math.round(value * 10) / 10;
        return rounded + ' ' + units[index];
      }

      function fmtDateTime(ms, lang) {
        const n = Number(ms);
        if (!isFinite(n) || n <= 0) return '—';
        const locale = (lang || getLang()) === 'zh' ? 'zh-CN' : 'en-US';
        try {
          return new Intl.DateTimeFormat(locale, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(n));
        } catch (err) {
          return String(n);
        }
      }

      function fmtClock(ms, lang) {
        const n = Number(ms);
        if (!isFinite(n) || n <= 0) return '';
        const locale = (lang || getLang()) === 'zh' ? 'zh-CN' : 'en-US';
        try {
          return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(n));
        } catch (err) {
          return '';
        }
      }

      function shortId(value) {
        const text = String(value || '');
        if (text.length <= 20) return text;
        return text.slice(0, 8) + '…' + text.slice(-4);
      }

      function reasonText(reason) {
        if (typeof reason !== 'string' || !reason) return '—';
        return t('reason.' + reason);
      }

      function errCode(err) {
        if (err && typeof err.code === 'string' && err.code) return err.code;
        if (err && typeof err.message === 'string' && err.message) return err.message;
        return 'unknown';
      }

      function confirmFn(message) {
        try {
          if (typeof window !== 'undefined' && window && typeof window.confirm === 'function') return !!window.confirm(message);
        } catch (err) {
          /* fall through */
        }
        return false;
      }

      function laneColor(lane) {
        const key = LANE_SET[lane] ? lane : 'process';
        return 'var(--sf-lane-' + key + ', ' + LANE_FALLBACK[key] + ')';
      }

      const LANE_FALLBACK = {
        deliverable: '#2f6fe4',
        process: '#0e9f8a',
        input: '#8a8f9a',
        temp: '#d1862b',
      };

      const ACTION_FALLBACK = {
        read: '#4f7ee0',
        write: '#12946f',
        edit: '#c98a1b',
        exec: '#9a5cd0',
        present: '#d6538a',
        delete: '#d93025',
      };

      function actionColor(action) {
        const key = String(action || '');
        if (!ACTION_FALLBACK[key]) return 'var(--sf-fg3, #838893)';
        return 'var(--sf-act-' + key + ', ' + ACTION_FALLBACK[key] + ')';
      }

      // ---------------------------------------------------------------------
      // HTTP (CONTRACT §6). Every URL starts with API_PREFIX.
      // ---------------------------------------------------------------------

      function apiUrl(path, params) {
        const parts = [];
        if (params && typeof params === 'object') {
          const keys = Object.keys(params);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const value = params[key];
            if (value === undefined || value === null) continue;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
          }
        }
        return API_PREFIX + path + (parts.length ? '?' + parts.join('&') : '');
      }

      function apiRequest(method, path, params, body) {
        if (typeof fetch !== 'function') {
          const noFetch = new Error('no-fetch');
          noFetch.code = 'no-fetch';
          return Promise.reject(noFetch);
        }
        const init = { method: method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        return fetch(apiUrl(path, params), init).then(
          function (response) {
            return response.text().then(function (text) {
              let data = null;
              if (text) {
                try {
                  data = JSON.parse(text);
                } catch (err) {
                  data = null;
                }
              }
              if (!response.ok || !data || data.ok !== true) {
                const code = data && typeof data.code === 'string' && data.code ? data.code : response.ok ? 'bad-response' : 'http-' + response.status;
                const error = new Error(code);
                error.code = code;
                error.status = response.status;
                error.data = data;
                throw error;
              }
              return data;
            });
          },
          function () {
            const error = new Error('network');
            error.code = 'network';
            throw error;
          },
        );
      }

      function apiGet(path, params) {
        return apiRequest('GET', path, params, undefined);
      }

      function apiPost(path, body) {
        return apiRequest('POST', path, null, body || {});
      }

      // ---------------------------------------------------------------------
      // layout — pure. Contract: x = colIndex*colWidth + pad, y = laneTop + stack*rowPitch.
      // ---------------------------------------------------------------------

      function edgePath(x1, y1, x2, y2) {
        const round = function (v) {
          return Math.round(Number(v) * 100) / 100;
        };
        if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return 'M 0 0 C 0 0 0 0 0 0';
        if (x2 > x1 + 8) {
          const dx = Math.max(28, (x2 - x1) / 2);
          return (
            'M ' + round(x1) + ' ' + round(y1) +
            ' C ' + round(x1 + dx) + ' ' + round(y1) +
            ', ' + round(x2 - dx) + ' ' + round(y2) +
            ', ' + round(x2) + ' ' + round(y2)
          );
        }
        // Same column (or backwards): loop out to the right so the edge stays visible.
        const bulge = 52;
        return (
          'M ' + round(x1) + ' ' + round(y1) +
          ' C ' + round(x1 + bulge) + ' ' + round(y1) +
          ', ' + round(x2 + bulge) + ' ' + round(y2) +
          ', ' + round(x2) + ' ' + round(y2)
        );
      }

      function layout(nodes, edges, opts) {
        const o = Object.assign({}, LAYOUT_DEFAULTS, opts || {});
        const lanes = Array.isArray(o.lanes) && o.lanes.length > 0 ? o.lanes.slice() : LANES.slice();
        const inputNodes = Array.isArray(nodes) ? nodes : [];
        const inputEdges = Array.isArray(edges) ? edges : [];

        const num = function (value, fallback) {
          const n = Number(value);
          return isFinite(n) ? n : fallback;
        };

        const colWidth = num(o.colWidth, LAYOUT_DEFAULTS.colWidth);
        const cardWidth = num(o.cardWidth, LAYOUT_DEFAULTS.cardWidth);
        const cardHeight = num(o.cardHeight, LAYOUT_DEFAULTS.cardHeight);
        const rowPitch = Math.max(num(o.rowPitch, LAYOUT_DEFAULTS.rowPitch), cardHeight);
        const topPad = Math.max(0, num(o.topPad, LAYOUT_DEFAULTS.topPad));
        const bottomPad = Math.max(0, num(o.bottomPad, LAYOUT_DEFAULTS.bottomPad));
        const padX = Math.max(0, (colWidth - cardWidth) / 2);

        const laneMin = function (lane) {
          const byLane = o.laneMinHeightByLane;
          if (byLane && typeof byLane === 'object' && typeof byLane[lane] === 'number' && isFinite(byLane[lane])) return byLane[lane];
          return num(o.laneMinHeight, LAYOUT_DEFAULTS.laneMinHeight);
        };

        const laneOf = function (node) {
          const lane = node && node.lane;
          return lanes.indexOf(lane) >= 0 ? lane : lanes[0];
        };

        const colOf = function (node) {
          const col = Number(node && node.col);
          return isFinite(col) && col >= 0 ? Math.floor(col) : 0;
        };

        let maxCol = -1;
        const buckets = new Map();
        for (let i = 0; i < inputNodes.length; i++) {
          const node = inputNodes[i];
          if (!node || typeof node !== 'object') continue;
          const lane = laneOf(node);
          const col = colOf(node);
          if (col > maxCol) maxCol = col;
          const key = lane + '\u0000' + col;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
          }
          bucket.push(node);
        }

        const colCount = Math.max(num(o.minColumns, 0), maxCol + 1);
        const safeColCount = Math.max(0, Math.floor(colCount));

        const laneHeights = {};
        const laneTops = {};
        let cursor = 0;
        for (let i = 0; i < lanes.length; i++) {
          const lane = lanes[i];
          let maxStack = 0;
          for (let col = 0; col < safeColCount; col++) {
            const bucket = buckets.get(lane + '\u0000' + col);
            if (bucket && bucket.length > maxStack) maxStack = bucket.length;
          }
          const contentHeight =
            maxStack === 0
              ? 0
              : topPad + (maxStack - 1) * rowPitch + cardHeight + bottomPad;
          const height = Math.max(laneMin(lane), contentHeight);
          laneTops[lane] = cursor;
          laneHeights[lane] = height;
          cursor += height;
        }

        const placed = [];
        const byId = new Map();
        for (let i = 0; i < lanes.length; i++) {
          const lane = lanes[i];
          for (let col = 0; col < safeColCount; col++) {
            const bucket = buckets.get(lane + '\u0000' + col);
            if (!bucket) continue;
            for (let stack = 0; stack < bucket.length; stack++) {
              const node = bucket[stack];
              const out = Object.assign({}, node, {
                x: col * colWidth + padX,
                y: laneTops[lane] + topPad + stack * rowPitch,
                w: cardWidth,
                h: cardHeight,
                colIndex: col,
                stackIndex: stack,
              });
              placed.push(out);
              if (node.id !== undefined && node.id !== null) byId.set(String(node.id), out);
            }
          }
        }

        const laidEdges = [];
        for (let i = 0; i < inputEdges.length; i++) {
          const edge = inputEdges[i];
          if (!edge || typeof edge !== 'object') continue;
          if (edge.from === undefined || edge.to === undefined || edge.from === edge.to) continue;
          const from = byId.get(String(edge.from));
          const to = byId.get(String(edge.to));
          if (!from || !to) continue;
          const x1 = from.x + from.w;
          const y1 = from.y + from.h / 2;
          const x2 = to.x;
          const y2 = to.y + to.h / 2;
          laidEdges.push(
            Object.assign({}, edge, {
              x1: x1,
              y1: y1,
              x2: x2,
              y2: y2,
              path: edgePath(x1, y1, x2, y2),
            }),
          );
        }

        return {
          nodes: placed,
          edges: laidEdges,
          width: safeColCount * colWidth,
          height: cursor,
          laneTops: laneTops,
          laneHeights: laneHeights,
          laneOrder: lanes,
          colCount: safeColCount,
          colWidth: colWidth,
          cardWidth: cardWidth,
          cardHeight: cardHeight,
          rowPitch: rowPitch,
          topPad: topPad,
        };
      }

      // ---------------------------------------------------------------------
      // module level open store (the two slots share no props)
      // ---------------------------------------------------------------------

      const overlayStore = { open: false, sessionId: null, listeners: new Set() };

      function emitOpen() {
        const listeners = Array.from(overlayStore.listeners);
        for (let i = 0; i < listeners.length; i++) {
          try {
            listeners[i]();
          } catch (err) {
            /* isolate listeners */
          }
        }
      }

      function setOpen(sessionId) {
        const id = typeof sessionId === 'string' && sessionId ? sessionId : null;
        const nextOpen = !!id;
        if (overlayStore.open === nextOpen && overlayStore.sessionId === id) return;
        overlayStore.open = nextOpen;
        overlayStore.sessionId = id;
        emitOpen();
      }

      function closeOverlay() {
        setOpen(null);
      }

      function subscribeOpen(fn) {
        if (typeof fn !== 'function') return function () {};
        overlayStore.listeners.add(fn);
        return function () {
          overlayStore.listeners.delete(fn);
        };
      }

      function getOpenSnapshot() {
        return { open: overlayStore.open, sessionId: overlayStore.sessionId };
      }

      function useOpenSnapshot() {
        const [snap, setSnap] = useState(getOpenSnapshot);
        useEffect(function () {
          return subscribeOpen(function () {
            setSnap(getOpenSnapshot());
          });
        }, []);
        return snap;
      }

      // ---------------------------------------------------------------------
      // styles (theme tokens only; lane / action hues are plugin-private vars)
      // ---------------------------------------------------------------------

      const CSS = `
.sf-root{
  --sf-bg:var(--dsw-alias-bg-base,#ffffff);
  --sf-surface:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-skeleton,#f5f6f8));
  --sf-border:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --sf-border-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.22));
  --sf-fg:var(--dsw-alias-label-primary,#1b1d22);
  --sf-fg2:var(--dsw-alias-label-secondary,#4a4f59);
  --sf-fg3:var(--dsw-alias-label-tertiary,#838893);
  --sf-fg4:var(--dsw-alias-label-caption,var(--dsw-alias-label-dimmed,#9aa0aa));
  --sf-accent:var(--dsw-alias-state-business-primary,#2f6fe4);
  --sf-danger:var(--dsw-alias-state-error-primary,#d93025);
  --sf-warn:var(--dsw-alias-state-warning-primary,#c47f00);
  --sf-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
  --sf-radius:var(--dsw-radius-md,8px);
  --sf-radius-sm:var(--dsw-radius-sm,6px);
  --sf-radius-panel:var(--dsw-radius-panel,14px);
  --sf-shadow:var(--dsw-elevation-panel,0 18px 48px rgba(0,0,0,.28));
  --sf-font:var(--dsw-font-family,-apple-system,"Segoe UI",system-ui,sans-serif);
  --sf-mono:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
  --sf-lane-deliverable:var(--dsw-lane-deliverable,#2f6fe4);
  --sf-lane-process:var(--dsw-lane-process,#0e9f8a);
  --sf-lane-input:var(--dsw-lane-input,#8a8f9a);
  --sf-lane-temp:var(--dsw-lane-temp,#d1862b);
  --sf-lane-deliverable-soft:rgba(47,111,228,.055);
  --sf-lane-process-soft:rgba(14,159,138,.055);
  --sf-lane-input-soft:rgba(138,143,154,.065);
  --sf-lane-temp-soft:rgba(209,134,43,.065);
  --sf-act-read:#4f7ee0;
  --sf-act-write:#12946f;
  --sf-act-edit:#c98a1b;
  --sf-act-exec:#9a5cd0;
  --sf-act-present:#d6538a;
  --sf-act-delete:#d93025;
  font-family:var(--sf-font);
  color:var(--sf-fg);
}
.sf-lane-deliverable{--sf-lane:var(--sf-lane-deliverable);}
.sf-lane-process{--sf-lane:var(--sf-lane-process);}
.sf-lane-input{--sf-lane:var(--sf-lane-input);}
.sf-lane-temp{--sf-lane:var(--sf-lane-temp);}

/* composer button */
.sf-open-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;border:1px solid var(--sf-border);border-radius:var(--sf-radius-sm);background:transparent;color:var(--sf-fg2);cursor:pointer;font:inherit;line-height:1;transition:background .12s ease,color .12s ease,border-color .12s ease;}
.sf-open-btn:hover{background:var(--sf-hover);color:var(--sf-fg);border-color:var(--sf-border-strong);}
.sf-open-btn:disabled{opacity:.45;cursor:default;}
.sf-open-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--sf-accent));outline-offset:1px;}
.sf-open-btn svg{display:block;}

/* overlay shell */
.sf-overlay{position:fixed;inset:0;z-index:60;pointer-events:auto;}
.sf-backdrop{position:absolute;inset:0;background:rgba(9,11,16,.46);}
.sf-panel{position:absolute;inset:12px;margin:auto;max-width:1440px;display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--sf-bg);border:1px solid var(--sf-border-strong);border-radius:var(--sf-radius-panel);box-shadow:var(--sf-shadow);}

/* header */
.sf-header{display:flex;align-items:center;gap:12px;padding:12px 16px 10px;background:var(--sf-surface);border-bottom:1px solid var(--sf-border);}
.sf-title{font-size:15px;font-weight:650;letter-spacing:.2px;white-space:nowrap;}
.sf-spacer{flex:1;min-width:8px;}
.sf-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid var(--sf-border);font-size:12px;color:var(--sf-fg2);}
.sf-chip{display:inline-flex;align-items:center;gap:5px;max-width:340px;padding:2px 8px;border:1px solid var(--sf-border);border-radius:999px;background:var(--sf-hover);font-size:11.5px;color:var(--sf-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sf-chip b{font-weight:600;color:var(--sf-fg2);}
.sf-chip.mono b,.sf-chip.mono{font-family:var(--sf-mono);}
.sf-warn{color:var(--sf-act-edit);font-size:11.5px;}

/* two-part counts: workspace files (file-level) vs tree nodes (session-touched) */
.sf-counts{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:7px 16px 8px;border-bottom:1px solid var(--sf-border);background:var(--sf-surface);font-size:12px;color:var(--sf-fg3);}
.sf-counts .sf-cstat{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
.sf-counts .sf-cstat b{font-weight:650;color:var(--sf-fg2);}
.sf-counts .sf-cnum{font-weight:650;color:var(--sf-fg2);font-variant-numeric:tabular-nums;}
.sf-counts .sf-csub{font-size:11px;color:var(--sf-fg4);}
.sf-counts .sf-sep{color:var(--sf-border-strong);}
.sf-counts .sf-clanes{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--sf-fg4);}
.sf-counts .sf-clane{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}
.sf-counts .sf-clane i{width:7px;height:7px;border-radius:50%;flex:none;background:var(--sf-lane,var(--sf-fg4));}
.sf-counts .sf-clane b{font-weight:600;color:var(--sf-fg3);font-variant-numeric:tabular-nums;}
.sf-unfoldbtn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 10px;border:1px dashed var(--sf-lane-temp);border-radius:999px;background:transparent;font-family:inherit;font-size:11.5px;color:var(--sf-lane-temp);cursor:pointer;white-space:nowrap;}
.sf-unfoldbtn:hover{background:rgba(209,134,43,.1);}
.sf-unfoldbtn[aria-expanded="true"]{background:rgba(209,134,43,.16);}
.sf-pop{position:absolute;right:16px;top:calc(100% - 2px);z-index:8;width:min(460px,74vw);max-height:340px;display:flex;flex-direction:column;background:var(--sf-bg);border:1px solid var(--sf-border-strong);border-radius:var(--sf-radius-md);box-shadow:var(--sf-shadow);overflow:hidden;}
.sf-pop-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--sf-border);font-size:11.5px;font-weight:600;color:var(--sf-fg2);}
.sf-pop-head .sf-tbtn{margin-left:auto;}
.sf-pop-hint{padding:6px 10px;font-size:11px;color:var(--sf-fg4);border-bottom:1px solid var(--sf-border);}
.sf-pop-list{list-style:none;margin:0;padding:4px 0;overflow:auto;min-height:0;}
.sf-pop-item{padding:3px 10px;font-family:var(--sf-mono);font-size:11px;color:var(--sf-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sf-pop-more{padding:6px 10px;border-top:1px solid var(--sf-border);font-size:11px;color:var(--sf-fg4);}

/* toolbar */
.sf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--sf-border);background:var(--sf-bg);}
.sf-tbtn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--sf-border);border-radius:var(--sf-radius-sm);background:var(--sf-bg);color:var(--sf-fg2);font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease;}
.sf-tbtn:hover{background:var(--sf-hover);color:var(--sf-fg);}
.sf-tbtn[disabled]{opacity:.5;cursor:default;}
.sf-tbtn.primary{background:var(--sf-accent);border-color:transparent;color:#fff;}
.sf-tbtn.primary:hover{filter:brightness(1.06);color:#fff;}
.sf-tbtn.danger{color:var(--sf-danger);border-color:var(--sf-danger);}
.sf-tbtn.danger:hover{background:rgba(217,48,37,.08);color:var(--sf-danger);}
.sf-tbtn.icon{width:28px;padding:0;justify-content:center;font-size:15px;line-height:1;}
.sf-lanechip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--sf-border);border-radius:999px;background:var(--sf-bg);color:var(--sf-fg2);font-family:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;}
.sf-lanechip:hover{background:var(--sf-hover);}
.sf-lanechip .sf-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--sf-lane);}
.sf-lanechip .sf-num{color:var(--sf-fg4);font-variant-numeric:tabular-nums;}
.sf-lanechip.off{opacity:.42;}
.sf-lanechip.off .sf-lbl{text-decoration:line-through;}
.sf-legend{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--sf-fg3);}
.sf-legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}
.sf-legend i{display:inline-block;width:14px;border-top-width:2px;border-top-style:solid;}
.sf-zoom{display:inline-flex;align-items:center;gap:4px;}
.sf-zoom .sf-pct{min-width:42px;text-align:center;font-size:11.5px;color:var(--sf-fg2);font-variant-numeric:tabular-nums;}

/* body: canvas grid + drawer */
.sf-body{display:flex;flex:1;min-height:0;min-width:0;}
.sf-canvas-col{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;}
.sf-grid{display:grid;grid-template-columns:96px minmax(0,1fr);grid-template-rows:42px minmax(0,1fr);flex:1;min-height:0;min-width:0;}
.sf-corner{grid-column:1;grid-row:1;display:flex;align-items:center;justify-content:center;background:var(--sf-surface);border-right:1px solid var(--sf-border);border-bottom:1px solid var(--sf-border);font-size:11px;color:var(--sf-fg4);letter-spacing:.04em;}
.sf-headers-viewport{grid-column:2;grid-row:1;position:relative;overflow:hidden;background:var(--sf-surface);border-bottom:1px solid var(--sf-border);}
.sf-headers-inner{position:relative;height:42px;}
.sf-colhead{position:absolute;top:0;height:42px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:1px;padding:0 10px;border-left:1px solid var(--sf-border);overflow:hidden;}
.sf-colhead .sf-ct{font-size:12px;font-weight:600;color:var(--sf-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sf-colhead .sf-cs{font-size:10.5px;color:var(--sf-fg4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sf-colhead.is-final .sf-ct{color:var(--sf-accent);}
.sf-colhead.is-input .sf-ct{color:var(--sf-fg3);}
.sf-lanes-viewport{grid-column:1;grid-row:2;position:relative;overflow:hidden;background:var(--sf-surface);border-right:1px solid var(--sf-border);}
.sf-lanes-inner{position:relative;width:96px;}
.sf-lanelabel{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;border-bottom:1px solid var(--sf-border);cursor:pointer;overflow:hidden;user-select:none;}
.sf-lanelabel:hover{background:var(--sf-hover);}
.sf-lanelabel .sf-bar{position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--sf-lane);}
.sf-lanelabel .sf-ll-name{font-size:12px;font-weight:600;color:var(--sf-fg2);white-space:nowrap;}
.sf-lanelabel .sf-ll-count{font-size:10.5px;color:var(--sf-fg4);font-variant-numeric:tabular-nums;}
.sf-lanelabel.off{opacity:.45;}
.sf-lanelabel.off .sf-ll-name{text-decoration:line-through;}
.sf-canvas-viewport{grid-column:2;grid-row:2;position:relative;overflow:auto;min-width:0;min-height:0;overscroll-behavior:contain;}
.sf-canvas-spacer{position:relative;}
.sf-canvas{position:absolute;left:0;top:0;transform-origin:0 0;}
.sf-colband{position:absolute;top:0;bottom:0;border-right:1px solid var(--sf-border);box-sizing:border-box;}
.sf-colband.alt{background:rgba(127,127,127,.028);}
.sf-colband.is-final{background:rgba(47,111,228,.045);}
.sf-laneband{position:absolute;left:0;right:0;}
.sf-laneband.sf-lane-deliverable{background:var(--sf-lane-deliverable-soft);}
.sf-laneband.sf-lane-process{background:var(--sf-lane-process-soft);}
.sf-laneband.sf-lane-input{background:var(--sf-lane-input-soft);}
.sf-laneband.sf-lane-temp{background:var(--sf-lane-temp-soft);}
.sf-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;}

/* node card */
.sf-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:6px 8px;background:var(--sf-bg);border:1px solid var(--sf-border);border-left:3px solid var(--sf-lane,var(--sf-accent));border-radius:var(--sf-radius-sm);cursor:pointer;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05);transition:box-shadow .12s ease,border-color .12s ease;}
.sf-node:hover{border-color:var(--sf-border-strong);box-shadow:0 4px 14px rgba(0,0,0,.12);}
.sf-node.selected{border-color:var(--sf-accent);box-shadow:inset 0 0 0 1px var(--sf-accent),0 4px 14px rgba(0,0,0,.12);}
.sf-node.gone{opacity:.45;}
.sf-node.gone .sf-node-name{text-decoration:line-through;}
.sf-node:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--sf-accent));outline-offset:1px;}
.sf-node-top{display:flex;align-items:center;gap:5px;min-width:0;}
.sf-node-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--sf-fg);}
.sf-node-ext{flex:none;padding:0 4px;border-radius:4px;background:var(--sf-hover);color:var(--sf-fg4);font-size:9.5px;line-height:14px;text-transform:uppercase;letter-spacing:.04em;}
.sf-ov-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--sf-accent);box-shadow:0 0 0 2px var(--sf-bg);}
.sf-node-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--sf-fg4);min-width:0;}
.sf-node-dir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--sf-mono);font-size:10px;}
.sf-node-size{flex:none;font-variant-numeric:tabular-nums;}
.sf-node-foot{display:flex;align-items:center;gap:4px;min-height:8px;margin-top:auto;}
.sf-node-acts{display:flex;align-items:center;gap:3px;min-width:0;overflow:hidden;}
.sf-act-dot{width:6px;height:6px;border-radius:50%;flex:none;}
.sf-node-note{margin-left:auto;font-size:10px;color:var(--sf-fg4);}

/* status states */
.sf-status{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 24px;color:var(--sf-fg3);font-size:13px;text-align:center;}
.sf-status .sf-status-title{font-size:14px;font-weight:600;color:var(--sf-fg2);}
.sf-status .sf-status-hint{font-size:12px;color:var(--sf-fg4);max-width:420px;}
.sf-spin{width:18px;height:18px;border-radius:50%;border:2px solid var(--sf-border);border-top-color:var(--sf-accent);animation:sf-spin .9s linear infinite;}
@keyframes sf-spin{to{transform:rotate(360deg);}}
.sf-code{display:inline-block;padding:1px 6px;border-radius:5px;background:var(--sf-hover);color:var(--sf-fg2);font-family:var(--sf-mono);font-size:11.5px;}
.sf-errorline{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--sf-danger);}

/* drawer */
.sf-drawer{flex:none;display:flex;flex-direction:column;width:384px;min-height:0;border-left:1px solid var(--sf-border);background:var(--sf-bg);}
.sf-drawer-head{display:flex;align-items:flex-start;gap:8px;padding:12px 14px;border-bottom:1px solid var(--sf-border);background:var(--sf-surface);}
.sf-drawer-title{flex:1;min-width:0;}
.sf-drawer-title .sf-dt-name{font-size:13px;font-weight:650;word-break:break-all;}
.sf-drawer-title .sf-dt-path{font-family:var(--sf-mono);font-size:10.5px;color:var(--sf-fg4);word-break:break-all;margin-top:2px;}
.sf-drawer-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:12px 14px 18px;}
.sf-field{display:flex;flex-direction:column;gap:5px;min-width:0;}
.sf-field-label{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--sf-fg4);letter-spacing:.05em;text-transform:uppercase;}
.sf-field-value{font-size:12px;color:var(--sf-fg2);word-break:break-all;}
.sf-field-value.mono{font-family:var(--sf-mono);font-size:11.5px;}
.sf-kv{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11.5px;color:var(--sf-fg2);}
.sf-kv .sf-kv-item{display:inline-flex;gap:5px;align-items:baseline;}
.sf-kv .sf-kv-k{color:var(--sf-fg4);}
.sf-segmented{display:flex;flex-wrap:wrap;gap:5px;}
.sf-seg{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--sf-border);border-radius:999px;background:var(--sf-bg);color:var(--sf-fg2);font-family:inherit;font-size:11.5px;cursor:pointer;}
.sf-seg:hover{background:var(--sf-hover);}
.sf-seg.on{background:var(--sf-accent);border-color:transparent;color:#fff;}
.sf-seg .sf-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--sf-lane);}
.sf-seg.on .sf-dot{background:#fff;}
.sf-acts{display:flex;flex-direction:column;gap:3px;}
.sf-actrow{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--sf-fg2);}
.sf-actrow .sf-actdot{width:6px;height:6px;border-radius:50%;flex:none;}
.sf-actrow .sf-actname{font-family:var(--sf-mono);font-size:11px;}
.sf-actrow .sf-actmeta{margin-left:auto;color:var(--sf-fg4);font-variant-numeric:tabular-nums;}
.sf-note{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;padding:8px;border:1px solid var(--sf-border);border-radius:var(--sf-radius-sm);background:var(--sf-surface);color:var(--sf-fg);font-family:inherit;font-size:12px;line-height:1.45;}
.sf-note:focus{outline:none;border-color:var(--sf-accent);}
.sf-drawer-actions{display:flex;flex-wrap:wrap;gap:6px;}
.sf-pre{margin:0;max-height:400px;overflow:auto;padding:8px;border:1px solid var(--sf-border);border-radius:var(--sf-radius-sm);background:var(--sf-surface);color:var(--sf-fg2);font-family:var(--sf-mono);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
.sf-hint{font-size:11.5px;color:var(--sf-fg4);}
.sf-mini{padding:0 6px;height:20px;border:1px solid var(--sf-border);border-radius:5px;background:var(--sf-bg);color:var(--sf-fg3);font-family:inherit;font-size:10.5px;cursor:pointer;margin-left:auto;}

/* toast */
.sf-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:80%;padding:8px 14px;border-radius:999px;background:var(--sf-fg);color:var(--sf-bg);font-size:12px;box-shadow:0 10px 28px rgba(0,0,0,.28);z-index:2;}
.sf-toast .sf-toast-code{font-family:var(--sf-mono);font-size:10.5px;opacity:.75;}
.sf-toast.info{background:var(--sf-surface);color:var(--sf-fg2);border:1px solid var(--sf-accent);box-shadow:0 10px 28px rgba(0,0,0,.18);}
.sf-toast.error{background:var(--sf-danger);color:#fff;}
.sf-nodelimit{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:1px solid var(--sf-warn);border-radius:999px;background:rgba(196,127,0,.08);color:var(--sf-warn);font-size:11px;white-space:nowrap;}
.sf-nodelimit::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--sf-warn);}

/* scrollbars */
.sf-canvas-viewport::-webkit-scrollbar,.sf-drawer-body::-webkit-scrollbar,.sf-pre::-webkit-scrollbar{width:10px;height:10px;}
.sf-canvas-viewport::-webkit-scrollbar-thumb,.sf-drawer-body::-webkit-scrollbar-thumb,.sf-pre::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,var(--sf-border));border-radius:999px;border:2px solid transparent;background-clip:content-box;}
.sf-canvas-viewport::-webkit-scrollbar-thumb:hover,.sf-drawer-body::-webkit-scrollbar-thumb:hover,.sf-pre::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,var(--sf-border-strong));background-clip:content-box;}
`;

      // ---------------------------------------------------------------------
      // icons
      // ---------------------------------------------------------------------

      const TREE_ICON = h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4.5 3.5v8.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M4.5 6.5h3.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M4.5 11.5h3.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('rect', { x: 2.6, y: 1.6, width: 3.8, height: 3.8, rx: 1.1, fill: 'currentColor' }),
        h('rect', { x: 7.7, y: 4.6, width: 3.8, height: 3.8, rx: 1.1, fill: 'currentColor' }),
        h('rect', { x: 7.7, y: 9.6, width: 3.8, height: 3.8, rx: 1.1, fill: 'currentColor' }),
      );

      function styleTag() {
        return h('style', { key: 'sf-css', dangerouslySetInnerHTML: { __html: CSS } });
      }

      // ---------------------------------------------------------------------
      // slot 1: composer button (props.sessionId)
      // ---------------------------------------------------------------------

      function buttonSessionId(props) {
        if (!props || typeof props !== 'object') return null;
        const candidates = [props.sessionId, props.sessionID, props.session && props.session.id, props.sessionIdValue];
        for (let i = 0; i < candidates.length; i++) {
          const value = candidates[i];
          if (typeof value === 'string' && value) return value;
        }
        return null;
      }

      function SessionFilesButton(props) {
        useLang();
        const sessionId = buttonSessionId(props);
        const label = t('btn.open');
        const onClick = useCallback(
          function (event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (sessionId) setOpen(sessionId);
          },
          [sessionId],
        );
        return h(
          React.Fragment,
          null,
          styleTag(),
          h(
            'button',
            {
              type: 'button',
              className: 'sf-open-btn sf-root',
              title: label,
              'aria-label': label,
              disabled: !sessionId,
              onClick: onClick,
            },
            TREE_ICON,
          ),
        );
      }

      // ---------------------------------------------------------------------
      // slot 2: overlay
      // ---------------------------------------------------------------------

      function SessionFilesOverlay() {
        const snap = useOpenSnapshot();
        if (!snap.open || !snap.sessionId) return null;
        return h(SessionFilesPanel, { key: snap.sessionId, sessionId: snap.sessionId });
      }

      function nodeTitle(node) {
        const parts = [String(node && node.path ? node.path : '')];
        if (node && node.dir) parts.push(String(node.dir));
        if (node && typeof node.note === 'string' && node.note) parts.push(node.note);
        if (node && node.exists === false) parts.push(t('node.gone'));
        return parts.join('\n');
      }

      function NodeCard(props) {
        useLang();
        const node = props.node;
        const lane = LANE_SET[node.lane] ? node.lane : 'process';
        const classes = ['sf-node', 'sf-lane-' + lane];
        if (props.selected) classes.push('selected');
        if (node.exists === false) classes.push('gone');

        const dots = [];
        const seen = {};
        const actions = Array.isArray(node.actions) ? node.actions : [];
        for (let i = 0; i < actions.length; i++) {
          const action = actions[i] || {};
          const key = String(action.action || '');
          if (!key || seen[key]) continue;
          seen[key] = true;
          dots.push(
            h('span', {
              key: 'act-' + key,
              className: 'sf-act-dot',
              title: key + (action.turn ? ' · #' + action.turn : ''),
              style: { backgroundColor: actionColor(key) },
            }),
          );
        }
        if (dots.length === 0 && node.kind === 'final') {
          dots.push(h('span', { key: 'act-present', className: 'sf-act-dot', title: 'present', style: { backgroundColor: actionColor('present') } }));
        }

        return h(
          'div',
          {
            className: classes.join(' '),
            role: 'button',
            tabIndex: 0,
            title: nodeTitle(node),
            style: { left: node.x + 'px', top: node.y + 'px', width: node.w + 'px', height: node.h + 'px' },
            onClick: function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
              props.onSelect(node.id);
            },
            onKeyDown: function (event) {
              if (!event) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.onSelect(node.id);
              }
            },
          },
          h(
            'div',
            { className: 'sf-node-top' },
            h('span', { className: 'sf-node-name' }, String(node.name || node.path || '')),
            node.ext ? h('span', { className: 'sf-node-ext' }, String(node.ext)) : null,
            node.overridden ? h('span', { className: 'sf-ov-dot', title: t('tag.overridden') }) : null,
          ),
          h(
            'div',
            { className: 'sf-node-meta' },
            h('span', { className: 'sf-node-dir' }, node.dir ? String(node.dir) : '·'),
            h('span', { className: 'sf-node-size' }, fmtSize(node.size)),
          ),
          h(
            'div',
            { className: 'sf-node-foot' },
            h('span', { className: 'sf-node-acts' }, dots),
            node.note ? h('span', { className: 'sf-node-note', title: String(node.note) }, '✎') : null,
          ),
        );
      }

      function EdgeLayer(props) {
        const laid = props.edges || [];
        const paths = [];
        for (let i = 0; i < laid.length; i++) {
          const edge = laid[i];
          const kind = String(edge.kind || 'origin');
          let stroke = 'var(--sf-fg4,#9aa0aa)';
          let strokeWidth = 1.2;
          let dash = null;
          let opacity = 0.9;
          if (kind === 'evolution') {
            stroke = 'var(--sf-accent,#2f6fe4)';
            strokeWidth = 1.6;
            opacity = 0.75;
          } else if (kind === 'derived') {
            stroke = 'var(--sf-fg3,#838893)';
            strokeWidth = 1.2;
            dash = '5 4';
            opacity = 0.7;
          } else if (kind === 'deliverable') {
            stroke = 'var(--sf-accent,#2f6fe4)';
            strokeWidth = 2.6;
            opacity = 0.95;
          }
          paths.push(
            h('path', {
              key: 'e-' + i,
              d: edge.path,
              fill: 'none',
              stroke: stroke,
              strokeWidth: strokeWidth,
              strokeDasharray: dash || undefined,
              strokeLinecap: 'round',
              opacity: opacity,
            }),
          );
        }
        return h(
          'svg',
          {
            className: 'sf-edges',
            width: props.width,
            height: props.height,
            viewBox: '0 0 ' + props.width + ' ' + props.height,
            'aria-hidden': 'true',
            focusable: 'false',
          },
          paths,
        );
      }

      function DetailDrawer(props) {
        useLang();
        const node = props.node;
        const lang = getLang();

        const [draftCls, setDraftCls] = useState(node.cls || node.lane || 'process');
        const [draftNote, setDraftNote] = useState(typeof node.note === 'string' ? node.note : '');
        const [pending, setPending] = useState(null);
        const [opError, setOpError] = useState(null);
        const [preview, setPreview] = useState({ status: 'idle', text: '', binary: false, bytes: 0, truncated: false, code: null });
        const previewReq = useRef(0);

        useEffect(
          function () {
            setDraftCls(node.cls || node.lane || 'process');
          },
          [node.id, node.cls, node.lane],
        );
        useEffect(
          function () {
            setDraftNote(typeof node.note === 'string' ? node.note : '');
          },
          [node.id, node.note],
        );
        useEffect(
          function () {
            setOpError(null);
          },
          [node.id],
        );

        const runPreview = useCallback(
          function () {
            const rid = previewReq.current + 1;
            previewReq.current = rid;
            setPreview({ status: 'loading', text: '', binary: false, bytes: 0, truncated: false, code: null });
            props
              .preview(node.path)
              .then(function (body) {
                if (previewReq.current !== rid) return;
                setPreview({
                  status: 'ready',
                  text: typeof body.text === 'string' ? body.text : '',
                  binary: body.binary === true,
                  bytes: Number(body.bytes) || 0,
                  truncated: body.truncated === true,
                  code: null,
                });
              })
              .catch(function (error) {
                if (previewReq.current !== rid) return;
                setPreview({ status: 'error', text: '', binary: false, bytes: 0, truncated: false, code: errCode(error) });
              });
          },
          [props.preview, node.path],
        );

        useEffect(
          function () {
            runPreview();
          },
          [runPreview],
        );
        useEffect(
          function () {
            return function () {
              previewReq.current += 1;
            };
          },
          [],
        );

        const autoCls = node.autoCls || node.lane || 'process';
        const isTemp = (node.cls || node.lane) === 'temp';

        function onSave() {
          if (pending) return;
          setPending('save');
          setOpError(null);
          // Picking the automatic class means "no override", so send null.
          const payloadCls = draftCls === autoCls ? null : draftCls;
          props
            .onClassify(node.path, payloadCls, draftNote)
            .then(function () {
              setPending(null);
              props.onNotice(t('toast.saved'));
            })
            .catch(function (error) {
              setPending(null);
              setOpError(errCode(error));
            });
        }

        function onReset() {
          if (pending) return;
          setPending('reset');
          setOpError(null);
          // Drop the override but keep the stored note: `note` is omitted on purpose.
          props
            .onClassify(node.path, null)
            .then(function () {
              setPending(null);
              props.onNotice(t('toast.saved'));
            })
            .catch(function (error) {
              setPending(null);
              setOpError(errCode(error));
            });
        }

        function onDelete() {
          if (pending) return;
          if (!confirmFn(t('confirm.delete', { n: 1 }))) return;
          setPending('delete');
          setOpError(null);
          props
            .onDelete([node.path])
            .then(function (body) {
              setPending(null);
              const skipped = body && Array.isArray(body.skipped) ? body.skipped : [];
              // Skipped files are an informational outcome, not an error.
              if (skipped.length > 0) props.onNotice(t('toast.skipped', { n: skipped.length }), null, 'info');
              else props.onNotice(t('toast.deleted', { n: 1 }));
            })
            .catch(function (error) {
              setPending(null);
              setOpError(errCode(error));
            });
        }

        const laneButtons = LANES.map(function (lane) {
          const on = draftCls === lane;
          return h(
            'button',
            {
              key: 'seg-' + lane,
              type: 'button',
              className: 'sf-seg sf-lane-' + lane + (on ? ' on' : ''),
              onClick: function () {
                setDraftCls(lane);
              },
            },
            h('span', { className: 'sf-dot' }),
            t('lane.' + lane),
          );
        });

        const actionRows = (Array.isArray(node.actions) ? node.actions : []).map(function (action, index) {
          const item = action || {};
          return h(
            'div',
            { className: 'sf-actrow', key: 'actrow-' + index },
            h('span', { className: 'sf-actdot', style: { backgroundColor: actionColor(item.action) } }),
            h('span', { className: 'sf-actname' }, String(item.tool || item.action || '—')),
            h(
              'span',
              { className: 'sf-actmeta' },
              item.turn ? '#' + item.turn : '',
              item.time ? ' · ' + fmtClock(item.time, lang) : '',
            ),
          );
        });

        const previewBlock = (function () {
          if (preview.status === 'loading') return h('div', { className: 'sf-hint' }, t('preview.loading'));
          if (preview.status === 'error') {
            return h('div', { className: 'sf-errorline' }, t('error.network'), h('span', { className: 'sf-code' }, preview.code || 'unknown'));
          }
          if (preview.status === 'idle') return h('div', { className: 'sf-hint' }, '—');
          if (preview.binary) return h('div', { className: 'sf-hint' }, t('preview.binary') + ' · ' + fmtSize(preview.bytes));
          return h('pre', { className: 'sf-pre' }, preview.text || t('preview.empty'));
        })();

        return h(
          'aside',
          { className: 'sf-drawer sf-root', onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation(); } },
          h(
            'div',
            { className: 'sf-drawer-head' },
            h(
              'div',
              { className: 'sf-drawer-title' },
              h('div', { className: 'sf-dt-name' }, String(node.name || node.path || '')),
              h('div', { className: 'sf-dt-path' }, String(node.path || '')),
            ),
            h(
              'button',
              { type: 'button', className: 'sf-tbtn icon', title: t('action.close'), onClick: props.onClose },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'sf-drawer-body' },
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-field-label' }, t('label.lane')),
              h('div', { className: 'sf-segmented' }, laneButtons),
            ),
            h(
              'div',
              { className: 'sf-field' },
              h(
                'div',
                { className: 'sf-field-label' },
                t('label.auto'),
                node.overridden ? h('span', { className: 'sf-chip' }, t('tag.overridden')) : null,
              ),
              h(
                'div',
                { className: 'sf-field-value' },
                t('lane.' + (LANE_SET[autoCls] ? autoCls : 'process')) + ' · ' + reasonText(node.reason),
              ),
            ),
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-field-label' }, t('label.path')),
              h('div', { className: 'sf-field-value mono' }, String(node.path || '—')),
            ),
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-field-label' }, t('label.size') + ' / ' + t('label.mtime') + ' / ' + t('label.turns')),
              h(
                'div',
                { className: 'sf-kv' },
                h('span', { className: 'sf-kv-item' }, h('span', { className: 'sf-kv-k' }, t('label.size')), fmtSize(node.size)),
                h('span', { className: 'sf-kv-item' }, h('span', { className: 'sf-kv-k' }, t('label.mtime')), fmtDateTime(node.mtime, lang)),
                h(
                  'span',
                  { className: 'sf-kv-item' },
                  h('span', { className: 'sf-kv-k' }, t('label.turns')),
                  Array.isArray(node.turns) && node.turns.length ? node.turns.join(', ') : '—',
                ),
              ),
            ),
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-field-label' }, t('label.actions')),
              actionRows.length ? h('div', { className: 'sf-acts' }, actionRows) : h('div', { className: 'sf-hint' }, '—'),
            ),
            h(
              'div',
              { className: 'sf-field' },
              h('div', { className: 'sf-field-label' }, t('label.note')),
              h('textarea', {
                className: 'sf-note',
                value: draftNote,
                placeholder: t('note.ph'),
                onChange: function (event) {
                  setDraftNote(event && event.target ? String(event.target.value) : '');
                },
              }),
            ),
            h(
              'div',
              { className: 'sf-drawer-actions' },
              h(
                'button',
                { type: 'button', className: 'sf-tbtn primary', disabled: !!pending, onClick: onSave },
                pending === 'save' ? '…' : t('action.save'),
              ),
              h(
                'button',
                { type: 'button', className: 'sf-tbtn', disabled: !!pending, onClick: onReset },
                pending === 'reset' ? '…' : t('action.reset'),
              ),
              isTemp
                ? h(
                    'button',
                    { type: 'button', className: 'sf-tbtn danger', disabled: !!pending, onClick: onDelete },
                    pending === 'delete' ? '…' : t('action.delete'),
                  )
                : null,
            ),
            opError
              ? h(
                  'div',
                  { className: 'sf-errorline' },
                  t('error.op'),
                  h('span', { className: 'sf-code' }, opError),
                )
              : null,
            h(
              'div',
              { className: 'sf-field' },
              h(
                'div',
                { className: 'sf-field-label' },
                t('label.preview'),
                h('button', { type: 'button', className: 'sf-mini', onClick: runPreview }, t('action.retry')),
              ),
              previewBlock,
              preview.status === 'ready' && preview.truncated ? h('div', { className: 'sf-hint' }, t('preview.truncated')) : null,
            ),
          ),
        );
      }

      // Distinct temp-file paths that actually have nodes in the tree.
      function collectTempPaths(nodes) {
        const out = [];
        if (!Array.isArray(nodes)) return out;
        const seen = new Set();
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node || node.lane !== 'temp') continue;
          const path = node.path;
          if (typeof path !== 'string' || !path || seen.has(path)) continue;
          seen.add(path);
          out.push(path);
        }
        return out;
      }

      // Distinct temp paths scanned on disk but never touched by a tool call.
      function collectBacklog(ledger) {
        const out = [];
        const ws = ledger && ledger.workspace && typeof ledger.workspace === 'object' ? ledger.workspace : null;
        if (!ws || !Array.isArray(ws.tempPaths)) return out;
        const seen = new Set();
        for (let i = 0; i < ws.tempPaths.length; i++) {
          const path = ws.tempPaths[i];
          if (typeof path !== 'string' || !path || seen.has(path)) continue;
          seen.add(path);
          out.push(path);
        }
        return out;
      }

      function unionPaths(first, second) {
        const out = [];
        const seen = new Set();
        const lists = [first, second];
        for (let i = 0; i < lists.length; i++) {
          const list = lists[i];
          if (!Array.isArray(list)) continue;
          for (let j = 0; j < list.length; j++) {
            const path = list[j];
            if (typeof path !== 'string' || !path || seen.has(path)) continue;
            seen.add(path);
            out.push(path);
          }
        }
        return out;
      }

      function SessionFilesPanel(props) {
        useLang();
        const sessionId = props.sessionId;

        const [loadState, setLoadState] = useState({ status: 'loading', ledger: null, code: null });
        const [selectedId, setSelectedId] = useState(null);
        const [hiddenLanes, setHiddenLanes] = useState({});
        const [zoom, setZoom] = useState(1);
        const [toast, setToast] = useState(null);
        const [busy, setBusy] = useState(false);
        const [unfoldOpen, setUnfoldOpen] = useState(false);

        const reqRef = useRef(0);
        const ledgerRef = useRef(null);
        const toastTimer = useRef(null);
        const scrollRef = useRef(null);
        const headerRef = useRef(null);
        const lanesRef = useRef(null);

        const showToast = useCallback(function (text, code, tone) {
          setToast({ text: text, code: code || null, tone: tone || null });
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(function () {
            toastTimer.current = null;
            setToast(null);
          }, 5000);
        }, []);

        useEffect(
          function () {
            return function () {
              if (toastTimer.current) clearTimeout(toastTimer.current);
            };
          },
          [],
        );

        const applyLedger = useCallback(function (ledger) {
          ledgerRef.current = ledger || null;
          setLoadState({ status: 'ready', ledger: ledger || null, code: null });
        }, []);

        const load = useCallback(
          function () {
            const rid = reqRef.current + 1;
            reqRef.current = rid;
            setLoadState(function (prev) {
              return { status: 'loading', ledger: prev.ledger, code: null };
            });
            apiGet('/ledger', { sessionId: sessionId })
              .then(function (body) {
                if (reqRef.current !== rid) return;
                ledgerRef.current = body.ledger || null;
                setLoadState({ status: 'ready', ledger: body.ledger || null, code: null });
              })
              .catch(function (error) {
                if (reqRef.current !== rid) return;
                const code = errCode(error);
                const hadLedger = !!ledgerRef.current;
                setLoadState(function (prev) {
                  if (prev.ledger) {
                    // Keep the last good tree; surface the failure as a toast.
                    return { status: 'ready', ledger: prev.ledger, code: null };
                  }
                  return { status: 'error', ledger: null, code: code };
                });
                if (hadLedger) showToast(t('error.network'), code);
              });
          },
          [sessionId, showToast],
        );

        useEffect(
          function () {
            load();
          },
          [load],
        );

        // Esc: close the drawer first, then the overlay.
        useEffect(
          function () {
            function onKeyDown(event) {
              if (!event) return;
              const key = event.key || '';
              if (key !== 'Escape' && key !== 'Esc' && event.keyCode !== 27) return;
              if (event.isComposing) return;
              if (unfoldOpen) {
                setUnfoldOpen(false);
              } else if (selectedId) {
                setSelectedId(null);
              } else {
                closeOverlay();
              }
            }
            window.addEventListener('keydown', onKeyDown, true);
            return function () {
              window.removeEventListener('keydown', onKeyDown, true);
            };
          },
          [selectedId, unfoldOpen],
        );

        // New session: back to the top-left of the canvas.
        useEffect(
          function () {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = 0;
              scrollRef.current.scrollLeft = 0;
            }
            if (headerRef.current) headerRef.current.style.transform = 'translate3d(0,0,0)';
            if (lanesRef.current) lanesRef.current.style.transform = 'translate3d(0,0,0)';
          },
          [sessionId],
        );

        const onScroll = useCallback(function (event) {
          const el = event && event.currentTarget ? event.currentTarget : null;
          if (!el) return;
          if (headerRef.current) headerRef.current.style.transform = 'translate3d(' + -el.scrollLeft + 'px,0,0)';
          if (lanesRef.current) lanesRef.current.style.transform = 'translate3d(0,' + -el.scrollTop + 'px,0)';
        }, []);

        const classify = useCallback(
          function (path, cls, note) {
            const payload = { sessionId: sessionId, path: path, cls: cls };
            // Omitting `note` keeps the stored note (CONTRACT §6); null clears it.
            if (note !== undefined) payload.note = note;
            return apiPost('/classify', payload).then(function (body) {
              if (body && body.ledger) applyLedger(body.ledger);
              return body;
            });
          },
          [sessionId, applyLedger],
        );

        const deletePaths = useCallback(
          function (paths) {
            return apiPost('/delete', { sessionId: sessionId, paths: paths }).then(function (body) {
              if (body && body.ledger) applyLedger(body.ledger);
              return body;
            });
          },
          [sessionId, applyLedger],
        );

        const previewApi = useCallback(
          function (path) {
            return apiGet('/preview', { sessionId: sessionId, path: path, maxBytes: PREVIEW_MAX_BYTES });
          },
          [sessionId],
        );

        const onCleanup = useCallback(
          function () {
            const ledger = loadState.ledger;
            if (!ledger) return;
            const treeTemp = collectTempPaths(ledger.nodes);
            const backlog = collectBacklog(ledger);
            const localTargets = unionPaths(treeTemp, backlog);
            if (localTargets.length === 0) {
              showToast(t('cleanup.none'));
              return;
            }
            setBusy(true);
            // Step 1: ask the host what scope='all' would delete (authoritative count).
            apiPost('/delete', { sessionId: sessionId, scope: 'all', dryRun: true })
              .catch(function () {
                // Older host without dryRun/scope support: fall back to the local estimate.
                return null;
              })
              .then(function (body) {
                const authoritative = !!(body && body.dryRun === true && Array.isArray(body.deleted));
                let targets;
                let historical;
                if (authoritative) {
                  const seen = new Set();
                  targets = [];
                  for (let i = 0; i < body.deleted.length; i++) {
                    const path = body.deleted[i];
                    if (typeof path !== 'string' || !path || seen.has(path)) continue;
                    seen.add(path);
                    targets.push(path);
                  }
                  const treeSet = new Set(treeTemp);
                  historical = 0;
                  for (let i = 0; i < targets.length; i++) {
                    if (!treeSet.has(targets[i])) historical += 1;
                  }
                } else {
                  targets = localTargets;
                  historical = backlog.length;
                }
                if (targets.length === 0) {
                  showToast(t('cleanup.none'));
                  return null;
                }
                if (!confirmFn(t('confirm.cleanupAll', { n: targets.length, m: historical }))) return null;
                // Step 2: for real.
                return apiPost('/delete', { sessionId: sessionId, scope: 'all', paths: targets }).then(function (response) {
                  const result = response || {};
                  if (result.ledger) applyLedger(result.ledger);
                  const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
                  const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
                  let text;
                  if (deleted > 0 && historical > 0) text = t('toast.cleanedAll', { n: deleted, m: historical });
                  else if (deleted > 0) text = t('toast.cleaned', { n: deleted });
                  else text = t('cleanup.none');
                  if (skipped > 0) text += ' · ' + t('toast.skipped', { n: skipped });
                  showToast(text);
                  if (!result.ledger) load();
                });
              })
              .catch(function (error) {
                showToast(t('error.op'), errCode(error));
              })
              .then(function () {
                setBusy(false);
              });
          },
          [loadState, sessionId, applyLedger, load, showToast],
        );

        const ledger = loadState.ledger;
        const nodes = ledger && Array.isArray(ledger.nodes) ? ledger.nodes : [];
        const edges = ledger && Array.isArray(ledger.edges) ? ledger.edges : [];
        const columns = ledger && Array.isArray(ledger.columns) ? ledger.columns : [];
        const laneOrder = ledger && Array.isArray(ledger.lanes) && ledger.lanes.length > 0 ? ledger.lanes : LANES;
        const countsSrc = ledger && ledger.counts && typeof ledger.counts === 'object' ? ledger.counts : {};
        const warnings = ledger && Array.isArray(ledger.warnings) ? ledger.warnings : [];
        // Host truncated the ledger because the session is huge: turns are missing.
        const nodeLimitHit = warnings.indexOf('node-limit') >= 0;
        const isLoading = loadState.status === 'loading';
        const isError = loadState.status === 'error';
        const workspaceInfo = ledger && ledger.workspace && typeof ledger.workspace === 'object' ? ledger.workspace : null;

        // Distinct file paths present in the tree (file-level, one per path).
        const treePaths = useMemo(
          function () {
            const out = new Set();
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              if (node && typeof node.path === 'string' && node.path) out.add(node.path);
            }
            return out;
          },
          [nodes],
        );

        // Temp files scanned but never touched by a tool call (no node in the tree).
        const backlogPaths = useMemo(
          function () {
            return collectBacklog(ledger);
          },
          [ledger],
        );

        const fileCount = typeof countsSrc.files === 'number' ? countsSrc.files : treePaths.size;
        const expandedFiles = treePaths.size;
        const unexpandedFiles = fileCount > expandedFiles ? fileCount - expandedFiles : 0;
        const backlogCount =
          workspaceInfo && typeof workspaceInfo.tempPathCount === 'number' && workspaceInfo.tempPathCount >= 0
            ? Math.floor(workspaceInfo.tempPathCount)
            : backlogPaths.length;
        const unfoldTotal = workspaceInfo ? (backlogCount > 0 ? backlogCount : unexpandedFiles) : 0;
        const canUnfold = !!workspaceInfo && unfoldTotal > 0;
        const unfoldShown = backlogPaths.slice(0, UNFOLD_PREVIEW);
        const unfoldMore = !!workspaceInfo && (unfoldTotal > unfoldShown.length || workspaceInfo.truncated === true);

        const visibleNodes = useMemo(
          function () {
            return nodes.filter(function (node) {
              return !(node && hiddenLanes[node.lane]);
            });
          },
          [nodes, hiddenLanes],
        );

        const laneMins = useMemo(
          function () {
            const out = {};
            for (let i = 0; i < laneOrder.length; i++) {
              const lane = laneOrder[i];
              if (hiddenLanes[lane]) out[lane] = 44;
            }
            return out;
          },
          [laneOrder, hiddenLanes],
        );

        const lay = useMemo(
          function () {
            return layout(visibleNodes, edges, {
              lanes: laneOrder,
              minColumns: columns.length,
              laneMinHeight: LAYOUT_DEFAULTS.laneMinHeight,
              laneMinHeightByLane: laneMins,
            });
          },
          [visibleNodes, edges, laneOrder, columns.length, laneMins],
        );

        const laneCounts = useMemo(
          function () {
            const out = {};
            for (let i = 0; i < laneOrder.length; i++) out[laneOrder[i]] = 0;
            for (let j = 0; j < nodes.length; j++) {
              const node = nodes[j];
              if (!node) continue;
              const lane = node.lane;
              if (Object.prototype.hasOwnProperty.call(out, lane)) out[lane] += 1;
            }
            return out;
          },
          [laneOrder, nodes],
        );

        const selectedNode = useMemo(
          function () {
            if (!selectedId) return null;
            for (let i = 0; i < nodes.length; i++) {
              if (nodes[i] && nodes[i].id === selectedId) return nodes[i];
            }
            return null;
          },
          [nodes, selectedId],
        );

        useEffect(
          function () {
            if (selectedId && !selectedNode) setSelectedId(null);
          },
          [selectedId, selectedNode],
        );

        function toggleLane(lane) {
          setHiddenLanes(function (prev) {
            const next = Object.assign({}, prev);
            if (next[lane]) delete next[lane];
            else next[lane] = true;
            return next;
          });
        }

        function toggleUnfold() {
          setUnfoldOpen(function (prev) {
            return !prev;
          });
        }

        function setZoomBy(delta) {
          setZoom(function (prev) {
            const next = Math.round((prev + delta) * 100) / 100;
            return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
          });
        }

        function resetZoom() {
          setZoom(1);
        }

        const header = h(
          'div',
          { className: 'sf-header' },
          h('div', { className: 'sf-title' }, t('title')),
          h('div', { className: 'sf-spacer' }),
          h(
            'button',
            { type: 'button', className: 'sf-tbtn', disabled: isLoading, onClick: load },
            t('action.refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sf-tbtn danger',
              disabled: !ledger || isLoading || busy,
              title: busy ? t('toast.cleaning') : t('action.cleanup'),
              onClick: onCleanup,
            },
            busy ? t('toast.cleaning') : t('action.cleanup'),
          ),
          h(
            'button',
            { type: 'button', className: 'sf-tbtn icon', title: t('action.close'), 'aria-label': t('action.close'), onClick: closeOverlay },
            '×',
          ),
        );

        const subChips = [
          h(
            'span',
            { className: 'sf-chip mono', key: 'session' },
            h('b', null, t('label.session')),
            shortId(sessionId),
          ),
          h(
            'span',
            { className: 'sf-chip', key: 'source' },
            h('b', null, t('label.source')),
            ledger ? (ledger.source === 'log' ? t('source.log') : t('source.live')) : '—',
          ),
          h(
            'span',
            { className: 'sf-chip', key: 'generated' },
            h('b', null, t('label.generated')),
            ledger ? fmtDateTime(ledger.generatedAt) : '—',
          ),
          h(
            'span',
            { className: 'sf-chip', key: 'workspace', title: ledger && ledger.workspacePath ? String(ledger.workspacePath) : '' },
            h('b', null, t('label.workspace')),
            ledger && ledger.workspacePath ? String(ledger.workspacePath) : t('label.unknown'),
          ),
        ];

        // 'node-limit' gets its own dedicated chip in the counts row.
        const otherWarnings = warnings.filter(function (code) {
          return code !== 'node-limit';
        });
        if (otherWarnings.length > 0) {
          subChips.push(h('span', { className: 'sf-warn', key: 'warnings' }, t('label.warnings') + ': ' + otherWarnings.join(', ')));
        }

        const sub = h('div', { className: 'sf-sub' }, subChips);

        // File-level counts (workspace) vs view-level nodes (session-touched) must never be
        // mixed: the host may scan far more temp files than any tool call ever touched.
        const countLanes = laneOrder.map(function (lane) {
          const safeLane = LANE_SET[lane] ? lane : 'process';
          const count = typeof countsSrc[lane] === 'number' ? countsSrc[lane] : laneCounts[safeLane] || 0;
          return h(
            'span',
            { key: 'countlane-' + lane, className: 'sf-clane sf-lane-' + safeLane, title: t('lane.' + safeLane) },
            h('i', null),
            t('lane.' + safeLane),
            h('b', null, String(count)),
          );
        });

        const unfoldPopover =
          canUnfold && unfoldOpen
            ? h(
                'div',
                { className: 'sf-pop', role: 'dialog', 'aria-label': t('counts.unfold', { n: unfoldTotal }) },
                h(
                  'div',
                  { className: 'sf-pop-head' },
                  h('span', null, t('counts.unfold', { n: unfoldTotal })),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sf-tbtn icon',
                      title: t('action.close'),
                      'aria-label': t('action.close'),
                      onClick: function () {
                        setUnfoldOpen(false);
                      },
                    },
                    '×',
                  ),
                ),
                h('div', { className: 'sf-pop-hint' }, t('counts.unfold.hint')),
                unfoldShown.length > 0
                  ? h(
                      'ul',
                      { className: 'sf-pop-list' },
                      unfoldShown.map(function (path, index) {
                        return h('li', { key: 'backlog-' + index, className: 'sf-pop-item', title: String(path) }, String(path));
                      }),
                    )
                  : null,
                unfoldMore
                  ? h(
                      'div',
                      { className: 'sf-pop-more' },
                      workspaceInfo && workspaceInfo.truncated === true
                        ? t('counts.unfold.truncated')
                        : t('counts.unfold.seen', { shown: unfoldShown.length }) +
                            ' · ' +
                            t('counts.unfold.more', { n: unfoldTotal }),
                    )
                  : null,
              )
            : null;

        const countsRow = h(
          'div',
          { className: 'sf-counts' },
          h('span', { className: 'sf-cstat' }, h('b', null, t('counts.workspace')), t('counts.files', { n: fileCount })),
          h('span', { className: 'sf-sep' }, '·'),
          h('span', { className: 'sf-clanes' }, countLanes),
          h('span', { className: 'sf-spacer' }),
          h('span', { className: 'sf-cstat' }, h('b', null, t('counts.tree')), t('counts.nodes', { n: nodes.length })),
          h('span', { className: 'sf-csub' }, t('counts.tree.hint')),
          nodeLimitHit
            ? h('span', { className: 'sf-nodelimit', key: 'nodelimit', title: t('counts.nodeLimit') }, t('counts.nodeLimit'))
            : null,
          canUnfold
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sf-unfoldbtn',
                  title: t('counts.unfold.hint'),
                  'aria-expanded': unfoldOpen ? 'true' : 'false',
                  onClick: toggleUnfold,
                },
                t('counts.unfold', { n: unfoldTotal }),
              )
            : null,
          unfoldPopover,
        );

        const laneChips = laneOrder.map(function (lane) {
          const off = !!hiddenLanes[lane];
          return h(
            'button',
            {
              key: 'lanechip-' + lane,
              type: 'button',
              className: 'sf-lanechip sf-lane-' + (LANE_SET[lane] ? lane : 'process') + (off ? ' off' : ''),
              title: t('label.lane.filter'),
              onClick: function () {
                toggleLane(lane);
              },
            },
            h('span', { className: 'sf-dot' }),
            h('span', { className: 'sf-lbl' }, t('lane.' + lane)),
            h('span', { className: 'sf-num' }, String(laneCounts[lane] || 0)),
          );
        });

        const legend = h(
          'div',
          { className: 'sf-legend' },
          h('span', { key: 'l-origin' }, h('i', { style: { borderTopColor: 'var(--sf-fg4,#9aa0aa)' } }), t('edge.origin')),
          h('span', { key: 'l-evolution' }, h('i', { style: { borderTopColor: 'var(--sf-accent,#2f6fe4)' } }), t('edge.evolution')),
          h(
            'span',
            { key: 'l-derived' },
            h('i', { style: { borderTopColor: 'var(--sf-fg3,#838893)', borderTopStyle: 'dashed' } }),
            t('edge.derived'),
          ),
          h('span', { key: 'l-deliverable' }, h('i', { style: { borderTopColor: 'var(--sf-accent,#2f6fe4)', borderTopWidth: '3px' } }), t('edge.deliverable')),
        );

        const toolbar = h(
          'div',
          { className: 'sf-toolbar' },
          laneChips,
          h('div', { className: 'sf-spacer' }),
          legend,
          h(
            'div',
            { className: 'sf-zoom' },
            h('button', { type: 'button', className: 'sf-tbtn icon', title: t('zoom.out'), onClick: function () { setZoomBy(-ZOOM_STEP); } }, '−'),
            h('span', { className: 'sf-pct' }, Math.round(zoom * 100) + '%'),
            h('button', { type: 'button', className: 'sf-tbtn icon', title: t('zoom.in'), onClick: function () { setZoomBy(ZOOM_STEP); } }, '+'),
            h('button', { type: 'button', className: 'sf-tbtn', title: t('zoom.reset'), onClick: resetZoom }, '1:1'),
          ),
        );

        function renderStatus() {
          if (isLoading) {
            return h(
              'div',
              { className: 'sf-status' },
              h('div', { className: 'sf-spin' }),
              h('div', null, t('loading')),
            );
          }
          return h(
            'div',
            { className: 'sf-status' },
            h('div', { className: 'sf-status-title' }, t('error.title')),
            h('div', { className: 'sf-errorline' }, t('error.network'), h('span', { className: 'sf-code' }, loadState.code || 'unknown')),
            h(
              'button',
              { type: 'button', className: 'sf-tbtn primary', onClick: load },
              t('action.retry'),
            ),
          );
        }

        function renderEmpty() {
          // nodes=0 but counts.files>0 is a real state: the workspace scan found files
          // that no tool call ever touched, so the tree is empty while the counts are not.
          if (fileCount > 0) {
            const cleanable = backlogPaths.length > 0 ? backlogPaths.length : typeof countsSrc.temp === 'number' ? countsSrc.temp : 0;
            return h(
              'div',
              { className: 'sf-status' },
              h('div', { className: 'sf-status-title' }, t('empty')),
              h('div', { className: 'sf-status-hint' }, t('empty.workspace', { n: fileCount, m: cleanable })),
              cleanable > 0
                ? h(
                    'button',
                    { type: 'button', className: 'sf-tbtn danger', disabled: busy, onClick: onCleanup },
                    t('action.cleanup'),
                  )
                : null,
            );
          }
          return h(
            'div',
            { className: 'sf-status' },
            h('div', { className: 'sf-status-title' }, t('empty')),
            h('div', { className: 'sf-status-hint' }, t('empty.hint')),
          );
        }

        function renderCanvas() {
          const z = zoom;
          const scaledW = Math.max(1, lay.width * z);
          const scaledH = Math.max(1, lay.height * z);

          const colBands = [];
          for (let col = 0; col < lay.colCount; col++) {
            const column = columns[col] || null;
            const kind = column && column.kind ? String(column.kind) : '';
            const classes = ['sf-colband'];
            if (col % 2 === 1) classes.push('alt');
            if (kind === 'final') classes.push('is-final');
            colBands.push(
              h('div', {
                key: 'colband-' + col,
                className: classes.join(' '),
                style: { left: col * lay.colWidth + 'px', width: lay.colWidth + 'px' },
              }),
            );
          }

          const heads = [];
          for (let col = 0; col < lay.colCount; col++) {
            const column = columns[col] || null;
            const kind = column && column.kind ? String(column.kind) : '';
            const classes = ['sf-colhead'];
            if (kind === 'final') classes.push('is-final');
            if (kind === 'input') classes.push('is-input');
            heads.push(
              h(
                'div',
                {
                  key: 'colhead-' + col,
                  className: classes.join(' '),
                  style: { left: col * lay.colWidth * z + 'px', width: lay.colWidth * z + 'px' },
                },
                h('div', { className: 'sf-ct' }, column && column.title ? String(column.title) : '#' + col),
                h('div', { className: 'sf-cs' }, column && column.subtitle ? String(column.subtitle) : ''),
              ),
            );
          }

          const laneBands = [];
          const laneLabels = [];
          for (let i = 0; i < laneOrder.length; i++) {
            const lane = laneOrder[i];
            const safeLane = LANE_SET[lane] ? lane : 'process';
            const top = lay.laneTops[lane] || 0;
            const height = lay.laneHeights[lane] || 0;
            const off = !!hiddenLanes[lane];
            laneBands.push(
              h('div', {
                key: 'laneband-' + lane,
                className: 'sf-laneband sf-lane-' + safeLane,
                style: { top: top + 'px', height: height + 'px' },
              }),
            );
            laneLabels.push(
              h(
                'div',
                {
                  key: 'lanelabel-' + lane,
                  className: 'sf-lanelabel sf-lane-' + safeLane + (off ? ' off' : ''),
                  style: { top: top * z + 'px', height: height * z + 'px' },
                  title: t('label.lane.filter'),
                  role: 'button',
                  onClick: function () {
                    toggleLane(lane);
                  },
                },
                h('span', { className: 'sf-bar' }),
                h('span', { className: 'sf-ll-name' }, t('lane.' + safeLane)),
                h('span', { className: 'sf-ll-count' }, String(laneCounts[safeLane] || 0)),
              ),
            );
          }

          const cards = lay.nodes.map(function (node) {
            return h(NodeCard, {
              key: String(node.id),
              node: node,
              selected: node.id === selectedId,
              onSelect: setSelectedId,
            });
          });

          return h(
            'div',
            { className: 'sf-canvas-col' },
            h(
              'div',
              { className: 'sf-grid' },
              h('div', { className: 'sf-corner' }, t('label.lane')),
              h('div', { className: 'sf-headers-viewport' }, h('div', { className: 'sf-headers-inner', ref: headerRef, style: { width: scaledW + 'px' } }, heads)),
              h('div', { className: 'sf-lanes-viewport' }, h('div', { className: 'sf-lanes-inner', ref: lanesRef, style: { height: scaledH + 'px' } }, laneLabels)),
              h(
                'div',
                { className: 'sf-canvas-viewport', ref: scrollRef, onScroll: onScroll },
                h(
                  'div',
                  { className: 'sf-canvas-spacer', style: { width: scaledW + 'px', height: scaledH + 'px' } },
                  h(
                    'div',
                    {
                      className: 'sf-canvas',
                      style: { width: lay.width + 'px', height: lay.height + 'px', transform: 'scale(' + z + ')', transformOrigin: '0 0' },
                    },
                    colBands,
                    laneBands,
                    h(EdgeLayer, { edges: lay.edges, width: lay.width, height: lay.height }),
                    cards,
                  ),
                ),
              ),
            ),
          );
        }

        let bodyContent;
        if (!ledger) bodyContent = renderStatus();
        else if (nodes.length === 0) bodyContent = renderEmpty();
        else bodyContent = renderCanvas();

        return h(
          'div',
          { className: 'sf-overlay sf-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          h('style', { key: 'sf-css', dangerouslySetInnerHTML: { __html: CSS } }),
          h('div', { className: 'sf-backdrop', onClick: closeOverlay }),
          h(
            'div',
            { className: 'sf-panel', onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation(); } },
            header,
            sub,
            countsRow,
            toolbar,
            h(
              'div',
              { className: 'sf-body' },
              bodyContent,
              selectedNode
                ? h(DetailDrawer, {
                    key: 'drawer',
                    node: selectedNode,
                    onClose: function () {
                      setSelectedId(null);
                    },
                    onClassify: classify,
                    onDelete: deletePaths,
                    preview: previewApi,
                    onNotice: showToast,
                  })
                : null,
            ),
            toast
              ? h(
                  'div',
                  {
                    className: 'sf-toast' + (toast.tone === 'info' ? ' info' : toast.tone === 'error' ? ' error' : ''),
                    role: 'status',
                  },
                  h('span', null, toast.text),
                  toast.code ? h('span', { className: 'sf-toast-code' }, toast.code) : null,
                )
              : null,
          ),
        );
      }

      // ---------------------------------------------------------------------
      // plugin wiring
      // ---------------------------------------------------------------------

      // One entry per slot occupant. The host owns the disposer, so a hot reload or an
      // unload cannot stack two overlays on top of each other. A different `slots`
      // service replaces the old registration instead of adding a second one.
      const slotOwners = new Map();

      function ownSlot(slots, options, Component) {
        const name = options.name;
        const previous = slotOwners.get(name);
        if (previous && previous.slots === slots) return previous;
        if (previous) {
          try {
            previous.dispose();
          } catch (err) {
            /* the old host already removed the entry */
          }
        }
        let inner = null;
        let disposed = false;
        let record = null;
        const dispose = function () {
          if (disposed) return;
          disposed = true;
          if (slotOwners.get(name) === record) slotOwners.delete(name);
          if (typeof inner === 'function') {
            try {
              inner();
            } catch (err) {
              /* the host already removed the entry */
            }
          }
        };
        try {
          inner = slots.inject(name, function () {
            return slots.register(options, Component);
          });
        } catch (err) {
          return null;
        }
        record = { name: name, slots: slots, dispose: dispose };
        slotOwners.set(name, record);
        return record;
      }

      function apply(ctx) {
        const locale = resolveLocaleService(ctx);
        const refreshLang = function () {
          const next = detectLang(locale);
          if (next) setLang(next);
        };
        refreshLang();
        const disposeLocale = subscribeLocale(locale, refreshLang);
        if (ctx && typeof ctx.effect === 'function') {
          try {
            ctx.effect(function () {
              return disposeLocale;
            });
          } catch (err) {
            /* effect unavailable: the subscription is process-lifetime */
          }
        }

        // `ctx.slots` is the normal path; `ctx.get('slots')` mirrors the installed plugins.
        const slots = (ctx && ctx.slots) || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null);
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

        const effectFn = ctx && typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : null;
        const occupants = [
          [{ name: 'conversation.input.right', id: 'session-files-button', order: 5 }, SessionFilesButton],
          [{ name: 'shell.overlay', id: 'session-files-overlay' }, SessionFilesOverlay],
        ];

        occupants.forEach(function (entry) {
          const record = ownSlot(slots, entry[0], entry[1]);
          if (!record || !effectFn) return;
          try {
            // The host must own the disposer, otherwise the entry leaks on unload.
            effectFn(function () {
              return record.dispose;
            });
          } catch (err) {
            /* without ctx.effect the registration lives as long as the module */
          }
        });
      }

      return {
        inject: ['slots'],
        apply: apply,
        __test: {
          layout: layout,
          edgePath: edgePath,
          LAYOUT_DEFAULTS: LAYOUT_DEFAULTS,
          LANES: LANES,
          fmtSize: fmtSize,
          fmtDateTime: fmtDateTime,
          reasonText: reasonText,
          interpolate: interpolate,
          translate: translate,
          t: t,
          getLang: getLang,
          setLang: setLang,
          DICT: DICT,
          apiUrl: apiUrl,
          API_PREFIX: API_PREFIX,
          actionColor: actionColor,
          laneColor: laneColor,
          setOpen: setOpen,
          getOpenSnapshot: getOpenSnapshot,
          subscribeOpen: subscribeOpen,
          collectTempPaths: collectTempPaths,
          collectBacklog: collectBacklog,
          unionPaths: unionPaths,
          UNFOLD_PREVIEW: UNFOLD_PREVIEW,
        },
      };
    },
  });
}
