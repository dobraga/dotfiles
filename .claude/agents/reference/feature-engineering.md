# Feature Engineering Guidelines

## Numeric Transforms
- Log/sqrt transforms for right-skewed features used in linear models
- Polynomial/interaction terms only when there is a clear domain hypothesis
- Binning continuous features into quantiles when non-linear relationships are expected in linear models

## Date/Time Features
- Extract: year, month, day-of-week, hour, is_weekend, is_holiday as appropriate
- Compute elapsed time / recency from a reference date (e.g., days since last purchase)
- Never treat raw timestamps as numeric inputs

## Aggregation Features (group-level)
- Common aggregates: count, mean, std, min, max, median per group
- Always compute aggregates on training data only, then join to val/test (no leakage)
- Document the grouping key and aggregation window explicitly

## Text Features
- TF-IDF for sparse linear models; sentence embeddings for semantic similarity
- Always lowercase, strip punctuation, and handle nulls before vectorizing

## Feature Selection
- Remove zero-variance and near-zero-variance features
- Check correlation matrix; drop one of any pair with |r| > 0.9
- Use permutation importance or SHAP to identify and prune noise features after initial training
- Never select features using the full dataset — always select on training fold only
