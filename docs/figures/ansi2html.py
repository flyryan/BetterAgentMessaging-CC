#!/usr/bin/env python3
"""Draws a tmux window capture as an HTML terminal window; a browser renders it to PNG.

A frame is one directory captured from a tmux window:
    layout.txt  one line per pane: pane_id left top width height [title]   (tmux list-panes -F ...)
    window.txt  window_width window_height                                 (tmux display -p ...)
    <id>.ansi   each pane's text with its colours, named by pane id without the %   (tmux capture-pane -e -p -N)

Without --pane the whole window is drawn, every pane at its cell offset, with the 1-cell borders as thin
lines; --pane draws one pane alone. --region COL0:ROW0:COL1:ROW1 draws only that inclusive cell rectangle
of the window (of the pane, with --pane) in the same window chrome, borders inside it drawn as before.
Theme: navy, JetBrains Mono 13px/1.35, title bar "acme-api — tmux"; screenshot the page at device scale 2.

    python3 docs/figures/ansi2html.py FRAME_DIR OUT.html [--pane ID] [--region COL0:ROW0:COL1:ROW1]
        [--crop-trailing] [--blank PANE:ROW:COL:LEN ...] [--title T] [--margin PX]
"""
import argparse
import html
import os
import re
import unicodedata

THEME_BG = '#14202F'
THEME_FG = '#E6EBF1'
SEPARATOR = '#2B3B52'
PALETTE = [
    '#1C2E4A', '#E5675A', '#7CC79A', '#E9A321', '#6FA8DC', '#C792EA', '#6CC5C9', '#DCE3EA',
    # bright variants, a step lighter
    '#4A5F7E', '#F08A7F', '#9DDAB4', '#F2BC55', '#93C0E8', '#D8B0F1', '#92D7DA', '#F4F7FA',
]
# xterm-256 entries remapped so the downsampled Claude Code colors sit in the navy theme.
OVERRIDES_256 = {
    16: THEME_BG,     # pure black: used as text on coloured badges
    231: '#F4F7FA',   # pure white
    237: '#24344B',   # prompt-echo background (#3a3a3a)
    244: '#7F8B9B',   # mid gray
    246: '#8F9BAB',   # subtle gray (status, dim chrome)
}
DIM_ALPHA = 0.55


