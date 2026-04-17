from typing import List, Optional, Tuple, Any
from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.utils.validation import check_is_fitted, check_X_y
from sklearn.utils.multiclass import check_classification_targets

class EvalPreprocessedClassifier(BaseEstimator, ClassifierMixin):
    """Wrapper to transform eval_set before passing to classifier.fit()."""
    def __init__(
        self,
        classifier: Any,
        preprocessor: Optional[Any] = None
    ) -> None:
        self.classifier = classifier
        self.preprocessor = preprocessor

    def _transform_eval_set(self, eval_set: List[Tuple]) -> List[Tuple]:
        if self.preprocessor is None:
            return eval_set
        
        # Preprocessor is already fitted by the time this is called within fit()
        return [(self.preprocessor.transform(X_), y_) for X_, y_ in eval_set]

    def fit(self, X, y, eval_set: Optional[List[Tuple]] = None, **kwargs):
        X, y = check_X_y(X, y)
        check_classification_targets(y)
        
        if self.preprocessor is not None:
            self.preprocessor_ = clone(self.preprocessor)
            self.preprocessor_.fit(X, y)
            X = self.preprocessor_.transform(X)
        
        processed_eval_set = None
        if eval_set is not None:
            processed_eval_set = self._transform_eval_set(eval_set)

        self.classifier_ = clone(self.classifier)
        self.classifier_.fit(X, y, eval_set=processed_eval_set, **kwargs)
        
        self.classes_ = getattr(self.classifier_, "classes_", None)
        self.feature_importances_ = getattr(self.classifier_, "feature_importances_", None)
        
        return self

    def predict(self, X):
        check_is_fitted(self)
        if self.preprocessor is not None:
            X = self.preprocessor_.transform(X)
        return self.classifier_.predict(X)

    def predict_proba(self, X):
        check_is_fitted(self)
        if self.preprocessor is not None:
            X = self.preprocessor_.transform(X)
        return self.classifier_.predict_proba(X)
