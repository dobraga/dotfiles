# Feature Engineering Guidelines

**All feature engineering must be implemented via `sklearn` Pipeline + `feature-engine` transformers.**
Never write ad-hoc Python functions for encoding, scaling, imputation, or feature creation.
See `.claude/agents/reference/feature-engine.md` for the full transformer catalogue and pipeline skeleton.

## Imputation
- For **tree models**: impute missing numerics with `ArbitraryNumberImputer` using a value below the observed minimum (e.g. `arbitrary_number = df[col].min() - 1`). This lets the tree isolate missingness as its own branch. Never use mean/median imputation for tree models.
- For **linear/distance models**: use `MeanMedianImputer` or `ArbitraryNumberImputer` with a domain-appropriate constant.
- For categoricals: use `CategoricalImputer(imputation_method='missing')` to add an explicit `"Missing"` category.

## Numeric Transforms
- Use `YeoJohnsonTransformer` for skewed features (handles negatives); `LogTransformer` only when all values > 0
- Apply `Winsorizer` (IQR method) before any transformation to avoid log-of-negative / infinity
- Polynomial/interaction terms only with a clear domain hypothesis — use `MathFeatures` or `RelativeFeatures`
- Quantile binning with `EqualFrequencyDiscretiser`; supervised binning with `DecisionTreeDiscretiser`

## Categorical Encoding
- Always precede encoders with `RareLabelEncoder` to handle unseen categories
- Low-cardinality nominals → `OneHotEncoder(top_categories=N)`
- High-cardinality → `MeanEncoder` (supervised) or `CountFrequencyEncoder` (unsupervised)
- Ordinal/tree models → `OrdinalEncoder`
- Binary classification → `WoEEncoder`

## Date/Time Features
- Use `DatetimeFeatures` to extract month, day-of-week, hour, is_weekend, etc.
- Use `DatetimeSubtraction` for elapsed-time / recency features
- Use `CyclicalFeatures` (sine/cosine) for cyclic numerics like hour or day-of-week
- Never treat raw timestamps as numeric inputs

## Aggregation Features (group-level)
- Common aggregates: count, mean, std, min, max, median per group
- Always compute aggregates on training data only, then join to val/test (no leakage)
- Document the grouping key and aggregation window explicitly

## Text Features
- Use `TextFeatures` for metadata (char count, word count, lexical diversity)
- TF-IDF for sparse linear models via `TfidfVectorizer` in a `ColumnTransformer`
- Always lowercase, strip punctuation, and handle nulls before vectorizing

## Feature Selection
- Remove zero-variance and near-zero-variance features
- Check correlation matrix; drop one of any pair with |r| > 0.9
- Use permutation importance or SHAP to identify and prune noise features after initial training
- Never select features using the full dataset — always select on training fold only
