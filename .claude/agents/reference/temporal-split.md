# Temporal Split Guidelines

## When a Date Column Exists
- Always use `TimeSeriesSplit` for cross-validation — never `KFold` or `StratifiedKFold`
- Sort by date before any split; the validation fold must always be strictly after the training fold in time

## Entity × Date Data Pattern
Data is typically **entity × date** (one or more rows per entity per day). Splits must happen at the **month boundary** — never mid-month.

```python
from sklearn.model_selection import TimeSeriesSplit

# 1. Extract year-month period from the date column
df = df.sort_values('date')
df['_month'] = df['date'].dt.to_period('M')

# 2. Split on unique months, not rows
unique_months = df['_month'].unique()
tscv = TimeSeriesSplit(n_splits=5, test_size=1, max_train_size=12)  # tune these

for train_idx, test_idx in tscv.split(unique_months):
    train_months = unique_months[train_idx]
    test_months  = unique_months[test_idx]
    train_df = df[df['_month'].isin(train_months)]
    test_df  = df[df['_month'].isin(test_months)]
```

## Choosing Split Parameters
Before setting `n_splits`, `test_size`, and `max_train_size`:
1. Plot row counts **per month** to understand data density and volume trends.
2. Set `test_size` = number of months in the prediction horizon (usually 1).
3. Set `max_train_size` = months of stable, relevant history — exclude months with distribution shifts or anomalous counts.
4. Visualize all fold boundaries (which months are train vs. test per fold) before training to confirm no leakage.
5. Document chosen values and rationale in the notebook.
