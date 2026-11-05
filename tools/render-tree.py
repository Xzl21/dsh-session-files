# Render the session file tree from real client.js layout geometry.
# usage: python render-tree.py <layout.json> <out.png> [scale]
import json
import sys
from PIL import Image, ImageDraw, ImageFont

LAYOUT = sys.argv[1]
OUT = sys.argv[2]
SS = 2  # supersample factor

LANE_RU = {
    'deliverable': '交付',
    'process': '过程',
    'input': '输入',
    'temp': '临时',
}
LANE_TINT = {
    'deliverable': (241, 246, 255),
    'process': (240, 250, 248),
    'input': (246, 247, 249),
    'temp': (253, 246, 236),
}
LANE_ACCENT = {
    'deliverable': (47, 111, 228),
    'process': (14, 159, 138),
    'input': (138, 143, 154),
    'temp': (209, 134, 43),
}
EDGE_COLOR = {
    'derived': (154, 163, 178),
    'evolution': (150, 120, 210),
    'deliverable': (47, 111, 228),
    'origin': (120, 130, 145),
}
INK = (32, 36, 44)
INK2 = (96, 104, 118)
INK3 = (140, 148, 160)
BORDER = (206, 212, 222)

FONT_REG = 'C:/Windows/Fonts/msyh.ttc'
FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'

def font(path, size):
    return ImageFont.truetype(path, size)

data = json.load(open(LAYOUT, encoding='utf-8'))
lay = data['layout']
meta = data.get('meta') or {}
counts = data.get('counts') or {}

GUTTER = 104
HEAD_H = 76
COLH = 46  # column-header band height (below the title bar, above the canvas)
PAD_R = 26
PAD_B = 34

W = GUTTER + lay['width'] + PAD_R
H = HEAD_H + COLH + lay['height'] + PAD_B
img = Image.new('RGB', (W * SS, H * SS), (238, 240, 244))
d = ImageDraw.Draw(img, 'RGBA')

f_title = font(FONT_BOLD, 15 * SS)
f_sub = font(FONT_REG, 10 * SS)
f_lane = font(FONT_BOLD, 12 * SS)
f_lane_sub = font(FONT_REG, 9 * SS)
f_col = font(FONT_BOLD, 11 * SS)
f_colsub = font(FONT_REG, 9 * SS)
f_name = font(FONT_REG, 11 * SS)
f_name_b = font(FONT_BOLD, 11 * SS)
f_meta = font(FONT_REG, 9 * SS)
f_tiny = font(FONT_REG, 8 * SS)

def S(v):
    return int(round(v * SS))

def ellipsize(text, fnt, maxw):
    text = str(text)
    if d.textlength(text, font=fnt) <= maxw:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if d.textlength(text[:mid] + '…', font=fnt) <= maxw:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + '…'

# ---- header -----------------------------------------------------------------
sess = str(meta.get('sessionId') or '')
short = sess[-12:] if len(sess) > 12 else sess
live = 'live' if meta.get('live') else 'log'
title = '会话文件树  ·  ' + short
d.text((S(18), S(14)), title, font=f_title, fill=INK)
total = counts.get('files') or len(data['nodes'])
sub = '文件 %d   ·   交付 %d   过程 %d   输入 %d   临时 %d   ·   %s   ·   %d 轮' % (
    total,
    counts.get('deliverable', 0),
    counts.get('process', 0),
    counts.get('input', 0),
    counts.get('temp', 0),
    live,
    max(0, lay['colCount'] - 2),
)
d.text((S(18), S(40)), sub, font=f_sub, fill=INK2)
ws = str(meta.get('workspacePath') or '')
if ws:
    d.text((S(W - 18), S(16)), ellipsize(ws, f_sub, S(W * 0.42)), font=f_sub, fill=INK3, anchor='ra')
warn = meta.get('warnings') or []
if warn:
    d.text((S(W - 18), S(40)), 'warnings: ' + ', '.join(map(str, warn))[:80], font=f_sub, fill=(200, 90, 40), anchor='ra')

