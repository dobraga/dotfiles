---
description: Python code standards. Apply to ALL Python files — new code, edits, and reviews.
paths: ["**/*.py"]
---

# Python Code Standards

## File Structure (Intent-First)
Files read top-to-bottom: abstract → concrete.
1. **Entry point first** — `main()`, CLI handler, or primary callable always at the top
2. Public functions and classes below the entry point
3. Private helpers (`_name`) and utilities — **bottom**

## Rules

| Rule | Requirement |
|------|-------------|
| No `print()` | Use `logging` with `INFO` / `DEBUG` levels |
| Paths | `pathlib` only — `os.path` is forbidden |
| Typing | Full hints on all args and return types; `list[str]`, `str \| int` syntax — no `typing` imports |
| Docstrings | Google-style; inline comment needed → extract a named helper instead |
| Data boundaries | APIs, DBs, configs → Pydantic model, never raw `dict` |
| Pydantic validation | `Annotated`, `Field`, `@field_validator` |
| Config / env vars | `pydantic-settings` |
| Scripts | Runnable as `uv run python -m package.module` — always add `if __name__ == "__main__":` guard |
| Constants | Accept config via `pydantic-settings` or CLI args — never hardcoded constants |

## Scripts (Single File with Deps)

Use PEP 723 inline metadata:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "rich"]
# ///
```

Run with: `uv run script.py`

## Examples

```python
# BAD
import os
from typing import List, Optional

def process(data: dict) -> List[str]:
    print("processing")
    path = os.path.join("a", "b")
    ...

# GOOD
import logging
from pathlib import Path
from pydantic import BaseModel
from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

class Settings(BaseSettings):
    output_dir: Path = Path("output")
    debug: bool = False

class ProcessInput(BaseModel):
    data: dict[str, str]

def process(input: ProcessInput, settings: Settings) -> list[str]:
    logger.info("processing")
    path = settings.output_dir / "b"
    ...
```
