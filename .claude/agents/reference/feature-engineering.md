# Feature Engineering & Preprocessing Guidelines

**Rule:** All feature engineering MUST be implemented as an `sklearn` Pipeline using `feature-engine` transformers. Never write ad-hoc Python functions for encoding, scaling, imputation, or feature creation — use the appropriate transformer and compose it into a pipeline.

**Why:** Pipelines prevent data leakage (fit on train only), transformers are serialisable, and code is declarative and auditable.

---

## Pipeline Skeleton

```python
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from feature_engine.encoding import MeanEncoder, RareLabelEncoder
from feature_engine.imputation import MeanMedianImputer, CategoricalImputer
from feature_engine.discretisation import EqualFrequencyDiscretiser
from feature_engine.transformation import LogTransformer, YeoJohnsonTransformer
from feature_engine.creation import MathFeatures, CyclicalFeatures, DatetimeFeatures
from feature_engine.outliers import Winsorizer

pipe = Pipeline([
    # 1. Imputation
    ("num_imputer", MeanMedianImputer(imputation_method="median", variables=NUM_VARS)),
    ("cat_imputer", CategoricalImputer(imputation_method="frequent", variables=CAT_VARS)),
    # 2. Outlier capping (before transforms)
    ("winsorizer", Winsorizer(capping_method="iqr", tail="both", fold=1.5, variables=NUM_VARS)),
    # 3. Rare label grouping (before encoding)
    ("rare_labels", RareLabelEncoder(tol=0.01, n_categories=10, variables=CAT_VARS)),
    # 4. Encoding
    ("encoder", MeanEncoder(variables=CAT_VARS)),
    # 5. Numerical transformation
    ("yeo", YeoJohnsonTransformer(variables=SKEWED_VARS)),
    # 6. Scaling (linear/distance-based models only)
    ("scaler", StandardScaler()),
    # 7. Model
    ("model", ...),
])
```

---

## Tree-based Models (LightGBM, XGBoost, CatBoost, Random Forest)

### Scaling
- Do not apply — tree splits are invariant to monotonic transformations

### Encoding
- Pass categoricals as-is using native categorical support (LightGBM/CatBoost) — no encoding needed
- High-cardinality categoricals: group rare categories using `feature_engine.encoding.RareLabelEncoder` before passing to the model
- Ordinal features: `OrdinalEncoder` with explicit category order
- Never use `OneHotEncoder` — inflates dimensionality and hurts split quality
- Never use `LabelEncoder` when cardinality implies an ordering that doesn't exist

### Missing Values
- LightGBM/XGBoost handle NaN natively — prefer that over imputation
- When imputation is required: use `ArbitraryNumberImputer` with a value below the observed minimum (e.g. `df[col].min() - 1`) — lets the tree isolate missingness as its own branch. Never use mean/median for tree models
- Categorical: `CategoricalImputer(imputation_method='missing')` to add an explicit `"Missing"` category
- Add `AddMissingIndicator` when missingness rate > 5% and is informative

### Outliers
- No treatment needed — trees are robust to outliers

### Target Transformation
- Rarely needed; trees are robust to target scale
- Only apply when the target spans many orders of magnitude and label noise is proportional

---

## Linear Models, SVMs, k-NN, Neural Networks

### Scaling
- Always apply `StandardScaler` or `MinMaxScaler`
- Fit on training data only; transform val/test using the fitted scaler

### Encoding
- Always precede encoders with `RareLabelEncoder` to handle unseen categories
- Low-cardinality nominals (≤15 unique): `OneHotEncoder(top_categories=N)`
- High-cardinality nominals: `MeanEncoder` (supervised) or `CountFrequencyEncoder` (unsupervised) — always with cross-fitting to prevent leakage
- Ordinal features: `OrdinalEncoder` with explicit category order
- Binary classification: `WoEEncoder`

### Missing Values
- Investigate missingness mechanism (MCAR/MAR/MNAR) before imputing
- Numeric: `MeanMedianImputer(imputation_method="median")` as default; mean only for symmetric distributions
- Categorical: `CategoricalImputer(imputation_method='missing')` — never silently drop
- Add `AddMissingIndicator` when missingness rate > 5% and is informative

### Outliers
- Apply `Winsorizer(capping_method="iqr", tail="both", fold=1.5)` before any log/power transform — outliers cause log-of-negative / infinity

