# Modelling Guidelines

## Model Selection
- Start with a simple interpretable baseline (logistic regression, decision tree, linear regression)
- Prefer LightGBM as the default gradient boosting implementation (fastest, handles NaN natively)
- Use XGBoost or CatBoost when CatBoost's native categorical handling or XGBoost's GPU support is needed
- Neural networks only when structured data methods plateau and dataset is large (>100k rows)

## Hyperparameter Tuning
- Use `Optuna` for hyperparameter search; prefer TPE sampler with a pruner
- Define a budget (n_trials or time limit) before starting — never tune open-ended
- Tune on validation fold(s), never on test
- Log all trials; save best params to a config file

## Class Imbalance
- **Always use weights first:** set `class_weight="balanced"` (sklearn) or `scale_pos_weight` (XGBoost/LightGBM) — this is the default approach
- Never use SMOTE or oversampling unless weights demonstrably fail and there is a strong justification
- Evaluate with PR-AUC or F1 alongside ROC-AUC when classes are imbalanced

## Regularization
- Linear models: always tune `C` (logistic) or `alpha` (ridge/lasso) — never use defaults blindly
- Tree models: tune `max_depth`, `min_child_samples`, `subsample`, and `reg_lambda`
- Early stopping on a held-out validation set for boosting models

## Ensembling
- Simple averaging or rank averaging before stacking
- Stacking: use out-of-fold predictions as meta-features; never leak test predictions into training
- Document ensemble composition and each member's individual performance
