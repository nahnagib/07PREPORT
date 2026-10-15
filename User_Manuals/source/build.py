#!/usr/bin/env python3
"""Build the BMH 7Ps Dashboard user manuals (EN/AR, Full access / Salesperson) as PDF.

Sources: src/<lang>/*.md  (numbered, concatenated in order)
  - Conditional blocks:   <!-- only:full --> ... <!-- /only -->   (also only:sales)
  - Callouts:             > [!NOTE] text   /  > [!TIP]  /  > [!WARNING]
  - Screenshots:          ![Caption](shots/file.png){annot="1:x,y;2:x,y" width="90%"}
                          x,y are fractions (0-1) of image width/height for numbered markers.
  - Headings: '# ' chapter (new page, in TOC), '## ' section (in TOC), '### ' subsection.
Usage: python3 build.py            -> builds all four PDFs into out/
"""
import re, os, sys, html, hashlib, datetime
import markdown
from PIL import Image, ImageDraw, ImageFont
from weasyprint import HTML

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'out')
ANN = os.path.join(ROOT, 'build_annotated')
os.makedirs(OUT, exist_ok=True); os.makedirs(ANN, exist_ok=True)

BRAND = '#003366'   # BMH / app "actual" navy (packages/ui tokens)
ACCENT = '#2E7D32'  # app success green
WARN = '#B8860B'    # app watch amber
ALERT = '#CC0033'   # app alert red

META = {
    'en': {
        'app': 'BMH 7Ps Dashboard',
        'full': ('User Manual', 'Full-Access Users — Promotion & Product'),
        'sales': ('User Manual', 'Salespersons — Tachometer'),
        'toc': 'Contents', 'version': 'Version 1.0', 'page': 'Page',
        'callouts': {'NOTE': 'Note', 'TIP': 'Tip', 'WARNING': 'Warning'},
        'fig': 'Figure', 'date': lambda d: d.strftime('%d %B %Y'),
        'company': 'Ben Mussa Holding',
        'conf': 'Internal use — Ben Mussa Holding',
    },
    'ar': {
        'app': 'لوحة مؤشرات BMH 7Ps',
        'full': ('دليل المستخدم', 'مستخدمو الصلاحيات الكاملة — الترويج والمنتج'),
        'sales': ('دليل المستخدم', 'مندوبو المبيعات — صفحة Tachometer'),
        'toc': 'المحتويات', 'version': 'الإصدار 1.0', 'page': 'صفحة',
        'callouts': {'NOTE': 'ملاحظة', 'TIP': 'نصيحة', 'WARNING': 'تحذير'},
        'fig': 'شكل',
        'date': lambda d: f"{d.day} {['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'][d.month-1]} {d.year}",
        'company': 'بن موسى القابضة',
        'conf': 'للاستخدام الداخلي — بن موسى القابضة',
    },
}


def annotate(src, spec, pad=0, rr=None):
    """Draw numbered markers on a copy of the screenshot. spec: '1:0.1,0.2;2:0.5,0.5'"""
    key = hashlib.md5((src + spec + str(pad) + str(rr) + str(os.path.getmtime(src))).encode()).hexdigest()[:10]
    dst = os.path.join(ANN, f"{os.path.splitext(os.path.basename(src))[0]}_{key}.png")
    if os.path.exists(dst):
        return dst
    im0 = Image.open(src).convert('RGB')
    im = Image.new('RGB', (im0.width, im0.height + pad), 'white'); im.paste(im0, (0, 0))
    d = ImageDraw.Draw(im)
    r = int(rr) if rr else max(13, int(im.width * 0.013))
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(r * 1.25))
    except OSError:
        font = ImageFont.load_default()
    for item in spec.split(';'):
        item = item.strip()
        if not item:
            continue
        num, xy = item.split(':')
        x, y = [float(v) for v in xy.split(',')]
        cx = int(x) if x > 1 else int(x * im.width); cy = int(y) if y > 1 else int(y * im.height)
        d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], fill='white')
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ALERT)
        d.text((cx, cy), num, fill='white', font=font, anchor='mm')
    im.save(dst)
    return dst


