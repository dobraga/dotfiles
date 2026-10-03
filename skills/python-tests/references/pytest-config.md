# pytest Configuration

## pyproject.toml

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
addopts = [
    "-ra",
    "--strict-markers",
    "--strict-config",
    "--cov=myproject",
    "--cov-report=term-missing",
    "--cov-fail-under=80",
]
markers = [
    "slow: marks tests as slow (deselect with '-m not slow')",
    "integration: requires external services (Docker/LocalStack)",
    "property: hypothesis property-based tests",
]
filterwarnings = [
    "error",
    "ignore::DeprecationWarning:botocore.*",
    "ignore::DeprecationWarning:urllib3.*",
]

[tool.coverage.run]
branch = true
source = ["src/myproject"]
omit = [
    "*/__main__.py",
    "*/conftest.py",
]

[tool.coverage.report]
exclude_lines = [
    "pragma: no cover",
    "if TYPE_CHECKING:",
    "if __name__ == .__main__.:",
    "raise NotImplementedError",
]
fail_under = 80
show_missing = true
```

## Recommended test structure

```
tests/
├── conftest.py          # Shared fixtures (scoped appropriately)
├── unit/
│   ├── test_core.py
│   └── test_transforms.py
├── property/            # Hypothesis tests
│   └── test_invariants.py
└── integration/         # Require LocalStack / external services
    ├── conftest.py      # AWS client fixtures
    └── test_s3.py
```

## conftest.py skeleton

```python
# tests/conftest.py
import pytest


def pytest_configure(config):
    """Register custom marks."""
    # marks are already registered in pyproject.toml
    pass
```
