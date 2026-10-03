---
name: ml-report
description: "Generate a polished, standalone HTML report or Reveal.js slide deck for a data science or machine learning project — dataset overview, EDA highlights, model comparison, metrics (confusion matrix, ROC, feature importance), and recommendations. Use when the user asks to write up results, create an ML report, summarize a model/experiment, build a results deck/slides, or turn notebook/metrics output into a shareable artifact. Triggers on: create an ml report, write up model results, generate a model report, summarize this experiment, report on model performance, make a slide deck of these results, present these findings."
---

# ML Report Generator

Produces a single self-contained HTML artifact that reads as executive-ready: real charts, real numbers, a clear narrative — not a notebook dump. No build step, no server.

Two output templates, same underlying content and `REPORT_DATA` shape — pick based on how the result will be consumed:

- **`templates/report_template.html`** — a scrollable document. Default choice: sharing a link, attaching to an email, or archiving. Print-to-PDF from the browser (its `@media print` rules already handle page breaks).
- **`templates/slides_template.html`** — a Reveal.js deck (same design lineage as the `revealjs` skill: dark slate theme, `Inter`/`Fira Code`, gradient accent, `grid-2`/`grid-3`/`card`/`stat-card` components). Use when the user asks for a deck, slides, or something to present live; supports speaker notes (`<aside class="notes">`), fragments, and `?print-pdf` export.
- If the user doesn't say which, ask once — "document to read/share, or slides to present?" — rather than guessing.
- If both are wanted, generate the report first, then reuse its finalized `REPORT_DATA` values verbatim in the slide deck rather than re-deriving them.

## The job

1. **Gather the inputs.** Look for what's actually available before writing anything:
   - Metrics/results (`metrics.json`, eval output, a notebook's printed scores, or numbers the user pastes in)
   - Dataset facts (shape, target distribution, key features) from EDA output or the notebook
   - Model artifacts worth charting: confusion matrix, ROC/PR curve values, feature importances, calibration, residuals
   - If a required number or plot input is genuinely missing, ask the user for it or state the assumption inline in the report — never fabricate a metric.

2. **Pick only the sections that have real content.** Both templates cover the same superset — Executive Summary, Dataset Overview, Model Comparison, Detailed Diagnostics, Recommendations (the HTML report also has room for an EDA Highlights section; the deck folds that into Dataset Overview to keep slide count sane). Delete sections/slides with nothing to show rather than padding them.

3. **Fill the template, don't rebuild it.** Copy the chosen template to the output path (ask the user for one, or default to `report.html` / `slides.html` in the project root), then replace the placeholder content and the `REPORT_DATA` block. Keep the CSS design system as-is unless the user asks for a different visual direction — it already meets the bar below.

4. **Render real charts, not screenshots — and prefer a chart over a table wherever the data supports one.** Any numeric comparison (models, features, classes, runs) reads faster as a bar/line/heat grid than as rows of numbers; keep tables only for exact values a reader needs to look up (e.g. the metric table under the comparison chart), never as a substitute for a chart that could exist. The template loads Chart.js from a CDN with ready patterns for a bar comparison, a confusion matrix heat grid, an ROC curve, and a horizontal feature-importance chart. Feed them the user's actual numbers via the `REPORT_DATA` JSON block at the top of the file — never hardcode fake data past the placeholder pass.

   **Reuse existing visualizations instead of re-deriving numbers by hand.** If the project already has an HTML report or a notebook with the relevant plots, treat them as a data source, not just inspiration:
   - **Plotly figures** (notebook cells or a prior HTML report) usually carry a `Plotly.newPlot(...)` call with an inline data/layout JSON — lift that JSON straight into a `Plotly.newPlot` call in the report (add `<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>`) rather than re-typing the numbers into a new Chart.js config.
   - **Matplotlib/seaborn output baked into a notebook** as `image/png` cell output is a base64 string in the `.ipynb` JSON — reuse it directly as `<img src="data:image/png;base64,...">` instead of re-plotting, but only when the source data isn't available to build an interactive Chart.js version (interactive/on-brand beats static when you have a choice).
   - **An existing HTML report in the project** — grep it for `REPORT_DATA`, `Chart.js`/`Plotly` config blocks, or `<img>` data URIs and copy the relevant one over, restyled to match this template's palette (`REPORT_DATA.palette` / the `--scale-*` and `--accent*` CSS variables) so it doesn't clash.
   - Whichever source you pull from, restate the figure through this template's design system (fonts, palette, caption) — don't paste in a chart with someone else's colors/fonts wholesale.

5. **Run it through `/impeccable` before calling it done.** Once the template is filled with real data, invoke the `impeccable` skill's `polish` command against the generated file (`polish <output-path>`) — a scoped refinement pass, not a redesign; it must not touch content, numbers, or the section set decided above, only finish: spacing/rhythm, contrast, responsive behavior (report) or slide overflow/scaling (deck), and any rough edge the fill pass left behind. For the slide deck specifically, also worth an `audit` pass (native reveal.js concerns: slide overflow at 1920×1080, fragment order, print-pdf fidelity). Treat this as mandatory for a report/deck going to an external audience — skip only if the user explicitly wants the raw fill.

6. **Open it up.** After writing the file, tell the user the path. For the report template: opening it in a browser + Cmd/Ctrl+P → Save as PDF produces a print-ready version (its `@media print` rules already handle page breaks and remove interactive chrome). For the slide deck: open it directly to present (arrow keys / space to advance, `S` for speaker notes, `F` fullscreen), or append `?print-pdf` to the URL and print to PDF for vector slide handouts.

## Design floor (already built into both templates — preserve it)

- Executive summary up top: 3–5 headline metric tiles before any chart, so a skimming reader (or the first slide after the title) gets the verdict in five seconds.
- One consistent color scale reused across every chart in the artifact (defined once as CSS variables + a JS palette array) — never a different rainbow per chart.
- Model comparison as a real ranked table/bar, not a wall of separate metric cards per model.
- Confusion matrices and correlation/feature grids use a single sequential scale (light→accent), never red-green traffic-light coloring.
- The report template is dark-mode-aware (`prefers-color-scheme`) with tokens; the slide deck is dark-theme by default (matching the `revealjs` skill's convention) — don't add a second parallel stylesheet to either.
- Typography: one display face for headings/numbers, one body face — sizes and weights carry hierarchy, not color alone.
- Every chart has an axis label, a unit, and a one-line caption stating the takeaway, not just the metric name.

## When gaps exist

If the user hasn't run evaluation yet or has no metrics file, don't invent numbers — say what's missing and offer to generate the report once it exists, or produce a partial report clearly marked with an "awaiting: X" note in place of the missing section.
