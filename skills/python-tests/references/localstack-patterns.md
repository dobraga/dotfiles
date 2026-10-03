# LocalStack 3.8 — AWS Mocking via Docker Compose

## docker-compose.yml

Place at the project root. Only enable the services you need via `SERVICES`.

```yaml
# docker-compose.yml
services:
  localstack:
    image: localstack/localstack:3.8
    ports:
      - "4566:4566"       # LocalStack Gateway (all services)
    environment:
      - SERVICES=s3,sqs,dynamodb,lambda,secretsmanager,ssm
      - DEFAULT_REGION=us-east-1
      - EAGER_SERVICE_LOADING=1        # start services immediately
    volumes:
      - localstack_data:/var/lib/localstack
      - /var/run/docker.sock:/var/run/docker.sock  # needed for Lambda
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

volumes:
  localstack_data:
```

Start for integration tests:

```bash
docker compose up -d --wait localstack
```

## pytest fixtures — conftest.py (integration/)

```python
# tests/integration/conftest.py
from __future__ import annotations

from collections.abc import Generator

import boto3
import pytest
from botocore.config import Config
from mypy_boto3_s3 import S3Client
from mypy_boto3_sqs import SQSClient
from mypy_boto3_dynamodb import DynamoDBClient

LOCALSTACK_ENDPOINT = "http://localhost:4566"
AWS_REGION = "us-east-1"

BOTO_CONFIG = Config(
    region_name=AWS_REGION,
    retries={"max_attempts": 1},
)

FAKE_CREDS = {
    "aws_access_key_id": "test",
    "aws_secret_access_key": "test",
    "endpoint_url": LOCALSTACK_ENDPOINT,
    "config": BOTO_CONFIG,
}


# ── S3 ────────────────────────────────────────────────────────────────────────

@pytest.fixture
def s3_client() -> Generator[S3Client, None, None]:
    client: S3Client = boto3.client("s3", **FAKE_CREDS)
    yield client


@pytest.fixture
def s3_bucket(s3_client: S3Client) -> Generator[str, None, None]:
    bucket_name = "test-bucket"
    s3_client.create_bucket(Bucket=bucket_name)
    yield bucket_name
    # teardown: empty and delete
    objs = s3_client.list_objects_v2(Bucket=bucket_name).get("Contents", [])
    if objs:
        s3_client.delete_objects(
            Bucket=bucket_name,
            Delete={"Objects": [{"Key": o["Key"]} for o in objs]},
        )
    s3_client.delete_bucket(Bucket=bucket_name)


# ── SQS ───────────────────────────────────────────────────────────────────────

@pytest.fixture
def sqs_client() -> Generator[SQSClient, None, None]:
    client: SQSClient = boto3.client("sqs", **FAKE_CREDS)
    yield client


@pytest.fixture
def sqs_queue(sqs_client: SQSClient) -> Generator[str, None, None]:
    resp = sqs_client.create_queue(QueueName="test-queue")
    queue_url: str = resp["QueueUrl"]
    yield queue_url
    sqs_client.delete_queue(QueueUrl=queue_url)


# ── DynamoDB ──────────────────────────────────────────────────────────────────

@pytest.fixture
def dynamodb_client() -> Generator[DynamoDBClient, None, None]:
    client: DynamoDBClient = boto3.client("dynamodb", **FAKE_CREDS)
    yield client


@pytest.fixture
def dynamodb_table(dynamodb_client: DynamoDBClient) -> Generator[str, None, None]:
    table_name = "test-table"
    dynamodb_client.create_table(
        TableName=table_name,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    # wait for table to be active
    waiter = dynamodb_client.get_waiter("table_exists")
    waiter.wait(TableName=table_name)
    yield table_name
    dynamodb_client.delete_table(TableName=table_name)
```

## Test examples

### S3 upload / download

```python
# tests/integration/test_s3.py
import pytest
from myproject.storage import upload_file, download_file

@pytest.mark.integration
def test_upload_and_download(s3_client, s3_bucket: str) -> None:
    key = "reports/2024/report.json"
    payload = b'{"status": "ok"}'

    upload_file(s3_client, bucket=s3_bucket, key=key, body=payload)
    result = download_file(s3_client, bucket=s3_bucket, key=key)

    assert result == payload
```

### SQS publish / consume

```python
# tests/integration/test_sqs.py
import json
import pytest
from myproject.queue import publish, consume_one

@pytest.mark.integration
def test_publish_and_consume(sqs_client, sqs_queue: str) -> None:
    msg = {"event": "order.created", "order_id": "abc-123"}

    publish(sqs_client, queue_url=sqs_queue, message=msg)
    received = consume_one(sqs_client, queue_url=sqs_queue)

    assert received == msg
```

### DynamoDB put / get

```python
# tests/integration/test_dynamodb.py
import pytest
from myproject.repository import UserRepository

@pytest.mark.integration
def test_save_and_fetch_user(dynamodb_client, dynamodb_table: str) -> None:
    repo = UserRepository(client=dynamodb_client, table=dynamodb_table)
    user = {"id": "u-1", "name": "Alice", "email": "alice@example.com"}

    repo.save(user)
    fetched = repo.get(user_id="u-1")

    assert fetched["name"] == "Alice"
```

## Environment variable override

Allow CI to point at a different endpoint:

```bash
LOCALSTACK_ENDPOINT=http://localstack:4566 uv run pytest -m integration
```

## Makefile targets

```makefile
.PHONY: localstack-up localstack-down test-integration

localstack-up:
	docker compose up -d --wait localstack

localstack-down:
	docker compose down localstack

test-integration: localstack-up
	uv run pytest -m integration -v
```

## GitHub Actions with LocalStack

```yaml
services:
  localstack:
    image: localstack/localstack:3.8
    ports:
      - "4566:4566"
    env:
      SERVICES: s3,sqs,dynamodb
      DEFAULT_REGION: us-east-1
      EAGER_SERVICE_LOADING: "1"
    options: >-
      --health-cmd "curl -f http://localhost:4566/_localstack/health"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
      --health-start-period 10s

steps:
  - name: Run integration tests
    run: uv run pytest -m integration --cov-report=xml
    env:
      LOCALSTACK_ENDPOINT: http://localhost:4566
```

## Services reference

| Service | SERVICES value | Common operations |
|---|---|---|
| S3 | `s3` | put_object, get_object, list_objects_v2 |
| SQS | `sqs` | send_message, receive_message, delete_message |
| DynamoDB | `dynamodb` | put_item, get_item, query, scan |
| Lambda | `lambda` | create_function, invoke |
| Secrets Manager | `secretsmanager` | create_secret, get_secret_value |
| SSM Parameter Store | `ssm` | put_parameter, get_parameter |
| SNS | `sns` | create_topic, publish, subscribe |
| EventBridge | `events` | put_rule, put_targets, put_events |
