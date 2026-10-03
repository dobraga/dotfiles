# Plotting Standards

All plots use `matplotlib`. Never use any other plotting library (seaborn, plotly, altair) unless explicitly requested.

## Hard Rules

| Rule | Rationale |
|------|-----------|
| **Never use pie charts** | Area/angle perception is inaccurate. Use horizontal bar charts for part-to-whole comparisons. |
| **Never use bar charts for time series** | Bars imply discrete categories. Use line charts for continuous temporal data. |
| **Never use 3D charts** | Depth distorts perception and adds no information. |
| **Always set `figsize`, title, and axis labels** | Unlabelled plots are not reproducible or shareable. |
| **Never save figures to disk** — encode as base64 and embed directly in the markdown report | Self-contained report, no file path dependencies. |

---

## Chart Selection Guide

### Time Series → Line Chart

Use when: the x-axis is a date/time and the variable is continuous.

```python
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

fig, ax = plt.subplots(figsize=(12, 4))
ax.plot(df["date"], df["value"], linewidth=1.5)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
fig.autofmt_xdate()
ax.set_title("Monthly Active Users")
ax.set_xlabel("Month")
ax.set_ylabel("Users")
ax.grid(axis="y", alpha=0.3)
plt.tight_layout()
```

Multiple series on the same time axis — add a legend:

```python
for col in ["ios", "android", "web"]:
    ax.plot(df["date"], df[col], label=col, linewidth=1.5)
ax.legend()
```

### Part-to-Whole / Ranking → Horizontal Bar Chart

Use when: comparing discrete categories, shares, or rankings. Always horizontal so labels are readable.

```python
fig, ax = plt.subplots(figsize=(8, 5))
ax.barh(df["category"], df["value"], color="#4C72B0")
ax.set_title("Revenue by Channel")
ax.set_xlabel("Revenue (USD)")
ax.set_ylabel("Channel")
ax.invert_yaxis()          # largest value at top
ax.grid(axis="x", alpha=0.3)
plt.tight_layout()
```

### Distribution → Histogram or KDE

Use a histogram for raw distributions; overlay KDE when comparing groups:

```python
fig, ax = plt.subplots(figsize=(8, 4))
ax.hist(df["value"].dropna(), bins=40, edgecolor="white", color="#4C72B0", alpha=0.8)
ax.set_title("Distribution of Session Duration")
ax.set_xlabel("Duration (seconds)")
ax.set_ylabel("Count")
plt.tight_layout()
```

For group comparison use overlapping semi-transparent histograms or a box plot — not a pie chart.

### Correlation / Two Numeric Variables → Scatter Plot

```python
fig, ax = plt.subplots(figsize=(7, 6))
ax.scatter(df["x"], df["y"], alpha=0.4, s=20, color="#4C72B0")
ax.set_title("Sessions vs. Revenue")
ax.set_xlabel("Sessions")
ax.set_ylabel("Revenue (USD)")
plt.tight_layout()
```

Add a trend line when the relationship is the focus:

```python
import numpy as np
m, b = np.polyfit(df["x"], df["y"], 1)
ax.plot(df["x"], m * df["x"] + b, color="red", linewidth=1, linestyle="--", label="trend")
ax.legend()
```

### Comparing Many Groups Over Time → Small Multiples (Facets)

When a single line chart would have more than ~5 series, use small multiples instead:

```python
groups = df["segment"].unique()
n = len(groups)
fig, axes = plt.subplots(1, n, figsize=(5 * n, 4), sharey=True)
for ax, group in zip(axes, groups):
    subset = df[df["segment"] == group]
    ax.plot(subset["date"], subset["value"], linewidth=1.5)
    ax.set_title(group)
    ax.set_xlabel("Month")
axes[0].set_ylabel("Value")
fig.suptitle("Value by Segment Over Time", y=1.02)
plt.tight_layout()
```

### Heatmap → `imshow` or `pcolormesh`

Use for correlation matrices or pivot tables. Never for time series.

```python
import numpy as np

corr = df.select_dtypes("number").corr()
fig, ax = plt.subplots(figsize=(8, 7))
im = ax.imshow(corr, cmap="coolwarm", vmin=-1, vmax=1)
ax.set_xticks(range(len(corr.columns)))
ax.set_yticks(range(len(corr.columns)))
ax.set_xticklabels(corr.columns, rotation=45, ha="right")
ax.set_yticklabels(corr.columns)
plt.colorbar(im, ax=ax, label="Correlation")
ax.set_title("Feature Correlation Matrix")
plt.tight_layout()
```

---

## Common Mistakes and Fixes

| Mistake | Fix |
|---------|-----|
| Bar chart with a date on the x-axis | Switch to `ax.plot()` (line chart) |
| Pie chart for category shares | Switch to `ax.barh()` (horizontal bar) |
| Missing title or axis labels | Always set `ax.set_title()`, `ax.set_xlabel()`, `ax.set_ylabel()` |
| Figure not encoded | Always call `fig_to_base64(fig)` and embed inline in the report |
| All figures dumped at the end | Interleave prose and figures — add each figure immediately after its analysis text |
| Spaghetti plot with 10+ lines | Use small multiples |
| Raw date strings on x-axis | Use `mdates.DateFormatter` + `fig.autofmt_xdate()` |
| Overlapping x-axis tick labels | Rotate with `ax.tick_params(axis="x", rotation=45)` or use `fig.autofmt_xdate()` |

---

## Encoding Figures as Base64 (canonical snippet)

Never save figures to disk. Instead, encode each figure to base64 immediately after creating it and store the result for embedding in the final markdown report.

```python
import base64
import io
import matplotlib.pyplot as plt

def fig_to_base64(fig: plt.Figure) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()
```

Build the report incrementally — interleave text and figures as you go, then write once at the end:

```python
# At the top of the notebook:
report = []  # list of markdown strings, built incrementally

# After each section — add prose then the figure:
report.append("## Monthly Active Users\n\nGrowth accelerated in Q3, driven by the mobile cohort.\n")
report.append(f"![monthly_active_users](data:image/png;base64,{fig_to_base64(fig)})\n")

report.append("## Retention by Cohort\n\nDay-7 retention dropped 4pp for the Jan cohort.\n")
report.append(f"![retention](data:image/png;base64,{fig_to_base64(fig2)})\n")

# Final cell — write the assembled report:
from pathlib import Path
Path("reports/<analysis>_summary.md").write_text("\n".join(["# Analysis Report\n"] + report))
```

Replace `<analysis>` with the notebook topic (e.g., `eda`, `baseline`, `retention`). Text and figures must alternate naturally — never dump all figures at the end.
