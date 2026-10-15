# Manual source files

- `src/en/*.md` and `src/ar/*.md`: the English and Arabic text, one file per chapter.
  - `<!-- only:full -->…<!-- /only -->` marks text for the Full-access manual only; `only:sales` marks Salesperson-only text.
  - `> [!NOTE]`, `> [!TIP]` and `> [!WARNING]` make callout boxes.
  - `![Caption](shots/x.png){annot="1:120,44;2:0.5,0.5"}` inserts a screenshot with numbered red markers. Values above 1 are pixel positions; values up to 1 are fractions of the image width and height. `pad="50"` adds a white band under the image for markers, and `r="15"` sets the marker size.
- `shots/`: the screenshots, taken in light mode. Names are replaced with placeholders and money/volume figures are disguised.
- To rebuild the PDFs: install `weasyprint`, `markdown` and `pillow` (Python), plus the fonts Cairo, Noto Naskh Arabic and Inter. Then run `python3 build.py` to build all four, or for example `python3 build.py en:full`. The output goes to `out/`.
