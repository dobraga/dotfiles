# Code Style

Prioritize readability, type safety, and logging.

## 1. General Principles
* **Consistency over cleverness:** Code should be easy to scan.
* **Explicit is better than implicit:** Use type hints and clear variable names.
* **Modern Syntax:** Use the latest Python features (e.g., f-strings, `|` for unions, structural pattern matching).

## 2. Documentation & Typing (Mandatory)
* **Self-Documenting Code:** Minimize inline comments. If code needs an explanation, refactor it into smaller, well-named functions.
* **Docstrings:** Use Google-style docstrings for all public modules, classes, and functions.
* **Type Hinting:** Every function must have a full signature (arguments and return type).

## 3. Logging & Output (Crucial)
**Never use `print()` for application flow or error reporting.**

* **Use `logging`:** use standard library `logging`.
* **Log Levels:**
    * `DEBUG`: Detailed info for diagnosing problems.
    * `INFO`: Confirmation that things are working as expected.
    * `WARNING`: Something unexpected happened, but the app is still working.
    * `ERROR`: A serious problem; the software couldn't perform a function.

## 4. Type Hinting (Modern Approach)

Use Python 3.10+ syntax. Avoid `typing.Union` or `typing.List`.

## 5. Modern Patterns

* **F-Strings:** Always use f-strings for string interpolation.
* **Pathlib:** Use `pathlib` instead of `os.path`.

## 6. Data Modeling (Pydantic v2)
Prefer **Pydantic models** over raw dictionaries or standard dataclasses for any data crossing system boundaries (APIs, DBs, Configs).

* **Use Pydantic v2 syntax:** Use `BaseModel` for data structures.
* **Validation:** Leverage built-in validators (`Annotated`, `Field`, `@field_validator`).
* **Immutability:** Use `model_config = ConfigDict(frozen=True)` for models that shouldn't change after creation.
* **Type Safety:** Always use Pydantic for environment variables via `pydantic-settings`.

## 7. File Organization

* **Functions first:** Place main functions, classes, and core logic at the top of files.
* **Utilities last:** Place helper functions, utilities, and private functions at the bottom.
