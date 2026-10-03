# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown", "weasyprint", "beautifulsoup4"]
# ///
"""Render a markdown report (base64-embedded charts included) to a portrait PDF in
a polished "house report" style: Helvetica, an accent-colored title/rule, banded
booktabs-style tables (top/bottom rule + header underline + zebra striping),
numbered "Figure N: <alt text>" captions under each chart, and page numbers in the
footer.

Usage:
  uv run ~/.claude/skills/md-to-pdf/md_to_pdf.py <report.md> [output.pdf]
"""

from __future__ import annotations

import sys
from pathlib import Path

import markdown
from bs4 import BeautifulSoup
from weasyprint import HTML

# Single accent color drives the title rule, h2 underlines, and table header --
# change this one value to retheme the whole report.
ACCENT = "#1a1a1a"

CSS = f"""
@page {{
    size: letter; margin: 1in 0.9in 0.85in 0.9in;
    @bottom-center {{
        content: counter(page) " / " counter(pages);
        font-family: Helvetica, Arial, sans-serif; font-size: 8.5pt; color: #888;
    }}
}}
body {{ font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.4; color: #1a1a1a; }}
h1 {{
    font-size: 19pt; font-weight: bold; color: {ACCENT};
    margin: 0 0 3pt 0; padding-bottom: 8pt; border-bottom: 2pt solid {ACCENT};
}}
h2 {{
    font-size: 12.5pt; font-weight: bold; color: {ACCENT};
    margin-top: 20pt; margin-bottom: 6pt; padding-bottom: 3pt;
    border-bottom: 0.75pt solid #ccc;
}}
h3 {{ font-size: 10.5pt; font-weight: bold; margin-top: 14pt; margin-bottom: 4pt; }}
p {{ margin: 8pt 0; text-align: justify; }}
a {{ color: {ACCENT}; text-decoration: none; }}
code {{ font-family: Courier, monospace; font-size: 9pt; background: #f2f4f7; padding: 1pt 3pt; border-radius: 2pt; }}
ul, ol {{ margin: 6pt 0; padding-left: 18pt; }}
li {{ margin: 3pt 0; }}
strong {{ color: #111; }}

table {{ border-collapse: collapse; width: auto; min-width: 55%; margin: 10pt 0; font-size: 9.5pt; }}
th, td {{ padding: 4pt 14pt 4pt 6pt; text-align: left; }}
th:first-child, td:first-child {{ padding-left: 0; }}
thead tr {{ border-bottom: 1pt solid {ACCENT}; }}
thead th {{ color: {ACCENT}; }}
tbody tr:last-child {{ border-bottom: 1pt solid #1a1a1a; }}
tbody tr:nth-child(even) {{ background: #f5f7fa; }}
th {{ font-weight: bold; }}
td:not(:first-child), th:not(:first-child) {{ text-align: right; }}
th, td {{
    max-width: 130pt; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
}}

figure {{ margin: 12pt auto; text-align: center; page-break-inside: avoid; }}
figure img {{ max-width: 620px; max-height: 420px; width: auto; height: auto; }}
figcaption {{ font-size: 9pt; color: #555; margin-top: 4pt; text-align: left; }}
"""


def _add_figure_captions(html: str) -> str:
    """Wrap each <img alt="..."> in <figure>, adding a numbered "Figure N: alt"
    caption -- matching the reference report's figure style.
    """
    soup = BeautifulSoup(html, "html.parser")
    for i, img in enumerate(soup.find_all("img"), start=1):
        alt = img.get("alt", "").strip()
        figure = soup.new_tag("figure")
        img.wrap(figure)
        if alt:
            caption = soup.new_tag("figcaption")
            caption.string = f"Figure {i}: {alt}"
            figure.append(caption)
    return str(soup)


def render(md_path: Path, pdf_path: Path) -> None:
    text = md_path.read_text(encoding="utf-8")
    body = markdown.markdown(text, extensions=["tables", "fenced_code"])
    body = _add_figure_captions(body)
    html = f"<html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{body}</body></html>"
    HTML(string=html, base_url=str(md_path.parent)).write_pdf(pdf_path)


def main() -> None:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: uv run md_to_pdf.py <report.md> [output.pdf]")
    md_path = Path(sys.argv[1])
    pdf_path = Path(sys.argv[2]) if len(sys.argv) == 3 else md_path.with_suffix(".pdf")
    render(md_path, pdf_path)
    print(f"wrote {pdf_path}")


if __name__ == "__main__":
    main()
