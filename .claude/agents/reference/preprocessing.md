# Preprocessing Guidelines

## Scaling
- Apply `StandardScaler` or `MinMaxScaler` only to linear models, SVMs, k-NN, and neural networks
- Tree-based models (Random Forest, XGBoost, LightGBM, CatBoost, Decision Trees) do not benefit from scaling — do not apply it
- Fit scalers on training data only; transform val/test using the fitted scaler

## Encoding
- Low-cardinality categoricals (≤15 unique): `OneHotEncoder` (linear models) or native categorical support (LightGBM/CatBoost)
- High-cardinality categoricals: target encoding (with cross-fitting to prevent leakage) or embeddings
- Ordinal features with meaningful order: `OrdinalEncoder` with explicit category order
- Never use `LabelEncoder` for tree models when cardinality implies ordering that doesn't exist

## Missing Values
- Investigate missingness mechanism (MCAR/MAR/MNAR) before imputing
- Numeric: median imputation as default; mean only for symmetric distributions
- Categorical: most-frequent or a dedicated `"Missing"` category — never silently drop
- Add a binary indicator column when missingness rate > 5% and is informative
- LightGBM/XGBoost handle NaN natively — prefer that over imputation for tree models

## Outliers
- Clip or log-transform right-skewed features for linear models; trees are robust
- Never remove outliers without business justification and documentation
