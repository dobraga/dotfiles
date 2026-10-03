# Hypothesis — Property-Based Testing Patterns

## Install

```bash
uv add --group test hypothesis
```

## Core concepts

| Concept | Description |
|---|---|
| `@given(strategy)` | Generates random inputs and runs the test for each |
| `strategies as st` | Built-in data generators |
| `assume(condition)` | Skip a generated example if precondition fails |
| `@settings(...)` | Control max examples, deadline, suppress health checks |
| `@composite` | Build custom strategies from primitives |

## Essential strategies

```python
from hypothesis import strategies as st

st.integers(min_value=0, max_value=100)
st.floats(allow_nan=False, allow_infinity=False)
st.text(min_size=1, max_size=50)
st.text(alphabet=st.characters(whitelist_categories=("Lu", "Ll", "Nd")))
st.lists(st.integers(), min_size=1, max_size=20)
st.dictionaries(st.text(), st.integers())
st.emails()
st.datetimes(timezones=st.just(datetime.timezone.utc))
st.decimals(allow_nan=False, allow_infinity=False)
st.one_of(st.integers(), st.text())   # union type
st.sampled_from(["a", "b", "c"])      # enum-like
st.fixed_dictionaries({"id": st.uuids(), "name": st.text()})
st.builds(MyDataclass, field=st.integers())  # Pydantic / dataclasses
```

## Gold patterns

### 1. Roundtrip / encode-decode invariant

```python
import pytest
from hypothesis import given, strategies as st
from myproject.codec import encode, decode

@pytest.mark.property
@given(st.text())
def test_encode_decode_roundtrip(value: str) -> None:
    assert decode(encode(value)) == value
```

### 2. Commutativity / associativity

```python
@pytest.mark.property
@given(st.integers(), st.integers())
def test_add_is_commutative(a: int, b: int) -> None:
    assert add(a, b) == add(b, a)

@pytest.mark.property
@given(st.lists(st.integers()))
def test_sort_idempotent(items: list[int]) -> None:
    assert sorted(sorted(items)) == sorted(items)
```

### 3. Monotonicity

```python
@pytest.mark.property
@given(st.integers(min_value=0), st.integers(min_value=0))
def test_score_increases_with_more_data(a: int, b: int) -> None:
    assert score(a + b) >= score(a)
```

### 4. Boundary / size invariants

```python
@pytest.mark.property
@given(st.lists(st.integers(), min_size=1))
def test_max_is_member(items: list[int]) -> None:
    assert max(items) in items
```

### 5. State machine (stateful testing)

```python
from hypothesis.stateful import RuleBasedStateMachine, rule, invariant

class ShoppingCartMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.cart = Cart()

    @rule(price=st.decimals(min_value="0.01", max_value="9999", places=2))
    def add_item(self, price: Decimal) -> None:
        self.cart.add(price)

    @rule()
    def clear(self) -> None:
        self.cart.clear()

    @invariant()
    def total_is_non_negative(self) -> None:
        assert self.cart.total() >= Decimal("0")

TestShoppingCart = ShoppingCartMachine.TestCase
```

### 6. Pydantic model generation

```python
from hypothesis import given
from hypothesis import strategies as st
from myproject.models import Order

@pytest.mark.property
@given(st.builds(Order))
def test_order_serializes_and_deserializes(order: Order) -> None:
    json_str = order.model_dump_json()
    restored = Order.model_validate_json(json_str)
    assert restored == order
```

### 7. Custom composite strategy

```python
from hypothesis import composite
from hypothesis import strategies as st

@composite
def valid_email_with_domain(draw, domain: str = "example.com") -> str:
    username = draw(st.text(
        alphabet=st.characters(whitelist_categories=("Ll",)),
        min_size=1, max_size=20,
    ))
    return f"{username}@{domain}"

@given(valid_email_with_domain())
def test_email_parser(email: str) -> None:
    assert "@" in parse_email(email)
```

## Settings best practices

```python
from hypothesis import given, settings, HealthCheck, Phase

# Slower machine or expensive setup
@settings(max_examples=200, deadline=500)
@given(st.text())
def test_heavy(s: str) -> None: ...

# Suppress slow data health check for large fixtures
@settings(suppress_health_check=[HealthCheck.too_slow])
@given(st.lists(st.integers(), min_size=1000))
def test_large(items: list[int]) -> None: ...

# Replay a specific failure (use the printed seed)
@settings(deriving=settings.default, database=None)
@given(st.integers())
def test_repro(n: int) -> None: ...
```

## assume() — filter invalid inputs

```python
from hypothesis import assume

@given(st.integers(), st.integers())
def test_division(a: int, b: int) -> None:
    assume(b != 0)
    assert a / b == a * (1 / b)
```

Prefer narrow strategies over `assume()` when possible — too many discarded examples fails the health check.

## Hypothesis profile (conftest.py)

```python
# tests/conftest.py
from hypothesis import settings, HealthCheck

settings.register_profile("ci", max_examples=500)
settings.register_profile("dev", max_examples=50)
settings.register_profile(
    "fast",
    max_examples=10,
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile("dev")  # override with HYP_PROFILE=ci pytest
```