def preprocess(text, variant, lang):
    # conditional blocks
    def cond(m):
        return m.group(2) if m.group(1) == variant else ''
    text = re.sub(r'<!-- only:(\w+) -->\n?(.*?)<!-- /only -->\n?', cond, text, flags=re.S)

    # alphabetically sort table rows following a <!-- sort --> marker
    def srt(m):
        head, sep, rows = m.group(1), m.group(2), m.group(3).strip('\n').split('\n')
        rows.sort(key=lambda r: re.sub(r'[^\w؀-ۿ]', '', r).lower())
        return head + sep + '\n'.join(rows) + '\n'
    text = re.sub(r'<!-- sort -->\n(\|[^\n]*\n)(\|[-| :]*\n)((?:\|[^\n]*\n)+)', srt, text)

    # screenshots with optional attributes
    fig_n = [0]
    def img(m):
        cap, path, attrs = m.group(1), m.group(2), m.group(3) or ''
        a = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            return f'<div class="missing">[Screenshot pending: {html.escape(path)}]</div>'
        if a.get('annot'):
            full = annotate(full, a['annot'], int(a.get('pad', 0)), a.get('r'))
        fig_n[0] += 1
        w = a.get('width', '100%')
        label = META[lang]['fig']
        return (f'<figure><img style="width:{w}" src="file://{full}"/>'
                f'<figcaption><b>{label} {fig_n[0]}.</b> {html.escape(cap)}</figcaption></figure>')
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?', img, text)

    # callouts: consecutive '> ' lines starting with [!TYPE]
    lines, out, i = text.split('\n'), [], 0
    while i < len(lines):
        m = re.match(r'>\s*\[!(NOTE|TIP|WARNING)\]\s*(.*)', lines[i])
        if m:
            kind, body = m.group(1), [m.group(2)]
            i += 1
            while i < len(lines) and lines[i].startswith('>'):
                body.append(lines[i][1:].lstrip()); i += 1
            inner = markdown.markdown('\n'.join(body), extensions=['tables', 'sane_lists'])
            title = META[lang]['callouts'][kind]
            out.append(f'<div class="callout {kind.lower()}"><div class="ct">{title}</div>{inner}</div>')
            continue
        out.append(lines[i]); i += 1
    return '\n'.join(out)


RLM = '\u200f'

