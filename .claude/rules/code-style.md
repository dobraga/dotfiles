---
paths:
  - "**/*.python"
---

This project follows modern Python 3.10+ standards. Prioritize readability, type safety, and logging.

## 1. General Principles
* **Consistency over cleverness:** Code should be easy to scan.
* **Explicit is better than implicit:** Use type hints and clear variable names.
* **Modern Syntax:** Use the latest Python features (e.g., f-strings, `|` for unions, structural pattern matching).

## 2. Logging & Output (Crucial)
**Never use `print()` for application flow or error reporting.**

* **Use `logging`:** use standard library `logging`.
* **Log Levels:**
    * `DEBUG`: Detailed info for diagnosing problems.
    * `INFO`: Confirmation that things are working as expected.
    * `WARNING`: Something unexpected happened, but the app is still working.
    * `ERROR`: A serious problem; the software couldn't perform a function.

```python
import logging

logger = logging.getLogger(__name__)

# DO
logger.info("Fetched %d records from the database", len(records))

# AVOID
print(f"Fetched {len(records)} records") 
```

## 3. Formatting & Structure

* **Formatting:** Use `ruff` for linting and formatting.
* **Imports:** Group imports by: Standard library, Third-party, then Local.

## 4. Type Hinting (Modern Approach)

Use Python 3.10+ syntax. Avoid `typing.Union` or `typing.List`.

```python
# Do
def process(data: list[int | str], name: str | None = None) -> None:
    ...
```

## 5. Modern Patterns

* **F-Strings:** Always use f-strings for string interpolation.
* **Pathlib:** Use `pathlib` instead of `os.path`.

## 6. Data Modeling (Pydantic v2)
Prefer **Pydantic models** over raw dictionaries or standard dataclasses for any data crossing system boundaries (APIs, DBs, Configs).

* **Use Pydantic v2 syntax:** Use `BaseModel` for data structures.
* **Validation:** Leverage built-in validators (`Annotated`, `Field`, `@field_validator`).
* **Immutability:** Use `model_config = ConfigDict(frozen=True)` for models that shouldn't change after creation.
* **Type Safety:** Always use Pydantic for environment variables via `pydantic-settings`.

```python
from pydantic import BaseModel, Field, EmailStr

class User(BaseModel):
    id: int
    username: str = Field(..., min_length=3)
    email: EmailStr
    is_active: bool = True
```

## 7. Error Handling

* **Be specific:** Never use a bare `except:`.
* **Context Managers:** Always use `with` for I/O.