### Target Transformation
- Use `TransformedTargetRegressor` when the target is skewed or strictly positive — keeps the pipeline leak-free and handles inverse transform automatically
  ```python
  from sklearn.compose import TransformedTargetRegressor
  import numpy as np

  tt = TransformedTargetRegressor(
      regressor=LinearRegression(),
      func=lambda y: np.log(np.clip(y, 1e-6, None)),
      inverse_func=np.exp,
      check_inverse=False,  # required when func is a lambda
  )
  ```
- Use `check_inverse=False` whenever `func` is a lambda or clipped transform
- Prefer this over manually transforming `y` — integrates with `cross_val_score`, `GridSearchCV`, and pipelines without leakage

---

## Numeric Transforms (`feature_engine.transformation`)

| Class | Use case |
|---|---|
| `YeoJohnsonTransformer` | Skewed features with negatives — preferred over Box-Cox |
| `LogTransformer` | Right-skewed strictly positive data (all values > 0) |
| `LogCpTransformer` | Log after adding constant — handles zeros |
| `BoxCoxTransformer` | Strictly positive data only |
| `ArcsinTransformer` | Proportion/ratio data (values in [0,1]) |
| `ArcSinhTransformer` | Pseudo-log; handles zeros and negatives |
| `PowerTransformer` | Raises to a user-specified power |
| `ReciprocalTransformer` | Reciprocal of values |

Apply `Winsorizer` before any transformation.

---

## Discretisers (`feature_engine.discretisation`)

| Class | Use case |
|---|---|
| `EqualFrequencyDiscretiser` | Quantile-based binning |
| `DecisionTreeDiscretiser` | Supervised binning — learns cut-points from a tree |
| `EqualWidthDiscretiser` | Equal-width intervals |
| `ArbitraryDiscretiser` | User-defined bin edges (domain knowledge) |
| `GeometricWidthDiscretiser` | Logarithmically spaced bins for heavy-tailed distributions |

---

## Feature Creation (`feature_engine.creation`)

| Class | Use case |
|---|---|
| `MathFeatures` | Combinations across variable sets: `sum`, `mean`, `prod`, `std`, `min`, `max` |
| `RelativeFeatures` | Differences or ratios between a variable set and reference variables |
| `CyclicalFeatures` | Sine/cosine encoding for cyclical numerics (hour, day-of-week, month) |
| `DecisionTreeFeatures` | Features from decision tree predictions over one or more variables |
| `GeoDistanceFeatures` | Haversine distances from lat/lon columns |
| `TextFeatures` | Metadata: char count, word count, sentence count, lexical diversity |

Polynomial/interaction terms only with a clear domain hypothesis.

---

## Datetime (`feature_engine.datetime`)

| Class | Use case |
|---|---|
| `DatetimeFeatures` | Extracts year, month, day, dow, hour, minute, quarter, is_weekend |
| `DatetimeSubtraction` | Elapsed time / recency between two datetime columns |
| `DatetimeOrdinal` | Converts datetime to a Gregorian ordinal integer |

```python
("dt_features", DatetimeFeatures(
    variables=["created_at"],
    features_to_extract=["month", "day_of_week", "hour", "is_weekend"],
    drop_original=True,
)),
("cyclical", CyclicalFeatures(variables=["month"], max_values={"month": 12})),
```

Never treat raw timestamps as numeric inputs.

---

## Aggregation Features

- Common aggregates: count, mean, std, min, max, median per group
- Always compute aggregates on training data only, then join to val/test — no leakage
- Document the grouping key and aggregation window explicitly

---

## Text Features

- Use `TextFeatures` for metadata (char count, word count, lexical diversity)
- TF-IDF for sparse linear models via `TfidfVectorizer` inside a `ColumnTransformer`
- Always lowercase, strip punctuation, and handle nulls before vectorizing

---

## Feature Selection

- Remove zero-variance and near-zero-variance features
- Check correlation matrix; drop one of any pair with |r| > 0.9
- Use permutation importance or SHAP to identify and prune noise features after initial training
- Never select features using the full dataset — always select on training fold only

---

## Universal Rules

1. **Always fit on train, transform train+val+test** — never call `.fit` on val or test data
2. **`RareLabelEncoder` always before any categorical encoder** — prevents unseen category errors
3. **Winsorize before log/power transforms** — outliers cause log-of-negative / infinity
4. **`MeanEncoder` requires cross-fitting in CV** — wrap in a `Pipeline` inside `GridSearchCV`/`cross_validate`
5. **Scale only for linear/distance models** — tree models do not benefit from scaling
6. **One pipeline per model family** — don't share a single pipeline between a tree and a linear model
7. **Never remove outliers without business justification and documentation**
