# Feature-Engine + Sklearn Pipeline Reference

**Rule:** All feature engineering MUST be implemented as an `sklearn` Pipeline using `feature-engine` transformers. Never write ad-hoc Python functions for encoding, scaling, imputation, or feature creation — use the appropriate transformer and compose it into a pipeline.

## Why

- Pipelines prevent data leakage by fitting only on training data and transforming val/test
- Transformers are serialisable — fit once, save, reload for inference
- Code is declarative and auditable; no hidden state in notebooks

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
    # 6. Scaling (for linear/distance-based models only)
    ("scaler", StandardScaler()),
    # 7. Model
    ("model", ...),
])
```

---

## Categorical Encoders (`feature_engine.encoding`)

| Class | Use case |
|---|---|
| `OneHotEncoder` | Low-cardinality nominals (< ~15 categories); optional `top_categories=N` to one-hot only the most frequent |
| `OrdinalEncoder` | When category order matters (e.g., education level) or for tree models |
| `MeanEncoder` | Supervised; replaces category with target mean — powerful for high-cardinality |
| `CountFrequencyEncoder` | Replaces category with count or frequency — good unsupervised alternative to ordinal |
| `WoEEncoder` | Binary classification only; weight of evidence encoding |
| `DecisionTreeEncoder` | Encodes via a single decision tree's leaf predictions — captures non-linearity |
| `RareLabelEncoder` | Groups infrequent categories into `"Rare"` before any other encoder |
| `StringSimilarityEncoder` | Encodes based on string similarity — useful for messy free-text categoricals |

**Typical sequence for high-cardinality cats:**
```python
("rare", RareLabelEncoder(tol=0.01, variables=CAT_VARS)),
("enc",  MeanEncoder(variables=CAT_VARS)),
```

---

## Discretisers (`feature_engine.discretisation`)

| Class | Use case |
|---|---|
| `EqualFrequencyDiscretiser` | Binning into quantile-based intervals |
| `EqualWidthDiscretiser` | Binning into equal-width intervals |
| `DecisionTreeDiscretiser` | Supervised binning — learns cut-points from a tree |
| `ArbitraryDiscretiser` | User-defined bin edges (domain knowledge) |
| `GeometricWidthDiscretiser` | Logarithmically spaced bins for heavy-tailed distributions |

---

## Outlier Handling (`feature_engine.outliers`)

| Class | Use case |
|---|---|
| `Winsorizer` | Caps outliers using `gaussian`, `iqr`, or `quantiles` method |
| `OutlierTrimmer` | Removes rows with outliers — use only when losing rows is acceptable |
| `ArbitraryOutlierCapper` | User-defined floor/ceiling values |

Default: `Winsorizer(capping_method="iqr", tail="both", fold=1.5)`.

---

## Numerical Transformers (`feature_engine.transformation`)

| Class | Use case |
|---|---|
| `LogTransformer` | Right-skewed positive data (all values > 0) |
| `LogCpTransformer` | Log after adding constant — handles zeros |
| `YeoJohnsonTransformer` | Handles positive and negative values; preferred over Box-Cox |
| `BoxCoxTransformer` | Strictly positive data only |
| `ReciprocalTransformer` | Reciprocal of values |
| `PowerTransformer` | Raises to a user-specified power |
| `ArcsinTransformer` | Proportion/ratio data (values in [0,1]) |
| `ArcSinhTransformer` | Pseudo-log; handles zeros and negatives |

---

## Feature Creation (`feature_engine.creation`)

| Class | Use case |
|---|---|
| `MathFeatures` | Combinations across variable sets: `sum`, `mean`, `prod`, `std`, `min`, `max` |
| `RelativeFeatures` | Differences or ratios between a variable set and reference variables |
| `CyclicalFeatures` | Sine/cosine encoding for cyclical numeric features (hour, day-of-week, month) |
| `DecisionTreeFeatures` | Features from decision tree predictions over one or more variables |
| `GeoDistanceFeatures` | Haversine distances from lat/lon columns |

**Example — cyclical encoding of month:**
```python
("cyclical", CyclicalFeatures(variables=["month"], max_values={"month": 12})),
```

---

## Datetime (`feature_engine.datetime`)

| Class | Use case |
|---|---|
| `DatetimeFeatures` | Extracts year, month, day, dow, hour, minute, quarter, is_weekend, etc. |
| `DatetimeSubtraction` | Elapsed time between two datetime columns |
| `DatetimeOrdinal` | Converts datetime to a Gregorian ordinal integer |

**Example:**
```python
("dt_features", DatetimeFeatures(
    variables=["created_at"],
    features_to_extract=["month", "day_of_week", "hour", "is_weekend"],
    drop_original=True,
)),
```

---

## Text (`feature_engine.creation`)

| Class | Use case |
|---|---|
| `TextFeatures` | Extracts metadata: char count, word count, sentence count, lexical diversity |

For bag-of-words or TF-IDF, use `sklearn.feature_extraction.text.TfidfVectorizer` inside a `ColumnTransformer`.

---

## Imputation (`feature_engine.imputation`)

| Class | Use case |
|---|---|
| `MeanMedianImputer` | Numeric: replace with mean or median |
| `ArbitraryNumberImputer` | Numeric: replace with a fixed value |
| `EndTailImputer` | Numeric: replace with a far tail value (signals missingness) |
| `CategoricalImputer` | Categorical: replace with mode or `"Missing"` |
| `AddMissingIndicator` | Adds binary flag for missingness before imputation |
| `DropMissingData` | Drops rows with missing values |

---

## Rules

1. **Always fit on train, transform train+val+test** — never call `.fit` on val or test data.
2. **`RareLabelEncoder` always before any categorical encoder** — prevents unseen category errors.
3. **Winsorize before log/power transforms** — outliers cause log of negative / infinity.
4. **`MeanEncoder` requires cross-fitting in CV** — use `sklearn`'s `cross_val_predict` or wrap in a `Pipeline` inside `GridSearchCV`/`cross_validate` to avoid leakage within folds.
5. **Scale only for linear/distance models** (logistic regression, SVM, KNN) — tree models do not benefit from scaling.
6. **One pipeline per model family** — don't share a single pipeline between a tree and a linear model.
