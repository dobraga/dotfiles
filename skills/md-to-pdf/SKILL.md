---
name: md-to-pdf
description: Convert a markdown report (including one with base64-embedded matplotlib/chart images) into a clean, print-ready PDF in a plain "house report" style — Helvetica, booktabs-style tables, numbered figure captions. Use when the user asks to export/convert/render a markdown file or report to PDF, or wants a research/results doc as a PDF.
---

# md-to-pdf

Renders a markdown file to PDF via `md_to_pdf.py` (python-markdown + WeasyPrint,
bundled in this skill directory). Do not reach for `pandoc`, `md2pdf` (the npm/pip
CLI), or a browser print dialog — this project standardized on this script after
`md2pdf`'s CLI produced an unreadable PDF (no table borders, images overflowing page
bounds).

## Style

Plain, minimal "house report" look — portrait letter page, Helvetica, booktabs tables
(top/bottom rule + header underline, no cell borders, numeric columns right-aligned),
no colored boxes or backgrounds on headings. Images are auto-wrapped in `<figure>` with
a numbered caption pulled from the markdown image's alt text: `![some caption](...)`
becomes "Figure 1: some caption" under the image.

## Usage

```
uv run ~/.claude/skills/md-to-pdf/md_to_pdf.py <report.md> [output.pdf]
```

Defaults the output path to `<report>.pdf` next to the source if omitted. Relative
image paths in the markdown resolve against the source file's directory, so this also
works for reports with on-disk PNG references, not just base64 data URIs.

## Before generating charts to embed

If you are the one producing the markdown report (e.g. a Python script that builds a
report with matplotlib charts), keep the chart aspect ratio close to a normal page
(~4:3 to 3:2) rather than very tall and narrow. `figure img` in the stylesheet caps
both `max-width` and `max-height` at 620px to keep charts on one page — a very tall,
narrow figure (e.g. one column of 100+ horizontal bars) gets squeezed to a sliver in
width to satisfy the height cap. Split long per-item bar charts into two or more
side-by-side columns instead of one tall column when the item count is large.

## Verifying output

Render pages to PNG and inspect visually before telling the user it's done, especially
after changing the CSS or feeding it a new kind of chart:

```
uvx --from pdf2image python3 -c "
from pdf2image import convert_from_path
pages = convert_from_path('<output.pdf>', dpi=110)
for i, p in enumerate(pages):
    p.save(f'/tmp/pdf_check_p{i}.png')
"
```

Then Read a few of the saved PNGs (title page, any page with a chart, any page with a
wide table) to confirm nothing is clipped or illegibly small.
