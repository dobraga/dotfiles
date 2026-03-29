# Polars Standards

Prefer Polars over pandas for all feature engineering and join work.

- Use `LazyFrame` pipelines (`scan_csv`, `scan_parquet`) by default — `.collect()` only at the final step or when caching to parquet is justified.
- Push all work into the Polars engine: lazy aggregations, lazy joins, lazy filters. No Python loops over rows.
- Inspect lazy column names with `.collect_schema().names()`, never `.columns` on a `LazyFrame`.
- Do not allow `Object` dtypes to leak into lazy plans — cast or drop irregular/nested columns at read time.
- For `join_asof`: use a real `datetime.timedelta` or plain numeric tolerance as `tolerance`. Never pass a Polars duration expression.
- Align datetime time units explicitly before as-of joins (e.g., cast both sides to `Datetime("us")`).
- Cache intermediate results to parquet only when the upstream scan is expensive and reused multiple times — document why.