def build(lang, variant):
    m = META[lang]
    srcdir = os.path.join(ROOT, 'src', lang)
    parts = sorted(f for f in os.listdir(srcdir) if f.endswith('.md'))
    text = '\n\n'.join(open(os.path.join(srcdir, f), encoding='utf8').read() for f in parts)
    text = preprocess(text, variant, lang)
    body = markdown.markdown(text, extensions=['tables', 'attr_list', 'sane_lists', 'md_in_html'])

    # ids + TOC from h1/h2
    toc, counter = [], [0]
    def hid(mm):
        lvl, inner = mm.group(1), mm.group(2)
        counter[0] += 1
        ident = f'h{counter[0]}'
        plain = html.unescape(re.sub('<[^>]+>', '', inner))
        if lvl == '1' or (lvl == '2' and plain.strip() not in ('Purpose', 'الغرض')):
            toc.append((int(lvl), ident, plain))
        return f'<h{lvl} id="{ident}">{inner}</h{lvl}>'
    body = re.sub(r'<h([123])>(.*?)</h\1>', hid, body)
    toc_html = ''.join(
        f'<li class="l{l}"><a href="#{i}"><span class="t">{html.escape(t)}{RLM if lang == "ar" else ""}</span></a></li>'
        for l, i, t in toc)

    title, sub = m[variant]
    today = m['date'](datetime.date(2026, 9, 26))
    manual_title = f"{m['app']} — {sub}"
    rtl = lang == 'ar'
    font_body = "'Noto Naskh Arabic', 'Cairo', 'Inter', sans-serif" if rtl else "'Inter', 'Cairo', sans-serif"
    font_head = "'Cairo', 'Inter', sans-serif"
    F = os.path.join(ROOT, 'fonts')
    faces = ''
    for fam, pref, weights in [
                               ('Inter', 'inter', (400, 600, 700))]:
        for w in weights:
            for sub_ in ('arabic', 'latin'):
                p = f'{F}/{pref}-{sub_}-{w}-normal.woff'
                if os.path.exists(p):
                    rng = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F, U+060C, U+061B, U+061F, U+0640' if sub_ == 'arabic' else 'U+0000-024F, U+2000-206F, U+20AC, U+2122, U+2190-21FF, U+2212'
                    faces += f"@font-face{{font-family:'{fam}';src:url('file://{p}');font-weight:{w};unicode-range:{rng};}}\n"
    start, end = ('right', 'left') if rtl else ('left', 'right')

    css = f"""
{faces}
@page {{ size: A4; margin: 22mm 18mm 20mm 18mm;
  @top-{start} {{ content: string(chapter); font: 8.5pt {font_head}; color: #666; }}
  @top-{end} {{ content: "{manual_title}"; font: 8.5pt {font_head}; color: #666; }}
  @bottom-{end} {{ content: "{m['page']} " counter(page); font: 9pt {font_head}; color: {BRAND}; }}
  @bottom-{start} {{ content: "{m['conf']}"; font: 8pt {font_head}; color: #999; }}
}}
@page cover {{ margin: 0; @top-left{{content:none}} @top-right{{content:none}} @bottom-left{{content:none}} @bottom-right{{content:none}} }}
@page toc {{ @top-left{{content:none}} @top-right{{content:none}} }}
html {{ direction: {'rtl' if rtl else 'ltr'}; }}
body {{ font-family: {font_body}; font-size: {'11pt' if rtl else '10pt'}; line-height: {'1.75' if rtl else '1.5'}; color: #1A1A1A; text-align: {start}; }}
.cover {{ page: cover; height: 297mm; position: relative; background: white; }}
.cover .band {{ position:absolute; top:0; left:0; right:0; height: 118mm; background: {BRAND}; }}
.cover .logo {{ position:absolute; top: 30mm; {start}: 20mm; width: 120mm; }}
.cover .kind {{ position:absolute; top: 72mm; {start}: 20mm; color:#cfe0f1; font: 600 14pt {font_head}; letter-spacing: {'0' if rtl else '2px'}; text-transform: {'none' if rtl else 'uppercase'}; }}
.cover .app {{ position:absolute; top: 82mm; {start}: 20mm; {end}: 20mm; color:white; font: 700 30pt {font_head}; }}
.cover .sub {{ position:absolute; top: 132mm; {start}: 20mm; {end}: 20mm; color:{BRAND}; font: 700 19pt {font_head}; }}
.cover .meta {{ position:absolute; top: 152mm; {start}: 20mm; color:#444; font: 11pt {font_head}; line-height: 1.8; }}
.cover .bar {{ position:absolute; top: 146mm; {start}: 20mm; width: 30mm; height: 2mm; background: {ALERT}; }}
.cover .foot {{ position:absolute; bottom: 18mm; {start}: 20mm; {end}: 20mm; color:#888; font: 9pt {font_head}; border-top: 1px solid #ddd; padding-top: 4mm; }}
.tocpage {{ page: toc; break-after: page; }}
.tocpage h1.toc {{ string-set: none; }}
ul.toc {{ list-style: none; padding: 0; margin: 0; }}
ul.toc li {{ margin: 0; }}
ul.toc li.l1 {{ font: 600 11pt {font_head}; margin-top: 9pt; color: {BRAND}; }}
ul.toc li.l2 {{ font-size: 9.5pt; padding-{start}: 8mm; color:#333; }}
ul.toc a {{ color: inherit; text-decoration: none; }}
ul.toc a::after {{ content: leader('.') target-counter(attr(href), page); color:#666; }}
h1 {{ font: 700 21pt {font_head}; color: {BRAND}; break-before: page; string-set: chapter content(); margin: 0 0 10pt; padding-bottom: 6pt; border-bottom: 3px solid {BRAND}; }}
h1.toc {{ break-before: auto; }}
h2 {{ font: 700 14pt {font_head}; color: {BRAND}; margin: 18pt 0 6pt; break-after: avoid; }}
h3 {{ font: 700 11.5pt {font_head}; color: #1A1A1A; margin: 13pt 0 4pt; break-after: avoid; }}
h4 {{ font: 700 10.5pt {font_head}; color: #333; margin: 10pt 0 3pt; break-after: avoid; }}
p {{ margin: 0 0 7pt; orphans: 3; widows: 3; }}
ol, ul {{ margin: 0 0 8pt; padding-{start}: 7mm; }}
li {{ margin-bottom: 3pt; }}
strong, b {{ font-weight: 700; }}
code {{ font-family: 'DejaVu Sans Mono', monospace; font-size: 8.8pt; background:#f1f4f8; padding: 0 3px; border-radius: 3px; direction: ltr; unicode-bidi: embed; }}
table {{ width: 100%; border-collapse: collapse; margin: 6pt 0 11pt; font-size: {'9.5pt' if rtl else '8.8pt'}; break-inside: auto; }}
thead {{ display: table-header-group; }}
tr {{ break-inside: avoid; }}
th {{ background: {BRAND}; color: white; font-family: {font_head}; font-weight: 600; text-align: {start}; padding: 4pt 6pt; }}
td {{ border-bottom: 1px solid #dde3ea; padding: 4pt 6pt; vertical-align: top; }}
tr:nth-child(even) td {{ background: #f6f8fb; }}
figure {{ display: block; width: auto; margin: 8pt 0 12pt 0; padding: 0; break-inside: avoid; text-align: center; }}
figure img {{ display: inline-block; max-width: 100%; height: auto; box-sizing: border-box; border: 1px solid #cfd6de; border-radius: 4px; }}
figcaption {{ font-size: 8.5pt; color: #555; margin-top: 4pt; text-align: center; }}
.callout {{ border-{start}: 4px solid; border-radius: 4px; padding: 6pt 9pt 3pt; margin: 8pt 0 10pt; break-inside: avoid; }}
.callout .ct {{ font: 700 9pt {font_head}; text-transform: {'none' if rtl else 'uppercase'}; letter-spacing: {'0' if rtl else '1px'}; margin-bottom: 2pt; }}
.callout.note {{ border-color: {BRAND}; background: #eef3f9; }} .callout.note .ct {{ color: {BRAND}; }}
.callout.tip {{ border-color: {ACCENT}; background: #eef7ef; }} .callout.tip .ct {{ color: {ACCENT}; }}
.callout.warning {{ border-color: {ALERT}; background: #fcecef; }} .callout.warning .ct {{ color: {ALERT}; }}
.callout p {{ margin-bottom: 4pt; }}
.missing {{ border: 2px dashed {ALERT}; color: {ALERT}; padding: 18pt; text-align: center; margin: 8pt 0; font-weight: 700; }}
.ltr {{ direction: ltr; unicode-bidi: isolate; }}
"""
    logo = os.path.join(ROOT, 'logo_light.png')
    cover = f"""
<section class="cover">
  <div class="band"></div>
  <img class="logo" src="file://{logo}"/>
  <div class="kind">{title}</div>
  <div class="app">{m['app']}</div>
  <div class="bar"></div>
  <div class="sub">{sub}</div>
  <div class="meta">{m['version']}<br/>{today}</div>
  <div class="foot">{m['company']} · https://dashboards.benmussaholding.com/Dashboard</div>
</section>"""
    doc = f"""<!doctype html><html lang="{lang}" dir="{'rtl' if rtl else 'ltr'}"><head><meta charset="utf-8">
<title>{manual_title}</title><style>{css}</style></head><body>
{cover}
<section class="tocpage"><h1 class="toc">{m['toc']}</h1><ul class="toc">{toc_html}</ul></section>
{body}
</body></html>"""
    name = f"Manual_{'FullAccess' if variant == 'full' else 'Salesperson'}_{lang.upper()}"
    with open(os.path.join(OUT, name + '.html'), 'w', encoding='utf8') as fh:
        fh.write(doc)
    HTML(string=doc, base_url=ROOT).write_pdf(os.path.join(OUT, name + '.pdf'))
    print('built', name)


if __name__ == '__main__':
    targets = sys.argv[1:] or ['en:full', 'en:sales', 'ar:full', 'ar:sales']
    for t in targets:
        lang, variant = t.split(':')
        build(lang, variant)
