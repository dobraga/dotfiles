---
name: snow
description: Connect to Snowflake via snowsql using RSA key pair authentication. Use when the user asks to connect to Snowflake or run a Snowflake query.
---

## Overview

This skill manages Snowflake connections using `snowsql` with RSA key pair authentication (bypassing MFA). It prioritizes named connections defined in `~/.snowsql/config`.

## Step 1 — Verify or Create Connection

Always check if a named connection exists first. If the user doesn't specify one ask for a name.

### A. Check existing connection
```bash
grep "\[connections.<CONNECTION_NAME>\]" ~/.snowsql/config
```

### B. Setup new connection
If the connection does not exist, ask the user for:
1. **Connection Name**
2. **Account Name**
3. **Username**
4. **Private Key Path** (Suggest `~/.ssh/snowflake_rsa_key.p8` if it exists)
5. **Warehouse**
6. **Role**

**Helpful command to generate a key pair if they don't have one:**
```bash
# Generate private key
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out ~/.ssh/snowflake_rsa_key.p8 -nocrypt
# Generate public key
openssl rsa -in ~/.ssh/snowflake_rsa_key.p8 -pubout -out ~/.ssh/snowflake_rsa_key.pub
```
*Note: The user must register the public key in Snowflake UI: `ALTER USER <USER> SET RSA_PUBLIC_KEY='<KEY_BODY>';`*

**Template to append to `~/.snowsql/config`:**
```ini
[connections.<NAME>]
accountname = <ACCOUNT>
username = <USER>
private_key_path = <ABSOLUTE_PATH_TO_P8>
authenticator = SNOWFLAKE_JWT
warehousename = <WAREHOUSE>
rolename = <ROLE>
```

## Step 2 — Check prerequisites

```bash
snowsql -v
```

If `snowsql: command not found`, help the user find or install it:
- Search: `find ~ -name snowsql -type f -executable`
- Install:
```bash
curl -O https://sfc-repo.snowflakecomputing.com/snowsql/bootstrap/1.3/linux_x86_64/snowsql-1.3.1-linux_x86_64.bash
bash snowsql-1.3.1-linux_x86_64.bash
```

## Step 3 — Run the query

Use the named connection:

```bash
snowsql -c <CONNECTION_NAME> -q "<QUERY>"
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `JWT token is invalid` | Public key not registered or fingerprint mismatch. |
| `Failed to load private key` | Use absolute path in `private_key_path` (avoid `~`). |
| `MFA required` | `authenticator = SNOWFLAKE_JWT` is missing or misconfigured. |
| `password is empty` | Ensure `SNOWFLAKE_JWT` is the authenticator. |
