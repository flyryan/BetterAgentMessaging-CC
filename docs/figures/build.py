"""Builds the README's two authored figures as HTML pages; a browser renders them to PNG.

proof.html -> docs/images/before-after.png: the real runs of 2026-10-08 (docs/experiment.md)
    as a time-distance chart, 1200x640 CSS px at device scale 2.
hero.html  -> docs/images/hero.png: the masthead, 1600x540 CSS px at device scale 2.

    python3 docs/figures/build.py
    then screenshot each page at its size (any headless browser; fonts load from Google Fonts).
"""
from pathlib import Path

OUT = Path(__file__).parent
PAPER, INK, MUTED, AMBER, RED, RULE = '#EEF2F5', '#1C2E4A', '#8C9AAE', '#D9930F', '#C8402F', '#D3DBE4'
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600'
         '&family=Barlow+Condensed:wght@500;600;700&family=JetBrains+Mono:wght@500&display=block" rel="stylesheet">')

# Seconds from the moment team-lead's SendMessage "Stop after step 4" ran, taken from the lead's and the
# teammates' transcripts: step 0 is when the first step started, step N is when step N's result came back.
# A *_READ point is when the message first reached the teammate's model.
WITHOUT = [(-30.7, 0), (-14.1, 1), (3.0, 2), (19.9, 3), (38.5, 4), (67.0, 5), (85.1, 6), (109.1, 7), (141.0, 8), (157.8, 9), (174.5, 10)]
WITHOUT_READ = (184.3, 10)
WITH = [(-27.4, 0), (-11.1, 1), (6.9, 2), (26.7, 3), (44.1, 4)]
WITH_READ = (6.9, 2)