def xterm256(n):
    if n in OVERRIDES_256:
        return OVERRIDES_256[n]
    if n < 16:
        return PALETTE[n]
    if n < 232:
        n -= 16
        levels = [0, 95, 135, 175, 215, 255]
        r, g, b = levels[n // 36], levels[(n // 6) % 6], levels[n % 6]
        return f'#{r:02X}{g:02X}{b:02X}'
    v = 8 + 10 * (n - 232)
    return f'#{v:02X}{v:02X}{v:02X}'


class Style:
    __slots__ = ('fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse')

    def __init__(self):
        self.reset()

    def reset(self):
        self.fg = None
        self.bg = None
        self.bold = self.dim = self.italic = self.underline = self.inverse = False

    def key(self):
        return (self.fg, self.bg, self.bold, self.dim, self.italic, self.underline, self.inverse)


def _ext_color(params, i):
    """Parse 38/48 extended colour starting at params[i] (the 38/48 itself). Returns (colour, next_i)."""
    head = params[i]
    if len(head) > 1:  # colon form: 38:5:n or 38:2:[cs]:r:g:b
        sub = head[1:]
        try:
            if sub[0] == 5:
                return xterm256(sub[1]), i + 1
            if sub[0] == 2:
                rgb = sub[-3:]
                return '#%02X%02X%02X' % tuple(rgb), i + 1
        except (IndexError, TypeError):
            pass
        return None, i + 1
    try:
        mode = params[i + 1][0]
        if mode == 5:
            return xterm256(params[i + 2][0]), i + 3
        if mode == 2:
            r, g, b = params[i + 2][0], params[i + 3][0], params[i + 4][0]
            return '#%02X%02X%02X' % (r, g, b), i + 5
    except (IndexError, TypeError):
        pass
    return None, len(params)


def apply_sgr(st, raw):
    if raw == '':
        st.reset()
        return
    params = []
    for p in raw.split(';'):
        params.append([int(x) if x.isdigit() else None for x in p.split(':')] if p else [0])
    i = 0
    while i < len(params):
        code = params[i][0]
        if code is None:
            i += 1
            continue
        if code == 0:
            st.reset()
        elif code == 1:
            st.bold = True
        elif code == 2:
            st.dim = True
        elif code == 3:
            st.italic = True
        elif code == 4:
            st.underline = not (len(params[i]) > 1 and params[i][1] == 0)
        elif code == 7:
            st.inverse = True
        elif code == 21:
            st.underline = True
        elif code == 22:
            st.bold = st.dim = False
        elif code == 23:
            st.italic = False
        elif code == 24:
            st.underline = False
        elif code == 27:
            st.inverse = False
        elif 30 <= code <= 37:
            st.fg = PALETTE[code - 30]
        elif code == 38:
            st.fg, i = _ext_color(params, i)
            continue
        elif code == 39:
            st.fg = None
        elif 40 <= code <= 47:
            st.bg = PALETTE[code - 40]
        elif code == 48:
            st.bg, i = _ext_color(params, i)
            continue
        elif code == 49:
            st.bg = None
        elif 90 <= code <= 97:
            st.fg = PALETTE[code - 90 + 8]
        elif 100 <= code <= 107:
            st.bg = PALETTE[code - 100 + 8]
        i += 1


CSI = re.compile(r'\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])')
OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def char_width(c):
    if unicodedata.combining(c):
        return 0
    return 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1


def parse_pane(text, width, height):
    """Return grid[row][col] = (char, style_key) with None for wide-char continuation cells."""
    st = Style()
    blank = (' ', Style().key())
    grid = [[blank] * width for _ in range(height)]
    lines = text.split('\n')
    for r, line in enumerate(lines[:height]):
        line = OSC.sub('', line)
        c = 0
        pos = 0
        while pos < len(line):
            ch = line[pos]
            if ch == '\x1b':
                m = CSI.match(line, pos)
                if m:
                    if m.group(3) == 'm' and not m.group(2):
                        apply_sgr(st, m.group(1))
                    pos = m.end()
                    continue
                pos += 2
                continue
            pos += 1
            if ch in '\r\x07':
                continue
            if ch == '\xa0':
                ch = ' '
            w = char_width(ch)
            if w == 0:
                if c > 0:
                    pc, pk = grid[r][c - 1] or (' ', st.key())
                    grid[r][c - 1] = (pc + ch, pk)
                continue
            if c + w > width:
                break
            grid[r][c] = (ch, st.key())
            if w == 2:
                grid[r][c + 1] = None
            c += w
    return grid


def hex_to_rgba(h, a):
    h = h.lstrip('#')
    return f'rgba({int(h[0:2], 16)},{int(h[2:4], 16)},{int(h[4:6], 16)},{a})'


def css_for(key):
    fg, bg, bold, dim, italic, underline, inverse = key
    fg = fg or THEME_FG
    if inverse:
        fg, bg = (bg or THEME_BG), fg
    out = []
    out.append('color:' + (hex_to_rgba(fg, DIM_ALPHA) if dim else fg))
    if bg and bg.upper() != THEME_BG.upper():
        out.append('background:' + bg)
    if bold:
        out.append('font-weight:700')
    if italic:
        out.append('font-style:italic')
    if underline:
        out.append('text-decoration:underline')
    return ';'.join(out)


def default_bg(key):
    fg, bg, *_rest = key
    inverse = key[6]
    eff_bg = (fg or THEME_FG) if inverse else bg
    return eff_bg is None or eff_bg.upper() == THEME_BG.upper()


def row_is_blank(row):
    return all(cell is None or (cell[0] == ' ' and default_bg(cell[1])) for cell in row)


def render_rows(grid, rows):
    """HTML for a pane: absolutely positioned segments, so every run starts on its exact cell."""
    parts = []
    for r in range(rows):
        row = grid[r]
        c = 0
        n = len(row)
        while c < n:
            cell = row[c]
            if cell is None:
                c += 1
                continue
            ch, key = cell
            if ch == ' ' and default_bg(key):
                c += 1
                continue
            ascii_run = ch.isascii() and len(ch) == 1
            if ascii_run:
                start = c
                text = []
                while c < n and row[c] is not None and row[c][1] == key and row[c][0].isascii() and len(row[c][0]) == 1:
                    text.append(row[c][0])
                    c += 1
                # drop trailing default-bg spaces
                s = ''.join(text)
                if default_bg(key):
                    s = s.rstrip(' ')
                if not s:
                    continue
                parts.append(
                    f'<span class="s" style="left:{start}ch;top:calc({r} * var(--lh));width:{len(s)}ch;{css_for(key)}">'
                    f'{html.escape(s)}</span>')
            else:
                w = 2 if (c + 1 < n and row[c + 1] is None) else 1
                parts.append(
                    f'<span class="s g" style="left:{c}ch;top:calc({r} * var(--lh));width:{w}ch;{css_for(key)}">'
                    f'{html.escape(ch)}</span>')
                c += w
    return '\n'.join(parts)


PAGE = '''<!doctype html>
<html><head><meta charset="utf-8">
<title>{title_plain}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,700;1,400&display=block" rel="stylesheet">
<style>
  :root {{ --lh: 1.35em; }}
  html, body {{ margin: 0; padding: 0; background: #EEF2F5; }}
  .page {{ display: inline-block; padding: {margin}px; background: #EEF2F5; }}
  .frame {{ border-radius: {radius}px; overflow: hidden; background: {bg};
           box-shadow: {shadow}; }}
  .bar {{ position: relative; height: 30px; background: #1A2839; border-bottom: 1px solid {sep};
          display: flex; align-items: center; justify-content: center;
          font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #93A1B3; letter-spacing: .01em; }}
  .dots {{ position: absolute; left: 12px; top: 0; height: 30px; display: flex; gap: 7px; align-items: center; }}
  .dots i {{ width: 11px; height: 11px; border-radius: 50%; display: block; opacity: .9; }}
  .term {{ padding: 14px 16px 12px; background: {bg}; }}
  .grid {{ position: relative; font-family: "JetBrains Mono", Menlo, "Apple Symbols", monospace;
           font-size: 13px; line-height: var(--lh); color: {fg};
           font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0;
           font-variant-emoji: text; -webkit-font-smoothing: antialiased; }}
  .pane {{ position: absolute; overflow: hidden; }}
  .s {{ position: absolute; height: var(--lh); white-space: pre; overflow: visible; }}
  .g {{ text-align: center; }}
  .vsep, .hsep {{ position: absolute; background: {sep}; }}
  .vsep {{ width: 1px; }}
  .hsep {{ height: 1px; }}
</style></head>
<body><div class="page"><div class="frame" id="frame">
<div class="bar"><div class="dots"><i style="background:#E5675A"></i><i style="background:#E9A321"></i><i style="background:#7CC79A"></i></div>{title}</div>
<div class="term"><div class="grid" style="width:{cols}ch;height:calc({rows} * var(--lh))">
{body}
</div></div></div></div></body></html>
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frame_dir')
    ap.add_argument('out')
    ap.add_argument('--pane', help='pane id (e.g. 2 or %%2) to render alone')
    ap.add_argument('--title', default='acme-api — tmux')
    ap.add_argument('--region', help='COL0:ROW0:COL1:ROW1 inclusive cell rectangle to draw')
    ap.add_argument('--crop-trailing', action='store_true', help='trim blank rows at the bottom')
    ap.add_argument('--blank', action='append', default=[], help='PANE:ROW:COL:LEN cells to blank')
    ap.add_argument('--margin', type=int, default=32, help='page margin around the window, in CSS px; 0 draws the bare window, square, with no page around it')
    a = ap.parse_args()

    panes = []
    with open(os.path.join(a.frame_dir, 'layout.txt')) as f:
        for line in f:
            bits = line.split()
            if len(bits) < 5:
                continue
            pid, left, top, w, h = bits[0].lstrip('%'), *map(int, bits[1:5])
            panes.append(dict(id=pid, left=left, top=top, w=w, h=h))
    with open(os.path.join(a.frame_dir, 'window.txt')) as f:
        win_w, win_h = map(int, f.read().split()[:2])

    if a.pane:
        want = a.pane.lstrip('%')
        panes = [dict(p, left=0, top=0) for p in panes if p['id'] == want]
        win_w, win_h = panes[0]['w'], panes[0]['h']

    grids = {}
    for p in panes:
        with open(os.path.join(a.frame_dir, p['id'] + '.ansi'), encoding='utf-8', errors='replace') as f:
            grids[p['id']] = parse_pane(f.read(), p['w'], p['h'])

    for spec in a.blank:
        pid, r, c, n = spec.split(':')
        g = grids[pid.lstrip('%')]
        r, c, n = int(r), int(c), int(n)
        for k in range(c, min(c + n, len(g[r]))):
            g[r][k] = (' ', Style().key())

    # the drawn rectangle, in window cells: columns c0..c1 and rows r0..r1, inclusive
    c0, r0, c1, r1 = map(int, a.region.split(':')) if a.region else (0, 0, win_w - 1, win_h - 1)
    c1, r1 = min(c1, win_w - 1), min(r1, win_h - 1)
    if a.crop_trailing:
        def window_row_blank(y):
            for p in panes:
                if p['top'] <= y < p['top'] + p['h']:
                    row = grids[p['id']][y - p['top']]
                    if not row_is_blank(row[max(c0 - p['left'], 0):max(c1 + 1 - p['left'], 0)]):
                        return False
            return True
        while r1 > r0 and window_row_blank(r1):
            r1 -= 1
    cols, rows = c1 - c0 + 1, r1 - r0 + 1

    body, drawn = [], []
    for p in panes:
        x0, x1 = max(p['left'], c0), min(p['left'] + p['w'], c1 + 1)
        y0, y1 = max(p['top'], r0), min(p['top'] + p['h'], r1 + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        drawn.append(p['id'])
        sub = [row[x0 - p['left']:x1 - p['left']] for row in grids[p['id']][y0 - p['top']:y1 - p['top']]]
        body.append(
            f'<div class="pane" style="left:{x0 - c0}ch;top:calc({y0 - r0} * var(--lh));'
            f'width:{x1 - x0}ch;height:calc({y1 - y0} * var(--lh))">')
        body.append(render_rows(sub, y1 - y0))
        body.append('</div>')
    if not a.pane:
        for p in panes:
            sx = p['left'] - 1
            if p['left'] > 0 and c0 <= sx <= c1:  # vertical separator in column left-1
                y0, y1 = max(p['top'] - 1, r0), min(p['top'] + p['h'] + 1, r1 + 1)
                if y0 < y1:
                    body.append(
                        f'<div class="vsep" style="left:calc({sx - c0}ch + 0.5ch - 0.5px);'
                        f'top:calc({y0 - r0} * var(--lh));height:calc({y1 - y0} * var(--lh))"></div>')
            sy = p['top'] - 1
            if p['top'] > 0 and r0 <= sy <= r1:  # horizontal separator in row top-1
                x0 = max(p['left'] - (0.5 if p['left'] > 0 else 0), c0)
                x1 = min(p['left'] + p['w'] + (0.5 if p['left'] + p['w'] < win_w else 0), c1 + 1)
                if x0 < x1:
                    body.append(
                        f'<div class="hsep" style="left:{x0 - c0}ch;width:{x1 - x0}ch;'
                        f'top:calc({sy - r0} * var(--lh) + var(--lh) / 2 - 0.5px)"></div>')

    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(PAGE.format(title=html.escape(a.title), title_plain=html.escape(a.title), bg=THEME_BG,
                            fg=THEME_FG, sep=SEPARATOR, margin=a.margin, radius=10 if a.margin else 0, shadow='0 1px 2px rgba(20,32,47,.10), 0 6px 18px rgba(20,32,47,.14)' if a.margin else 'none', cols=cols, rows=rows,
                            body='\n'.join(body)))
    print(f'{a.out}: {cols}x{rows} cells, panes {drawn}')


if __name__ == '__main__':
    main()