d.line([S(0), S(HEAD_H - 1), S(W), S(HEAD_H - 1)], fill=(214, 218, 226), width=SS)
# column-header band background
d.rectangle([S(0), S(HEAD_H), S(W), S(HEAD_H + COLH)], fill=(247, 249, 252, 255))
d.line([S(0), S(HEAD_H + COLH - 1), S(W), S(HEAD_H + COLH - 1)], fill=(214, 218, 226), width=SS)

# ---- lanes ------------------------------------------------------------------
lane_order = lay['laneOrder']
lane_tops = {k: v for k, v in lay['laneTops'].items()}
lane_h = {k: v for k, v in lay['laneHeights'].items()}
lane_count = {k: 0 for k in lane_order}
for n in data['nodes']:
    lane_count[n['lane']] = lane_count.get(n['lane'], 0) + 1

for lane in lane_order:
    top = HEAD_H + COLH + lane_tops[lane]
    h = lane_h[lane]
    d.rectangle([S(GUTTER), S(top), S(GUTTER + lay['width']), S(top + h)], fill=LANE_TINT[lane] + (255,))
    d.line([S(GUTTER), S(top), S(GUTTER + lay['width']), S(top)], fill=(226, 230, 238), width=SS)
    accent = LANE_ACCENT[lane]
    # gutter label
    d.rectangle([S(14), S(top + 12), S(18), S(top + 34)], fill=accent + (255,))
    d.text((S(26), S(top + 10)), LANE_RU[lane], font=f_lane, fill=accent)
    d.text((S(26), S(top + 30)), '%d 个' % lane_count.get(lane, 0), font=f_lane_sub, fill=INK3)

# ---- column headers + grid --------------------------------------------------
cols = data.get('columns') or []
content_top = HEAD_H + COLH
for i in range(lay['colCount']):
    x = GUTTER + i * lay['colWidth']
    if i > 0:
        # dashed vertical separator over the whole content area
        y = S(content_top)
        while y < S(content_top + lay['height']):
            d.line([S(x), y, S(x), min(y + 5 * SS, S(content_top + lay['height']))], fill=(218, 223, 232), width=SS)
            y += 10 * SS
    col = cols[i] if i < len(cols) else None
    title_txt = col['title'] if col else '第 %d 轮' % i
    sub_txt = (col.get('subtitle') if col else '') or ''
    cx = x + lay['colWidth'] / 2.0
    d.text((S(cx), S(HEAD_H + 7)), title_txt, font=f_col, fill=INK, anchor='ma')
    if sub_txt:
        d.text((S(cx), S(HEAD_H + 27)), sub_txt, font=f_colsub, fill=INK3, anchor='ma')

# ---- edges ------------------------------------------------------------------

def parse_path(p):
    # "M x1 y1 C cx1 cy1, cx2 cy2, x2 y2"
    nums = []
    cur = ''
    for ch in p.replace(',', ' '):
        if ch.isdigit() or ch in '.-':
            cur += ch
        else:
            if cur and cur not in ('-', '.', '-.'):
                try:
                    nums.append(float(cur))
                except ValueError:
                    pass
            cur = ''
    if cur and cur not in ('-', '.', '-.'):
        try:
            nums.append(float(cur))
        except ValueError:
            pass
    if len(nums) >= 8:
        return nums[:8]
    return None

overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
for e in data.get('edges') or []:
    pts = parse_path(str(e.get('path') or ''))
    if not pts:
        continue
    x1, y1, c1x, c1y, c2x, c2y, x2, y2 = pts
    pts_screen = []
    for t_i in range(0, 41):
        t = t_i / 40.0
        mt = 1 - t
        px = mt ** 3 * x1 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * x2
        py = mt ** 3 * y1 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * y2
        pts_screen.append((S(GUTTER + px), S(content_top + py)))
    color = EDGE_COLOR.get(str(e.get('kind')), (150, 158, 172))
    dashed = str(e.get('kind')) == 'evolution'
    for i in range(len(pts_screen) - 1):
        if dashed and (i // 2) % 2 == 1:
            continue
        od.line([pts_screen[i], pts_screen[i + 1]], fill=color + (150,), width=max(1, SS))
img = Image.alpha_composite(img.convert('RGBA'), overlay)
d = ImageDraw.Draw(img, 'RGBA')

# ---- cards ------------------------------------------------------------------
KIND_ZH = {'input': '输入', 'turn': '', 'final': '最终'}
for n in data['nodes']:
    x = GUTTER + n['x']
    y = content_top + n['y']
    w = n['w']
    h = n['h']
    lane = n['lane']
    accent = LANE_ACCENT[lane]
    radius = 7
    d.rounded_rectangle([S(x), S(y), S(x + w), S(y + h)], radius=S(radius), fill=(255, 255, 255, 255),
                        outline=BORDER + (255,), width=max(1, SS // 2) or 1)
    # left accent bar
    d.rounded_rectangle([S(x), S(y), S(x + 4), S(y + h)], radius=S(2), fill=accent + (255,))
    inner_x = x + 12
    maxw = w - 20
    # name
    nm = ellipsize(n.get('name') or '', f_name_b, S(maxw))
    d.text((S(inner_x), S(y + 7)), nm, font=f_name_b, fill=INK)
    # reason + size
    reason = str(n.get('reason') or '')
    size = n.get('size')
    size_txt = ''
    if isinstance(size, (int, float)) and size > 0:
        if size >= 1048576:
            size_txt = '%.1f MB' % (size / 1048576.0)
        elif size >= 1024:
            size_txt = '%.0f KB' % (size / 1024.0)
        else:
            size_txt = '%d B' % size
    meta_line = reason + ('  ' + size_txt if size_txt else '')
    d.text((S(inner_x), S(y + 26)), ellipsize(meta_line, f_meta, S(maxw)), font=f_meta, fill=INK3)
    # badges row
    bx = inner_x
    by = y + 42
    def badge(text, fg, bg, bx):
        tw = d.textlength(text, font=f_tiny)
        bw = tw + 10
        d.rounded_rectangle([S(bx), S(by), S(bx + bw), S(by + 14)], radius=S(4), fill=bg + (255,))
        d.text((S(bx + 5), S(by + 2)), text, font=f_tiny, fill=fg)
        return bx + bw + 5
    cls = str(n.get('cls') or '')
    bx = badge(LANE_RU.get(cls, cls), LANE_ACCENT.get(cls, INK2), LANE_TINT.get(cls, (242, 244, 248)), bx)
    kind = str(n.get('kind') or '')
    if kind == 'final':
        bx = badge('最终', (255, 255, 255), (34, 40, 50), bx)
    elif kind == 'input':
        bx = badge('前置', (90, 96, 108), (233, 236, 241), bx)
    if n.get('overridden'):
        bx = badge('手动', (255, 255, 255), (120, 130, 145), bx)
    if not n.get('exists', True):
        bx = badge('已删除', (255, 255, 255), (217, 48, 37), bx)
    note = n.get('note')
    if note:
        d.text((S(inner_x), S(y + 58)), ellipsize('note: ' + str(note), f_tiny, S(maxw)), font=f_tiny, fill=(150, 120, 60))

# ---- legend -----------------------------------------------------------------
ly = H - 22
lx = 18
for lane in lane_order:
    d.ellipse([S(lx), S(ly - 4), S(lx + 8), S(ly + 4)], fill=LANE_ACCENT[lane] + (255,))
    d.text((S(lx + 12), S(ly - 7)), LANE_RU[lane], font=f_tiny, fill=INK2)
    lx += 66
lx += 14
d.line([S(lx), S(ly), S(lx + 22), S(ly)], fill=EDGE_COLOR['derived'] + (255,), width=SS)
d.text((S(lx + 27), S(ly - 7)), '派生/演进（虚线=同一文件跨轮）', font=f_tiny, fill=INK2)
lx += 220
d.rectangle([S(lx), S(ly - 5), S(lx + 14), S(ly + 5)], outline=(217, 48, 37, 255), width=SS)
d.text((S(lx + 19), S(ly - 7)), '已删除（磁盘上不存在）', font=f_tiny, fill=INK2)

final = img.convert('RGB').resize((W, H), Image.LANCZOS)
final.save(OUT)
print('saved %s  %dx%d  nodes=%d edges=%d' % (OUT, W, H, len(data['nodes']), len(data.get('edges') or [])))