def proof() -> str:
    w, h = 1200, 640
    left, right, top, bottom = 118, 1140, 150, 560
    x0, x1 = -45, 200

    def X(t: float) -> float:
        return left + (t - x0) / (x1 - x0) * (right - left)

    def Y(step: float) -> float:
        return bottom - step / 10 * (bottom - top)

    def at(series, t):
        for (ta, sa), (tb, sb) in zip(series, series[1:]):
            if ta <= t <= tb:
                return sa + (t - ta) / (tb - ta) * (sb - sa)
        return series[-1][1]

    svg = []
    for s in range(0, 11):
        svg.append(f'<line x1="{left}" x2="{right}" y1="{Y(s):.1f}" y2="{Y(s):.1f}" stroke="{RULE}" stroke-width="1"/>')
        if s:
            weight = 600 if s == 4 else 500
            colour = INK if s == 4 else '#5B6B82'
            svg.append(f'<text x="{left - 16}" y="{Y(s) + 5:.1f}" text-anchor="end" class="tick" '
                       f'font-weight="{weight}" fill="{colour}">step {s}</text>')
    for t in range(-30, 201, 30):
        svg.append(f'<line x1="{X(t):.1f}" x2="{X(t):.1f}" y1="{bottom}" y2="{bottom + 6}" stroke="{MUTED}"/>')
        label = 'sent' if t == 0 else f'{t:+d} s'
        svg.append(f'<text x="{X(t):.1f}" y="{bottom + 28}" text-anchor="middle" class="tick" fill="#5B6B82">{label}</text>')

    # the dispatch: team-lead's message at t = 0
    svg.append(f'<line x1="{X(0):.1f}" x2="{X(0):.1f}" y1="{top - 22}" y2="{bottom}" stroke="{AMBER}" stroke-width="2"/>')
    svg.append(f'<text x="{X(0) + 10:.1f}" y="{top - 28}" class="note" fill="{INK}">team-lead sends '
               f'<tspan font-weight="600">“Stop after step 4”</tspan></text>')

    def run(series, colour, width):
        pts = ' '.join(f'{X(t):.1f},{Y(s):.1f}' for t, s in series)
        out = [f'<polyline points="{pts}" fill="none" stroke="{colour}" stroke-width="{width}" '
               f'stroke-linejoin="round" stroke-linecap="round"/>']
        out += [f'<circle cx="{X(t):.1f}" cy="{Y(s):.1f}" r="4.5" fill="{PAPER}" stroke="{colour}" stroke-width="2.5"/>'
                 for t, s in series[1:]]
        return out

    def travel(series, read, with_path):
        sy = at(series, 0)
        path = (f'<line x1="{X(0):.1f}" y1="{Y(sy):.1f}" x2="{X(read[0]):.1f}" y2="{Y(read[1]):.1f}" '
                f'stroke="{AMBER}" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round"/>') if with_path else ''
        return (path + f'<circle cx="{X(read[0]):.1f}" cy="{Y(read[1]):.1f}" r="9" fill="{AMBER}"/>'
                f'<circle cx="{X(read[0]):.1f}" cy="{Y(read[1]):.1f}" r="3.5" fill="{PAPER}"/>')

    svg += run(WITHOUT, MUTED, 3)
    svg += run(WITH, INK, 4)
    svg.append(travel(WITHOUT, WITHOUT_READ, False))
    svg.append(travel(WITH, WITH_READ, True))
    # where the run with the mod stopped; short above the point so it clears the grey line
    sx, sy = X(WITH[-1][0]), Y(WITH[-1][1])
    svg.append(f'<line x1="{sx + 12:.1f}" x2="{sx + 12:.1f}" y1="{sy - 6:.1f}" y2="{sy + 14:.1f}" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>')

    labels = [
        (X(64), Y(4) + 34, INK, 600, 'With the mod: stops at step 4'),
        (X(64), Y(4) + 56, '#3D4E66', 400, 'Reads the message at +7 s, between steps 2 and 3'),
    ]
    for x, y, colour, weight, text in labels:
        svg.append(f'<text x="{x:.1f}" y="{y:.1f}" class="label" font-weight="{weight}" fill="{colour}">{text}</text>')
    for y, colour, weight, text in [
        (Y(10) + 6, '#6E7D93', 600, 'Without the mod: runs all 10 steps'),
        (Y(10) + 28, '#5B6B82', 400, 'Reads the message at +184 s, after the work is done'),
    ]:
        svg.append(f'<text x="{X(150):.1f}" y="{y:.1f}" text-anchor="end" class="label" font-weight="{weight}" fill="{colour}">{text}</text>')

    return f'''<!doctype html><html><head><meta charset="utf-8">{FONTS}<style>
html,body{{margin:0;background:{PAPER}}}
#fig{{width:{w}px;height:{h}px;background:{PAPER};font-family:Barlow,sans-serif;position:relative}}
h1{{position:absolute;left:48px;top:30px;margin:0;font:600 38px/1.1 "Barlow Condensed";color:{INK};letter-spacing:-0.01em}}
p{{position:absolute;left:48px;top:76px;margin:0;font:400 19px/1.35 Barlow;color:#3D4E66}}
.foot{{position:absolute;left:48px;bottom:16px;font:400 14px Barlow;color:#5B6B82;top:auto}}
svg{{position:absolute;left:0;top:0}}
.tick{{font:500 15px Barlow;font-variant-numeric:tabular-nums}}
.note{{font:400 17px Barlow}}
.label{{font-family:Barlow;font-size:17px}}
</style></head><body><div id="fig">
<h1>Same teammate. Same message. Different outcome.</h1>
<p>A tmux teammate runs 10 steps, each a 15-second sleep. Mid-run, team-lead tells it to stop after step 4.</p>
<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(svg)}</svg>
<div class="p foot">Real runs on Claude Code 2.1.294, 8 Oct 2026. Times come from the lead’s and the teammates’ transcripts, in seconds from the send.</div>
</div></body></html>'''


def hero() -> str:
    w, h = 1600, 540
    gx0, gx1, gy0, gy1 = 840, 1500, 70, 440
    steps, dur = 8, 60

    def Y(step: float) -> float:
        return gy1 - step / steps * (gy1 - gy0)

    svg = []
    for s in range(1, steps + 1):
        svg.append(f'<line x1="{gx0}" x2="{gx1}" y1="{Y(s):.1f}" y2="{Y(s):.1f}" stroke="{RULE}" stroke-width="1.2"/>')
    # team-lead's rail along the bottom; each dispatch rises from it to the moment it lands
    svg.append(f'<line x1="{gx0}" x2="{gx1}" y1="{gy1}" y2="{gy1}" stroke="{INK}" stroke-width="3"/>')
    svg.append(f'<text x="{gx0}" y="{gy1 + 36}" class="axis">team-lead</text>')

    def line(sx, upto, hold=None):
        pts, x = [(sx, 0)], sx
        for s in range(1, upto + 1):
            x += dur
            pts.append((x, s))
            if hold and s == hold[0]:
                x += hold[1]
                pts.append((x, s))
        return [(px, ps) for px, ps in pts if px <= gx1]

    def draw(pts, colour, name, stop=False):
        poly = ' '.join(f'{px:.1f},{Y(ps):.1f}' for px, ps in pts)
        out = [f'<polyline points="{poly}" fill="none" stroke="{colour}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>']
        out += [f'<circle cx="{px:.1f}" cy="{Y(ps):.1f}" r="4" fill="{PAPER}" stroke="{colour}" stroke-width="2.4"/>' for px, ps in pts[1:]]
        ex, es = pts[-1]
        if stop:
            out.append(f'<line x1="{ex + 10:.1f}" x2="{ex + 10:.1f}" y1="{Y(es) - 13:.1f}" y2="{Y(es) + 13:.1f}" stroke="{colour}" stroke-width="4" stroke-linecap="round"/>')
        out.append(f'<text x="{ex + (26 if stop else 14):.1f}" y="{Y(es) + 9:.1f}" class="agent" fill="{colour}">{name}</text>')
        return out

    def dispatch(x, step):
        return [f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{gy1:.1f}" y2="{Y(step) + 9:.1f}" stroke="{AMBER}" stroke-width="2.4" stroke-dasharray="2 7" stroke-linecap="round"/>',
                f'<circle cx="{x:.1f}" cy="{Y(step):.1f}" r="8" fill="{AMBER}"/>']

    impl = line(860, 8)
    review = line(1000, 8, hold=(3, 110))
    docs = line(1205, 4)
    svg += draw(impl, INK, 'impl')
    svg += draw(review, INK, 'review')
    svg += draw(docs, MUTED, 'docs', stop=True)
    a, b = [p for p in review if p[1] == 3]
    svg.append(f'<line x1="{a[0]:.1f}" x2="{b[0]:.1f}" y1="{Y(3):.1f}" y2="{Y(3):.1f}" stroke="{RED}" stroke-width="6" stroke-linecap="round"/>')
    svg += dispatch(925, (925 - 860) / dur)           # a message lands in impl mid-task
    svg += dispatch(1186, 3)                          # hold: review stops at its next step
    svg += dispatch(1295, (1295 - 1205) / dur)        # "stop after step 4" reaches docs

    # the legend, sized to read at README width (the figure shows at about half size)
    lx, ly = 1090, 516
    svg.append(f'<circle cx="{lx}" cy="{ly - 8}" r="8" fill="{AMBER}"/>'
               f'<text x="{lx + 18}" y="{ly}" class="legend">message lands mid-task</text>'
               f'<line x1="{lx + 304}" x2="{lx + 340}" y1="{ly - 8}" y2="{ly - 8}" stroke="{RED}" stroke-width="7" stroke-linecap="round"/>'
               f'<text x="{lx + 354}" y="{ly}" class="legend">hold</text>')

    return f'''<!doctype html><html><head><meta charset="utf-8">{FONTS}<style>
html,body{{margin:0;background:{PAPER}}}
#fig{{width:{w}px;height:{h}px;background:{PAPER};position:relative;overflow:hidden}}
.word{{position:absolute;left:72px;top:86px;font:700 92px/0.94 "Barlow Condensed";color:{INK};letter-spacing:-0.015em}}
.promise{{position:absolute;left:76px;top:280px;width:660px;font:400 27px/1.36 Barlow;color:#2E3F58;text-wrap:balance}}
.promise b{{font-weight:600;color:{INK}}}
.verbs{{position:absolute;left:76px;top:432px;display:flex;gap:12px}}
.verbs span{{font:500 22px "JetBrains Mono";color:{INK};background:#DCE3EB;border-radius:6px;padding:7px 12px}}
.verbs span.hold{{color:{RED}}}
svg{{position:absolute;left:0;top:0}}
.axis{{font:500 24px Barlow;fill:#5B6B82}}
.legend{{font:500 24px Barlow;fill:#5B6B82}}
.agent{{font:600 27px "Barlow Condensed";letter-spacing:0.01em}}
</style></head><body><div id="fig">
<div class="word">BetterAgent<br>Messaging</div>
<div class="promise"><b>For Claude Code subagents and agent teams.</b><br>Your message reaches a working teammate at its next step, not after it finishes.</div>
<div class="verbs"><span>SendMessage</span><span class="hold">hold:</span><span>release</span><span>standing:</span><span>to: "all"</span></div>
<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(svg)}</svg>
</div></body></html>'''


(OUT / 'proof.html').write_text(proof())
(OUT / 'hero.html').write_text(hero())
print('wrote', OUT / 'proof.html', OUT / 'hero.html')
