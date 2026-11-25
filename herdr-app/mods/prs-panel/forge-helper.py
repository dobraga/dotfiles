#!/usr/bin/env python3
"""GitHub GraphQL & Bitbucket Cloud REST integration helper for Herdr PRs mod.

Manages local profile forge configuration (~/.config/herdr-forge.json, mode 0600),
environment variable fallback (~/.env), local repository auto-detection, parallel
PR syncing, notification event diffing, on-demand PR details, and worktree prep.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PROFILES = [
    {"id": "personal", "name": "Personal"},
    {"id": "work", "name": "Work"},
]

DEFAULT_NOTIFICATIONS = {
    "enabled": True,
    "ci": True,
    "reviews": True,
    "comments": True,
    "reviewRequests": True,
}

ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SSH_COLON_RE = re.compile(r"^(?:[^@]+@)?([^:/]+):(.+)$")
GH_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
GH_LOGIN_CODE_RE = re.compile(r"one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})", re.IGNORECASE)
GH_LOGIN_URL_RE = re.compile(r"(https?://[^\s]+/login/device[^\s]*)")
GH_LOGIN_USER_RE = re.compile(r"Logged in as\s+(\S+)", re.IGNORECASE)

GITHUB_PR_FIELDS = """
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  headRefName
  baseRefName
  headRefOid
  additions
  deletions
  changedFiles
  mergeable
  mergeStateStatus
  reviewDecision
  author { login }
  repository { nameWithOwner url }
  comments { totalCount }
  reviewThreads(first: 50) { nodes { isResolved } }
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { name }
      }
    }
  }
  latestOpinionatedReviews(first: 20) {
    nodes {
      state
      author { login }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 30) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
"""


def forge_config_path() -> Path:
    override = os.environ.get("HERDR_FORGE_CONFIG")
    return Path(override) if override else Path.home() / ".config" / "herdr-forge.json"


def space_folders_path() -> Path:
    override = os.environ.get("HERDR_SPACE_FOLDERS_CONFIG")
    return Path(override) if override else Path.home() / ".config" / "herdr-space-folders.json"


def env_file_path() -> Path:
    override = os.environ.get("HERDR_ENV_FILE")
    return Path(override) if override else Path.home() / ".env"


def cache_dir_path() -> Path:
    override = os.environ.get("HERDR_FORGE_CACHE_DIR")
    return Path(override) if override else Path.home() / ".cache" / "herdr-forge"


def src_root_path() -> Path:
    override = os.environ.get("HERDR_SRC_ROOT")
    return Path(override) if override else Path.home() / "src"


def gh_hosts_file_path() -> Path:
    override = os.environ.get("HERDR_GH_HOSTS_FILE")
    if override:
        return Path(override)
    gh_dir = os.environ.get("GH_CONFIG_DIR")
    return (Path(gh_dir) if gh_dir else Path.home() / ".config" / "gh") / "hosts.yml"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export ") or line.startswith("export\t"):
            line = line[6:].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if not ENV_NAME_RE.match(key):
            continue
        val = val.strip()
        if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")):
            quote = val[0]
            val = val[1:-1]
            if quote == '"':
                val = val.replace('\\"', '"').replace("\\\\", "\\")
        else:
            if " #" in val:
                val = val.split(" #", 1)[0].strip()
        out[key] = val
    return out


def load_env(path: Path | None = None) -> dict[str, str]:
    merged = parse_env_file(path or env_file_path())
    for k, v in os.environ.items():
        merged[k] = v
    return merged


def valid_env_name(name: str | None) -> str:
    s = (name or "").strip()
    return s if ENV_NAME_RE.match(s) else ""


def mask_token(token: str | None) -> str:
    s = (token or "").strip()
    if not s:
        return ""
    if len(s) <= 8:
        return "••••"
    return f"{s[:4]}••••{s[-4:]}"


def normalize_gh_host(host: str | None) -> str:
    s = str(host or "").strip().lower()
    if "://" in s:
        s = urllib.parse.urlparse(s).hostname or ""
    s = s.split("/", 1)[0].strip()
    return s or "github.com"


def github_api_base(host: str | None) -> tuple[str, str]:
    h = normalize_gh_host(host)
    if h == "github.com":
        return "https://api.github.com", "https://api.github.com/graphql"
    return f"https://{h}/api/v3", f"https://{h}/api/graphql"


def default_github_cfg() -> dict:
    return {
        "enabled": False,
        "host": "github.com",
        "account": "",
        "orgs": [],
        "repos": [],
    }


def default_bitbucket_cfg() -> dict:
    return {
        "enabled": False,
        "workspace": "",
        "username": "",
        "repos": [],
        "authMode": "env",
        "userEnvVar": "BB_USER",
        "tokenEnvVar": "BB_TOKEN",
        "user": "",
        "token": "",
    }


def default_profile_cfg() -> dict:
    return {
        "github": default_github_cfg(),
        "bitbucket": default_bitbucket_cfg(),
    }


def default_config() -> dict:
    return {
        "version": 1,
        "pollIntervalSec": 90,
        "notifications": dict(DEFAULT_NOTIFICATIONS),
        "profiles": {},
    }


def normalize_str_list(val) -> list[str]:
    if isinstance(val, str):
        items = [x.strip() for x in val.split(",")]
    elif isinstance(val, list):
        items = [str(x).strip() for x in val]
    else:
        items = []
    seen = set()
    out = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def normalize_profile_cfg(raw: dict | None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    gh_raw = raw.get("github") if isinstance(raw.get("github"), dict) else {}
    bb_raw = raw.get("bitbucket") if isinstance(raw.get("bitbucket"), dict) else {}

    gh = default_github_cfg()
    gh["enabled"] = bool(gh_raw.get("enabled", False))
    gh["host"] = normalize_gh_host(gh_raw.get("host"))
    gh["account"] = str(gh_raw.get("account") or gh_raw.get("username") or "").strip()
    gh["orgs"] = normalize_str_list(gh_raw.get("orgs"))
    gh["repos"] = normalize_str_list(gh_raw.get("repos"))

    bb = default_bitbucket_cfg()
    bb["enabled"] = bool(bb_raw.get("enabled", False))
    bb["workspace"] = str(bb_raw.get("workspace") or "").strip()
    bb["username"] = str(bb_raw.get("username") or "").strip()
    bb["repos"] = normalize_str_list(bb_raw.get("repos"))
    bb["authMode"] = bb_raw.get("authMode") if bb_raw.get("authMode") in ("env", "basic", "bearer") else "env"
    bb_uenv_raw = str(bb_raw.get("userEnvVar") or "").strip()
    bb["userEnvVar"] = bb_uenv_raw if "@" in bb_uenv_raw else (valid_env_name(bb_uenv_raw) or "BB_USER")
    bb["tokenEnvVar"] = valid_env_name(bb_raw.get("tokenEnvVar")) or "BB_TOKEN"
    bb["user"] = str(bb_raw.get("user") or "").strip()
    bb["token"] = str(bb_raw.get("token") or "").strip()

    return {"github": gh, "bitbucket": bb}


def normalize_config(raw: dict | None) -> dict:
    cfg = default_config()
    if not isinstance(raw, dict):
        return cfg
    try:
        poll = int(raw.get("pollIntervalSec", 90))
    except (TypeError, ValueError):
        poll = 90
    cfg["pollIntervalSec"] = max(30, min(600, poll))
    notif_raw = raw.get("notifications") if isinstance(raw.get("notifications"), dict) else {}
    for k, default_val in DEFAULT_NOTIFICATIONS.items():
        cfg["notifications"][k] = bool(notif_raw.get(k, default_val))
    profs = raw.get("profiles") if isinstance(raw.get("profiles"), dict) else {}
    for pid, pcfg in profs.items():
        pid_str = str(pid).strip()
        if pid_str:
            cfg["profiles"][pid_str] = normalize_profile_cfg(pcfg)
    return cfg


def read_json_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_json_atomic(path: Path, data: dict, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    payload = json.dumps(data, indent=2) + "\n"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def load_forge_config() -> dict:
    return normalize_config(read_json_file(forge_config_path()))


def save_forge_config(cfg: dict) -> dict:
    normalized = normalize_config(cfg)
    write_json_atomic(forge_config_path(), normalized, mode=0o600)
    return normalized


def parse_gh_status_output(text: str) -> list[dict]:
    accounts: list[dict] = []
    seen: set[tuple[str, str]] = set()
    last_entry: dict | None = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if not raw[0].isspace():
            last_entry = None
            continue
        m = re.search(r"Logged in to\s+(\S+)\s+(?:account|as)\s+(\S+)", raw)
        if m:
            key = (normalize_gh_host(m.group(1)), m.group(2).strip())
            if key not in seen:
                seen.add(key)
                last_entry = {"host": key[0], "user": key[1], "active": False}
                accounts.append(last_entry)
            continue
        m_act = re.search(r"Active account:\s*(true|false)", raw, re.IGNORECASE)
        if m_act and last_entry is not None:
            last_entry["active"] = m_act.group(1).lower() == "true"
    return accounts


def _hosts_yml_users_line(info: dict, indent: int, stripped: str, users_indent: int) -> bool:
    """Handle a line inside a `users:` block. Returns True while still inside the block."""
    if indent <= users_indent:
        return False
    if stripped.endswith(":") and ":" not in stripped[:-1]:
        acct = stripped[:-1].strip().strip("\"'")
        if acct and acct not in info["users"]:
            info["users"].append(acct)
    return True


def _hosts_yml_apply(info: dict, indent: int, stripped: str, users_indent: int | None) -> int | None:
    """Apply one line of a host block; return the (possibly updated) users-block indent."""
    if users_indent is not None:
        if _hosts_yml_users_line(info, indent, stripped, users_indent):
            return users_indent
        users_indent = None
    if stripped == "users:":
        return indent
    if stripped.startswith("user:"):
        info["user"] = stripped.split(":", 1)[1].strip().strip("\"'")
    return users_indent


def _hosts_yml_collect(lines: list[str]) -> dict[str, dict]:
    hosts_data: dict[str, dict] = {}
    cur_host: str | None = None
    users_indent: int | None = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if indent == 0 and stripped.endswith(":"):
            cur_host = normalize_gh_host(stripped[:-1])
            hosts_data[cur_host] = {"user": "", "users": []}
            users_indent = None
        elif cur_host:
            users_indent = _hosts_yml_apply(hosts_data[cur_host], indent, stripped, users_indent)
    return hosts_data


def parse_gh_hosts_yml(path: Path) -> list[dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for host, info in _hosts_yml_collect(lines).items():
        active = info["user"]
        users = list(info["users"])
        if active and active not in users:
            users.insert(0, active)
        out.extend({"host": host, "user": u, "active": bool(active and u == active)} for u in users)
    return out


def list_gh_accounts(hosts_yml_path: Path | None = None) -> dict:
    installed = bool(shutil.which("gh"))
    merged: dict[tuple[str, str], dict] = {}
    if installed:
        try:
            res = subprocess.run(
                ["gh", "auth", "status"],  # noqa: S607
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            combined = "\n".join(x for x in (res.stdout, res.stderr) if x)
            for item in parse_gh_status_output(combined):
                merged[(item["host"], item["user"])] = item
        except (OSError, subprocess.SubprocessError):
            pass

    for item in parse_gh_hosts_yml(hosts_yml_path or gh_hosts_file_path()):
        key = (item["host"], item["user"])
        if key not in merged:
            merged[key] = item
        elif item.get("active") and not merged[key].get("active"):
            merged[key]["active"] = True

    accounts = sorted(merged.values(), key=lambda x: (0 if x.get("active") else 1, x["host"], x["user"].lower()))
    return {"installed": installed, "accounts": accounts}


def gh_login_state_path() -> Path:
    return cache_dir_path() / "gh-login.json"


def _validate_gh_host(host: str | None) -> str | None:
    raw = (host or "").strip().lower()
    if not raw:
        return "github.com"
    if "://" in raw:
        if not raw.startswith(("http://", "https://")):
            return None
        raw = raw.split("://", 1)[1]
    raw = raw.rstrip("/")
    if not GH_HOST_RE.match(raw):
        return None
    return normalize_gh_host(raw)


def parse_gh_login_output(text: str) -> dict:
    clean = ANSI_RE.sub("", text or "")
    code_m = GH_LOGIN_CODE_RE.search(clean)
    url_m = GH_LOGIN_URL_RE.search(clean)
    user_m = GH_LOGIN_USER_RE.search(clean)
    return {
        "code": code_m.group(1).upper() if code_m else "",
        "url": url_m.group(1).rstrip(".,;)") if url_m else "",
        "user": user_m.group(1).strip() if user_m else "",
    }


def _pid_alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _terminate_pid(pid: int | None) -> None:
    if isinstance(pid, int) and pid > 0 and pid != os.getpid():
        with contextlib.suppress(OSError):
            os.kill(pid, signal.SIGTERM)


def _clean_gh_login_error(text: str) -> str:
    clean = ANSI_RE.sub("", text or "")
    lines = [
        ln.strip()
        for ln in clean.splitlines()
        if ln.strip() and "! First copy" not in ln and "Open this URL" not in ln
    ]
    return " · ".join(lines[-3:])[:240] if lines else "gh auth login failed"


def _detect_logged_in_user(host: str, buf: str, before_accounts: list, after_accounts: list[dict]) -> str:
    parsed_user = parse_gh_login_output(buf)["user"]
    if parsed_user:
        return parsed_user
    prev = {(a[0], a[1]) for a in before_accounts if isinstance(a, (list, tuple)) and len(a) == 2}
    on_host = [a for a in after_accounts if a.get("host") == host]
    preferred = (
        [a for a in on_host if (host, a.get("user")) not in prev]
        or [a for a in on_host if a.get("active")]
        or on_host
    )
    return str(preferred[0].get("user") or "") if preferred else ""


def cancel_gh_login() -> dict:
    path = gh_login_state_path()
    existing = read_json_file(path) or {}
    _terminate_pid(existing.get("ghPid"))
    _terminate_pid(existing.get("workerPid"))
    write_json_atomic(
        path,
        {
            "sessionId": existing.get("sessionId", ""),
            "status": "cancelled",
            "host": existing.get("host", "github.com"),
            "code": "",
            "url": "",
            "user": "",
            "error": "",
            "workerPid": None,
            "ghPid": None,
            "updatedAt": now_iso(),
        },
        mode=0o600,
    )
    return {"ok": True, "status": "cancelled"}


def _gh_login_read_if_current(path: Path, session_id: str) -> dict | None:
    st = read_json_file(path)
    if not isinstance(st, dict) or st.get("sessionId") != session_id or st.get("status") == "cancelled":
        return None
    return st


def _gh_login_update_state(path: Path, session_id: str, **patch) -> dict | None:
    cur = _gh_login_read_if_current(path, session_id)
    if cur is None:
        return None
    cur.update(patch)
    cur["updatedAt"] = now_iso()
    write_json_atomic(path, cur, mode=0o600)
    return cur


def _gh_login_env() -> dict[str, str]:
    env = os.environ.copy()
    env["GH_PROMPT_DISABLED"] = "1"
    env["GH_BROWSER"] = "true"
    env["BROWSER"] = "true"
    for k in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        env.pop(k, None)
    return env


def _terminate_proc(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
        proc.wait(timeout=2)
    except (OSError, subprocess.SubprocessError):
        try:
            proc.kill()
            proc.wait(timeout=1)
        except (OSError, subprocess.SubprocessError):
            pass


def _gh_login_publish_code(path: Path, session_id: str, buf: str) -> bool:
    parsed = parse_gh_login_output(buf)
    if not (parsed["code"] and parsed["url"]):
        return False
    _gh_login_update_state(path, session_id, status="waiting_for_browser", code=parsed["code"], url=parsed["url"])
    return True


def _stream_gh_login_proc(proc: subprocess.Popen, path: Path, session_id: str, timeout_sec: int) -> tuple[str, bool, bool]:
    buf = ""
    seen_code = False
    deadline = time.monotonic() + timeout_sec
    stream = proc.stdout
    fd = stream.fileno() if stream is not None else -1
    while time.monotonic() < deadline:
        if _gh_login_read_if_current(path, session_id) is None:
            _terminate_proc(proc)
            return buf, False, True
        wait = min(0.5, max(0.05, deadline - time.monotonic()))
        ready, _, _ = select.select([fd], [], [], wait) if fd >= 0 else ([], [], [])
        if not ready:
            if proc.poll() is not None:
                break
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        buf += chunk.decode("utf-8", errors="replace")
        seen_code = seen_code or _gh_login_publish_code(path, session_id, buf)
    return buf, time.monotonic() >= deadline, False


def run_gh_login_worker(session_id: str, host: str, timeout_sec: int = 600) -> int:
    path = gh_login_state_path()
    if _gh_login_update_state(path, session_id, workerPid=os.getpid()) is None:
        return 0
    try:
        proc = subprocess.Popen(  # noqa: S603
            ["gh", "auth", "login", "--hostname", host, "--web"],  # noqa: S607
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=_gh_login_env(),
            close_fds=True,
        )
    except OSError as exc:
        _gh_login_update_state(path, session_id, status="error", error=f"Failed to start gh auth login: {exc}", ghPid=None, workerPid=None)
        return 1

    _gh_login_update_state(path, session_id, ghPid=proc.pid)
    buf, timed_out, cancelled = _stream_gh_login_proc(proc, path, session_id, timeout_sec)
    if cancelled:
        return 0
    if timed_out:
        _terminate_proc(proc)
        _gh_login_update_state(path, session_id, status="error", error="GitHub login timed out (code expired). Try again.", ghPid=None, workerPid=None)
        return 1

    rc = proc.wait(timeout=5)
    cur = _gh_login_read_if_current(path, session_id)
    if cur is None:
        return 0
    if rc == 0:
        gh_info = list_gh_accounts()
        user = _detect_logged_in_user(host, buf, cur.get("beforeAccounts") or [], gh_info.get("accounts") or [])
        _gh_login_update_state(path, session_id, status="completed", user=user, error="", ghPid=None, workerPid=None)
        return 0

    _gh_login_update_state(path, session_id, status="error", error=_clean_gh_login_error(buf), ghPid=None, workerPid=None)
    return 1


def get_gh_login_status() -> dict:
    path = gh_login_state_path()
    st = read_json_file(path)
    if not isinstance(st, dict):
        return {"ok": True, "status": "idle"}
    status = st.get("status") or "idle"
    if status in ("starting", "waiting_for_browser"):
        wpid = st.get("workerPid")
        gpid = st.get("ghPid")
        if isinstance(wpid, int) and not _pid_alive(wpid) and not _pid_alive(gpid):
            st["status"] = "error"
            st["error"] = "GitHub login process ended unexpectedly"
            st["workerPid"] = None
            st["ghPid"] = None
            st["updatedAt"] = now_iso()
            write_json_atomic(path, st, mode=0o600)
            status = "error"
    out = {
        "ok": True,
        "sessionId": st.get("sessionId") or "",
        "status": status,
        "host": st.get("host") or "github.com",
        "code": st.get("code") or "",
        "url": st.get("url") or "",
        "user": st.get("user") or "",
        "error": st.get("error") or "",
        "updatedAt": st.get("updatedAt") or "",
    }
    if status == "completed":
        out["gh"] = list_gh_accounts()
    return out


def start_gh_login(host: str | None = None, wait_sec: float = 8.0) -> dict:
    norm_host = _validate_gh_host(host)
    if not norm_host:
        return {"ok": False, "status": "error", "error": f"Invalid GitHub host: {host}"}
    if not shutil.which("gh"):
        return {"ok": False, "status": "error", "error": "gh CLI is not installed"}

    path = gh_login_state_path()
    existing = read_json_file(path)
    if isinstance(existing, dict) and existing.get("status") in ("starting", "waiting_for_browser"):
        cancel_gh_login()

    before_accounts = [[a["host"], a["user"]] for a in list_gh_accounts().get("accounts", [])]
    session_id = hashlib.sha256(f"{os.getpid()}:{time.time()}".encode()).hexdigest()[:12]
    now = now_iso()
    write_json_atomic(
        path,
        {
            "sessionId": session_id,
            "status": "starting",
            "host": norm_host,
            "code": "",
            "url": "",
            "user": "",
            "error": "",
            "workerPid": None,
            "ghPid": None,
            "beforeAccounts": before_accounts,
            "startedAt": now,
            "updatedAt": now,
        },
        mode=0o600,
    )
    subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "_gh-login-worker",
            "--session",
            session_id,
            "--host",
            norm_host,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    deadline = time.monotonic() + wait_sec
    while time.monotonic() < deadline:
        st = read_json_file(path)
        if isinstance(st, dict) and st.get("sessionId") == session_id and st.get("status") != "starting":
            break
        time.sleep(0.15)
    return get_gh_login_status()


def sanitize_config(cfg: dict, env: dict[str, str], include_gh_accounts: bool = True) -> dict:
    norm = normalize_config(cfg)
    profiles_out = {}
    for pid, pcfg in norm["profiles"].items():
        gh = dict(pcfg["github"])

        bb = dict(pcfg["bitbucket"])
        bb_tok = bb.pop("token", "")
        bb["hasToken"] = bool(bb_tok)
        bb["tokenPreview"] = mask_token(bb_tok)
        u_field = str(bb.get("user") or "").strip()
        uvar_raw = str(bb.get("userEnvVar") or "").strip()
        if "@" in u_field:
            resolved_user = u_field
        elif "@" in uvar_raw:
            resolved_user = uvar_raw
        elif u_field:
            resolved_user = u_field
        elif valid_env_name(uvar_raw):
            resolved_user = str(env.get(uvar_raw) or "").strip()
        else:
            resolved_user = ""
        resolved_env_tok = str(env.get(bb["tokenEnvVar"], "") or "").strip()
        bb["userEnvFound"] = bool(resolved_user)
        bb["userIsEmail"] = "@" in resolved_user
        bb["userNeedsEmailHint"] = bool(
            bb["authMode"] == "env"
            and resolved_env_tok.startswith("ATAT")
            and resolved_user
            and "@" not in resolved_user
        )
        bb["tokenEnvFound"] = bool(resolved_env_tok)
        bb["token"] = ""

        profiles_out[pid] = {"github": gh, "bitbucket": bb}
    out = {
        "version": norm["version"],
        "pollIntervalSec": norm["pollIntervalSec"],
        "notifications": dict(norm["notifications"]),
        "profiles": profiles_out,
    }
    if include_gh_accounts:
        out["gh"] = list_gh_accounts()
    return out


def _apply_token_action(existing_tok: str, incoming: dict) -> str:
    action = incoming.get("tokenAction")
    new_tok = str(incoming.get("token") or "").strip()
    if action == "clear":
        return ""
    if action == "set":
        return new_tok if new_tok else existing_tok
    if action == "keep":
        return existing_tok
    # Fallback if tokenAction omitted: keep existing unless a non-empty token is passed
    return new_tok if new_tok else existing_tok


def merge_config_update(existing: dict, update: dict) -> dict:
    base = normalize_config(existing)
    if not isinstance(update, dict):
        return base

    if "pollIntervalSec" in update:
        try:
            base["pollIntervalSec"] = max(30, min(600, int(update["pollIntervalSec"])))
        except (TypeError, ValueError):
            pass

    if isinstance(update.get("notifications"), dict):
        for k in DEFAULT_NOTIFICATIONS:
            if k in update["notifications"]:
                base["notifications"][k] = bool(update["notifications"][k])

    if isinstance(update.get("profiles"), dict):
        for pid, p_upd in update["profiles"].items():
            pid_str = str(pid).strip()
            if not pid_str or not isinstance(p_upd, dict):
                continue
            prev_p = base["profiles"].get(pid_str) or default_profile_cfg()
            merged_p = normalize_profile_cfg(p_upd)
            if not isinstance(p_upd.get("github"), dict):
                merged_p["github"] = prev_p["github"]
            if isinstance(p_upd.get("bitbucket"), dict):
                merged_p["bitbucket"]["token"] = _apply_token_action(prev_p["bitbucket"]["token"], p_upd["bitbucket"])
            else:
                merged_p["bitbucket"] = prev_p["bitbucket"]
            base["profiles"][pid_str] = merged_p
    return base


def read_space_folders() -> dict:
    data = read_json_file(space_folders_path()) or {}
    profiles = data.get("profiles")
    if not isinstance(profiles, list):
        profiles = list(DEFAULT_PROFILES)
    return {
        "list": data.get("list") if isinstance(data.get("list"), list) else [],
        "of": data.get("of") if isinstance(data.get("of"), dict) else {},
        "profiles": profiles,
    }


def parse_remote_url(url: str | None) -> dict | None:
    s = (url or "").strip()
    if not s:
        return None
    host = ""
    path = ""
    if "://" in s:
        parsed = urllib.parse.urlparse(s)
        host = (parsed.hostname or "").lower()
        path = (parsed.path or "").lstrip("/")
    else:
        m = SSH_COLON_RE.match(s)
        if not m:
            return None
        host = m.group(1).lower()
        path = m.group(2).lstrip("/")

    if "github" in host:
        provider = "github"
    elif "bitbucket" in host:
        provider = "bitbucket"
    else:
        return None

    path = path.rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1]
    full = f"{owner}/{repo}"
    return {
        "provider": provider,
        "owner": owner,
        "repo": repo,
        "full": full,
        "slug": f"{provider}:{full.lower()}",
    }


def git_origin_url(repo_dir: Path) -> str | None:
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_dir), "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def discover_local_repos(
    sf_data: dict | None = None,
    src_dir: Path | None = None,
) -> tuple[dict[str, str], list[dict]]:
    sf_data = sf_data or read_space_folders()
    src_dir = src_dir or src_root_path()
    slug_to_path: dict[str, str] = {}
    records: list[dict] = []
    seen_dirs: set[str] = set()

    def inspect_dir(dir_path: Path, profile_id: str | None) -> None:
        try:
            resolved = dir_path.expanduser().resolve()
        except OSError:
            return
        if not resolved.is_dir():
            return
        if not (resolved / ".git").exists():
            return
        key = str(resolved)
        if key in seen_dirs:
            return
        seen_dirs.add(key)
        remote = parse_remote_url(git_origin_url(resolved))
        if not remote:
            return
        slug_to_path.setdefault(remote["slug"], key)
        records.append({
            "path": key,
            "profile": profile_id,
            **remote,
        })

    for folder in sf_data.get("list", []):
        p = folder.get("path")
        if p:
            inspect_dir(Path(p), folder.get("profile") or None)

    if src_dir.is_dir():
        try:
            for entry in sorted(src_dir.iterdir()):
                if entry.is_dir() and not entry.name.startswith("."):
                    inspect_dir(entry, None)
        except OSError:
            pass

    return slug_to_path, records


def _profile_records(records: list[dict], pid: str) -> list[dict]:
    recs = [r for r in records if r.get("profile") == pid]
    if recs:
        return recs
    # Fall back to unassigned repos in ~/src for default personal/work profiles
    fallback = {"personal": "github", "work": "bitbucket"}.get(pid)
    return [r for r in records if r["provider"] == fallback] if fallback else []


def _suggest_github(gh_recs: list[dict], gh_accounts: list[dict]) -> tuple[dict, str]:
    cfg = default_github_cfg()
    owners = sorted({r["owner"] for r in gh_recs})
    lowered = {o.lower() for o in owners}
    cfg["enabled"] = True
    cfg["host"] = "github.com"
    matched = next((a["user"] for a in gh_accounts if a["user"].lower() in lowered), "")
    cfg["account"] = matched or (owners[0] if len(owners) == 1 else "")
    return cfg, f"GitHub (gh CLI): detected {', '.join(owners)} ({len(gh_recs)} repos)"


def _suggest_bitbucket(bb_recs: list[dict], env: dict[str, str], found: dict[str, bool]) -> tuple[dict, list[str]]:
    cfg = default_bitbucket_cfg()
    workspace = min({r["owner"] for r in bb_recs})
    cfg.update(
        enabled=True,
        workspace=workspace,
        authMode="env",
        userEnvVar="BB_EMAIL" if found["BB_EMAIL"] else "BB_USER",
        tokenEnvVar="BB_TOKEN",
    )
    if env.get("BB_USER"):
        cfg["username"] = env["BB_USER"]
    reasons = [f"Bitbucket: workspace '{workspace}' ({len(bb_recs)} repos)"]
    if found["BB_TOKEN"] and (found["BB_EMAIL"] or found["BB_USER"]):
        reasons.append("Found BB_TOKEN in env/.env")
    return cfg, reasons


def detect_profiles_config() -> dict:
    sf = read_space_folders()
    env = load_env()
    _, records = discover_local_repos(sf)
    gh_accounts = list_gh_accounts().get("accounts", [])
    env_detected = {k: bool(env.get(k)) for k in ("BB_USER", "BB_EMAIL", "BB_TOKEN")}

    suggestions: dict[str, dict] = {}
    for prof in sf.get("profiles", DEFAULT_PROFILES):
        pid = prof.get("id")
        if not pid:
            continue
        prof_recs = _profile_records(records, pid)
        gh_recs = [r for r in prof_recs if r["provider"] == "github"]
        bb_recs = [r for r in prof_recs if r["provider"] == "bitbucket"]
        gh_cfg, bb_cfg = default_github_cfg(), default_bitbucket_cfg()
        reasons: list[str] = []
        if gh_recs:
            gh_cfg, reason = _suggest_github(gh_recs, gh_accounts)
            reasons.append(reason)
        if bb_recs:
            bb_cfg, bb_reasons = _suggest_bitbucket(bb_recs, env, env_detected)
            reasons.extend(bb_reasons)
        suggestions[pid] = {"github": gh_cfg, "bitbucket": bb_cfg, "reasons": reasons}

    return {"suggestions": suggestions, "envDetected": env_detected, "gh": list_gh_accounts()}


def http_json(
    url: str,
    headers: dict[str, str],
    method: str = "GET",
    body: dict | None = None,
    timeout: int = 20,
) -> tuple[int, dict[str, str], dict | list | str]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = raw
            return resp.status, resp_headers, parsed
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        resp_headers = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = raw
        return e.code, resp_headers, parsed


def resolve_gh_cli_token(gh_cfg: dict) -> tuple[str, str | None]:
    if not shutil.which("gh"):
        return "", "gh CLI is not installed"
    host = normalize_gh_host(gh_cfg.get("host"))
    account = str(gh_cfg.get("account") or "").strip()
    args = ["gh", "auth", "token", "--hostname", host]
    if account:
        args.extend(["--user", account])
    try:
        res = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)  # noqa: S603
    except (OSError, subprocess.SubprocessError) as exc:
        return "", f"gh auth token failed: {exc}"
    tok = (res.stdout or "").strip()
    if res.returncode != 0 or not tok:
        if account:
            return "", f"gh CLI account '{account}' on {host} not logged in (run: gh auth login)"
        return "", f"Not logged in to gh CLI on {host} (run: gh auth login)"
    return tok, None


def github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "herdr-prs-mod",
        "Content-Type": "application/json",
    }


def _gh_ci_status(rollup: dict | None) -> tuple[str, list[dict]]:
    if not rollup:
        return "none", []
    raw_state = (rollup.get("state") or "").upper()
    if raw_state == "SUCCESS":
        ci_state = "success"
    elif raw_state in ("FAILURE", "ERROR"):
        ci_state = "failure"
    elif raw_state in ("PENDING", "EXPECTED"):
        ci_state = "pending"
    else:
        ci_state = "none"

    checks: list[dict] = []
    nodes = ((rollup.get("contexts") or {}).get("nodes")) or []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        tname = n.get("__typename")
        if tname == "CheckRun":
            status = (n.get("status") or "").upper()
            conc = (n.get("conclusion") or "").upper()
            if status != "COMPLETED":
                st = "pending"
            elif conc in ("SUCCESS", "NEUTRAL", "SKIPPED"):
                st = "success"
            else:
                st = "failure"
            checks.append({
                "name": n.get("name") or "check",
                "status": st,
                "url": n.get("detailsUrl") or "",
            })
        elif tname == "StatusContext":
            st_raw = (n.get("state") or "").upper()
            st = "success" if st_raw == "SUCCESS" else ("pending" if st_raw == "PENDING" else "failure")
            checks.append({
                "name": n.get("context") or "status",
                "status": st,
                "url": n.get("targetUrl") or "",
            })
    return ci_state, checks


def normalize_github_pr(
    node: dict,
    profile_id: str,
    is_mine: bool,
    is_review: bool,
    local_repos: dict[str, str],
) -> dict:
    repo_full = ((node.get("repository") or {}).get("nameWithOwner")) or ""
    repo_short = repo_full.split("/")[-1] if "/" in repo_full else repo_full
    slug = f"github:{repo_full.lower()}"
    number = int(node.get("number") or 0)
    key = f"github:{repo_full.lower()}#{number}"

    commit_nodes = ((node.get("commits") or {}).get("nodes")) or []
    rollup = None
    if commit_nodes and isinstance(commit_nodes[0], dict):
        rollup = ((commit_nodes[0].get("commit") or {}).get("statusCheckRollup"))
    ci_state, checks = _gh_ci_status(rollup)

    reviewers_map: dict[str, str] = {}
    for req in ((node.get("reviewRequests") or {}).get("nodes")) or []:
        rr = (req or {}).get("requestedReviewer") or {}
        name = rr.get("login") or rr.get("name")
        if name:
            reviewers_map[name] = "pending"
    for rev in ((node.get("latestOpinionatedReviews") or {}).get("nodes")) or []:
        name = ((rev or {}).get("author") or {}).get("login")
        raw_st = ((rev or {}).get("state") or "").upper()
        if not name:
            continue
        if raw_st == "APPROVED":
            reviewers_map[name] = "approved"
        elif raw_st == "CHANGES_REQUESTED":
            reviewers_map[name] = "changes_requested"
        elif raw_st == "COMMENTED" and name not in reviewers_map:
            reviewers_map[name] = "commented"

    reviewers = [{"name": k, "state": v} for k, v in reviewers_map.items()]
    approvals = sum(1 for r in reviewers if r["state"] == "approved")
    changes_requested = sum(1 for r in reviewers if r["state"] == "changes_requested")
    decision = (node.get("reviewDecision") or "").upper()
    if changes_requested > 0 or decision == "CHANGES_REQUESTED":
        review_state = "changes_requested"
    elif approvals > 0 or decision == "APPROVED":
        review_state = "approved"
    else:
        review_state = "pending"

    threads = ((node.get("reviewThreads") or {}).get("nodes")) or []
    unresolved = sum(1 for t in threads if isinstance(t, dict) and t.get("isResolved") is False)
    comments_total = int(((node.get("comments") or {}).get("totalCount")) or 0)

    return {
        "key": key,
        "profileId": profile_id,
        "provider": "github",
        "repo": repo_full,
        "repoShort": repo_short,
        "localPath": local_repos.get(slug),
        "number": number,
        "title": node.get("title") or "",
        "url": node.get("url") or "",
        "author": ((node.get("author") or {}).get("login")) or "",
        "isMine": bool(is_mine),
        "isReviewRequested": bool(is_review),
        "draft": bool(node.get("isDraft", False)),
        "createdAt": node.get("createdAt") or "",
        "updatedAt": node.get("updatedAt") or "",
        "sourceBranch": node.get("headRefName") or "",
        "targetBranch": node.get("baseRefName") or "",
        "headSha": (node.get("headRefOid") or "")[:12],
        "ciState": ci_state,
        "checks": checks,
        "reviewState": review_state,
        "approvals": approvals,
        "changesRequested": changes_requested,
        "reviewers": reviewers,
        "conflicts": node.get("mergeable") == "CONFLICTING",
        "commentCount": comments_total,
        "unresolvedCount": unresolved,
        "additions": int(node.get("additions") or 0),
        "deletions": int(node.get("deletions") or 0),
        "changedFiles": int(node.get("changedFiles") or 0),
    }


def _gh_scope_clauses(gh_cfg: dict) -> str:
    repos = normalize_str_list(gh_cfg.get("repos"))
    orgs = normalize_str_list(gh_cfg.get("orgs"))
    if repos:
        return " ".join(f"repo:{r}" for r in repos)
    if orgs:
        return " ".join(f"org:{o}" for o in orgs)
    return ""


def fetch_github_prs(
    profile_id: str,
    gh_cfg: dict,
    env: dict[str, str],
    local_repos: dict[str, str],
) -> tuple[list[dict], str | None]:
    del env
    token, err = resolve_gh_cli_token(gh_cfg)
    if err:
        return [], err

    actor = (gh_cfg.get("account") or "").strip() or "@me"
    scope = _gh_scope_clauses(gh_cfg)
    mine_q = f"is:pr is:open author:{actor} {scope}".strip()
    rev_q = f"is:pr is:open user-review-requested:{actor} -author:{actor} {scope}".strip()

    query = f"""
    query($mineQ: String!, $revQ: String!) {{
      mine: search(query: $mineQ, type: ISSUE, first: 30) {{
        nodes {{ ... on PullRequest {{ {GITHUB_PR_FIELDS} }} }}
      }}
      reviewing: search(query: $revQ, type: ISSUE, first: 30) {{
        nodes {{ ... on PullRequest {{ {GITHUB_PR_FIELDS} }} }}
      }}
    }}
    """
    _, graphql_url = github_api_base(gh_cfg.get("host"))
    status, _, payload = http_json(
        graphql_url,
        headers=github_headers(token),
        method="POST",
        body={"query": query, "variables": {"mineQ": mine_q, "revQ": rev_q}},
    )
    if status != 200 or not isinstance(payload, dict):
        msg = payload.get("message") if isinstance(payload, dict) else str(payload)
        return [], f"GitHub HTTP {status}: {msg}"
    if payload.get("errors") and not payload.get("data"):
        errs = "; ".join(str(e.get("message", e)) for e in payload["errors"])
        return [], f"GitHub GraphQL error: {errs}"

    data = payload.get("data") or {}
    by_key: dict[str, dict] = {}
    for node in ((data.get("mine") or {}).get("nodes")) or []:
        if isinstance(node, dict) and node.get("number"):
            pr = normalize_github_pr(node, profile_id, True, False, local_repos)
            by_key[pr["key"]] = pr
    for node in ((data.get("reviewing") or {}).get("nodes")) or []:
        if isinstance(node, dict) and node.get("number"):
            pr = normalize_github_pr(node, profile_id, False, True, local_repos)
            if pr["key"] in by_key:
                by_key[pr["key"]]["isReviewRequested"] = True
            else:
                by_key[pr["key"]] = pr

    err_note = None
    if payload.get("errors"):
        err_note = "; ".join(str(e.get("message", e)) for e in payload["errors"])
    return list(by_key.values()), err_note


def test_github(gh_cfg: dict, env: dict[str, str] | None = None) -> dict:
    del env
    token, err = resolve_gh_cli_token(gh_cfg)
    if err:
        return {"ok": False, "error": err, "hint": "Run 'gh auth login' in a terminal (supports multiple accounts)."}
    rest_base, _ = github_api_base(gh_cfg.get("host"))
    status, hdrs, payload = http_json(f"{rest_base}/user", headers=github_headers(token))
    if status != 200 or not isinstance(payload, dict):
        msg = payload.get("message") if isinstance(payload, dict) else str(payload)
        hint = "Run 'gh auth refresh -s read:org,repo' or check SSO authorization." if status in (401, 403) else ""
        return {"ok": False, "error": f"GitHub HTTP {status}: {msg}", "hint": hint}
    return {
        "ok": True,
        "identity": payload.get("login") or "",
        "displayName": payload.get("name") or payload.get("login") or "",
        "scopes": hdrs.get("x-oauth-scopes", ""),
        "rateLimitRemaining": hdrs.get("x-ratelimit-remaining", ""),
    }


def fetch_github_detail(gh_cfg: dict, env: dict[str, str], repo_full: str, number: int) -> dict:
    del env
    token, err = resolve_gh_cli_token(gh_cfg)
    if err:
        return {"ok": False, "error": err}
    if "/" not in repo_full:
        return {"ok": False, "error": f"Invalid repo slug: {repo_full}"}
    owner, name = repo_full.split("/", 1)
    query = """
    query($owner: String!, $name: String!, $num: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $num) {
          body
          comments(last: 10) {
            nodes {
              author { login }
              bodyText
              createdAt
              url
            }
          }
          reviewThreads(last: 15) {
            nodes {
              isResolved
              path
              comments(last: 1) {
                nodes {
                  author { login }
                  bodyText
                  createdAt
                  url
                }
              }
            }
          }
        }
      }
    }
    """
    _, graphql_url = github_api_base(gh_cfg.get("host"))
    status, _, payload = http_json(
        graphql_url,
        headers=github_headers(token),
        method="POST",
        body={"query": query, "variables": {"owner": owner, "name": name, "num": number}},
    )
    if status != 200 or not isinstance(payload, dict):
        msg = payload.get("message") if isinstance(payload, dict) else str(payload)
        return {"ok": False, "error": f"GitHub HTTP {status}: {msg}"}
    pr_node = (((payload.get("data") or {}).get("repository") or {}).get("pullRequest")) or {}
    comments = []
    for c in ((pr_node.get("comments") or {}).get("nodes")) or []:
        if isinstance(c, dict):
            comments.append({
                "author": ((c.get("author") or {}).get("login")) or "user",
                "text": (c.get("bodyText") or "").strip(),
                "createdAt": c.get("createdAt") or "",
                "url": c.get("url") or "",
                "path": "",
            })
    for t in ((pr_node.get("reviewThreads") or {}).get("nodes")) or []:
        if not isinstance(t, dict) or t.get("isResolved"):
            continue
        cnodes = ((t.get("comments") or {}).get("nodes")) or []
        if cnodes and isinstance(cnodes[0], dict):
            c = cnodes[0]
            comments.append({
                "author": ((c.get("author") or {}).get("login")) or "reviewer",
                "text": (c.get("bodyText") or "").strip(),
                "createdAt": c.get("createdAt") or "",
                "url": c.get("url") or "",
                "path": t.get("path") or "",
                "unresolved": True,
            })
    comments.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return {
        "ok": True,
        "description": (pr_node.get("body") or "").strip(),
        "comments": comments[:10],
    }


def _basic_auth(user: str, token: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode("ascii")


def _bb_env_user(bb_cfg: dict, env: dict[str, str]) -> str:
    user_field = str(bb_cfg.get("user") or "").strip()
    uvar_raw = str(bb_cfg.get("userEnvVar") or "").strip()
    if "@" in user_field:
        return user_field
    if "@" in uvar_raw:
        return uvar_raw
    if user_field:
        return user_field
    if valid_env_name(uvar_raw):
        return str(env.get(uvar_raw) or "").strip()
    return ""


def _bb_auth_bearer(bb_cfg: dict, env: dict[str, str], tvar: str) -> tuple[str, str | None]:
    token = str(bb_cfg.get("token") or "").strip() or str(env.get(tvar) or "").strip()
    if not token:
        return "", "Bitbucket Bearer token is not configured"
    return f"Bearer {token}", None


def _bb_auth_basic(bb_cfg: dict) -> tuple[str, str | None]:
    user = str(bb_cfg.get("user") or "").strip()
    token = str(bb_cfg.get("token") or "").strip()
    if not user or not token:
        return "", "Bitbucket Basic auth requires both User and Token"
    return _basic_auth(user, token), None


def _bb_auth_env(bb_cfg: dict, env: dict[str, str], tvar: str) -> tuple[str, str | None]:
    token = str(env.get(tvar) or "").strip()
    if not token:
        return "", f"Bitbucket token env var '{tvar}' is not set"
    user = _bb_env_user(bb_cfg, env)
    return (_basic_auth(user, token) if user else f"Bearer {token}"), None


def _bb_auth(bb_cfg: dict, env: dict[str, str], mode: str) -> tuple[str, str | None]:
    """Return (Authorization value, error)."""
    tvar = valid_env_name(bb_cfg.get("tokenEnvVar")) or "BB_TOKEN"
    if mode == "bearer":
        return _bb_auth_bearer(bb_cfg, env, tvar)
    if mode == "basic":
        return _bb_auth_basic(bb_cfg)
    return _bb_auth_env(bb_cfg, env, tvar)


def bitbucket_headers(bb_cfg: dict, env: dict[str, str]) -> tuple[dict[str, str], str, str | None]:
    mode = bb_cfg.get("authMode", "env")
    auth_val, err = _bb_auth(bb_cfg, env, mode)
    if err:
        return {}, mode, err
    return {"Authorization": auth_val, "Accept": "application/json", "User-Agent": "herdr-prs-mod"}, mode, None


def _load_cache() -> dict:
    path = cache_dir_path() / "cache.json"
    data = read_json_file(path)
    if not isinstance(data, dict):
        return {"identities": {}, "diffstats": {}}
    data.setdefault("identities", {})
    data.setdefault("diffstats", {})
    return data


def _save_cache(cache: dict) -> None:
    # Keep bounded cache size
    if len(cache.get("diffstats", {})) > 300:
        keys = list(cache["diffstats"].keys())[-200:]
        cache["diffstats"] = {k: cache["diffstats"][k] for k in keys}
    write_json_atomic(cache_dir_path() / "cache.json", cache, mode=0o600)


def _bb_identity(headers: dict[str, str], bb_cfg: dict, cache: dict) -> tuple[dict, str | None]:
    auth_hash = hashlib.sha256(headers.get("Authorization", "").encode("utf-8")).hexdigest()[:16]
    cached = cache["identities"].get(auth_hash)
    if isinstance(cached, dict) and (cached.get("uuid") or cached.get("username") or cached.get("account_id")):
        return cached, None

    status, _, payload = http_json("https://api.bitbucket.org/2.0/user", headers=headers)
    if status == 200 and isinstance(payload, dict):
        ident = {
            "uuid": payload.get("uuid") or "",
            "account_id": payload.get("account_id") or "",
            "username": payload.get("username") or "",
            "nickname": payload.get("nickname") or "",
            "display_name": payload.get("display_name") or "",
        }
        cache["identities"][auth_hash] = ident
        return ident, None

    fallback_user = (bb_cfg.get("username") or bb_cfg.get("user") or "").strip()
    if status in (401, 403) and fallback_user:
        return {"username": fallback_user, "nickname": fallback_user}, None

    msg = ((payload.get("error") or {}).get("message")) if isinstance(payload, dict) else str(payload)
    return {}, f"Bitbucket /user HTTP {status}: {msg or 'authentication failed'}"


def _bb_user_matches(actor: dict | None, ident: dict, cfg_username: str) -> bool:
    if not isinstance(actor, dict):
        return False
    for field in ("uuid", "account_id"):
        a = (actor.get(field) or "").strip()
        b = (ident.get(field) or "").strip()
        if a and b and a == b:
            return True
    candidates = {
        str(ident.get("username") or "").strip().lower(),
        str(ident.get("nickname") or "").strip().lower(),
        str(ident.get("display_name") or "").strip().lower(),
        str(cfg_username or "").strip().lower(),
    } - {""}
    for field in ("username", "nickname", "display_name"):
        val = str(actor.get(field) or "").strip().lower()
        if val and val in candidates:
            return True
    return False


def _bb_ci_status(statuses_payload: dict | list | None) -> tuple[str, list[dict]]:
    values = statuses_payload.get("values", []) if isinstance(statuses_payload, dict) else []
    checks: list[dict] = []
    has_fail = False
    has_pend = False
    has_ok = False
    for s in values:
        if not isinstance(s, dict):
            continue
        raw = (s.get("state") or "").upper()
        if raw == "SUCCESSFUL":
            st = "success"
            has_ok = True
        elif raw == "INPROGRESS":
            st = "pending"
            has_pend = True
        else:
            st = "failure"
            has_fail = True
        checks.append({
            "name": s.get("name") or s.get("key") or "pipeline",
            "status": st,
            "url": s.get("url") or "",
        })
    ci_state = "failure" if has_fail else ("pending" if has_pend else ("success" if has_ok else "none"))
    return ci_state, checks


def normalize_bitbucket_pr(
    raw: dict,
    statuses_payload: dict | None,
    diffstat_summary: dict | None,
    ident: dict,
    bb_cfg: dict,
    profile_id: str,
    local_repos: dict[str, str],
) -> dict:
    dest_repo = ((raw.get("destination") or {}).get("repository") or {}).get("full_name")
    src_repo = ((raw.get("source") or {}).get("repository") or {}).get("full_name")
    repo_full = dest_repo or src_repo or ""
    repo_short = repo_full.split("/")[-1] if "/" in repo_full else repo_full
    slug = f"bitbucket:{repo_full.lower()}"
    number = int(raw.get("id") or 0)
    key = f"bitbucket:{repo_full.lower()}#{number}"

    cfg_user = str(bb_cfg.get("username") or "").strip()
    author_obj = raw.get("author") or {}
    is_mine = _bb_user_matches(author_obj, ident, cfg_user)

    participants = raw.get("participants") or []
    raw_reviewers = raw.get("reviewers") or []
    is_review = False
    if not is_mine:
        if any(_bb_user_matches(r, ident, cfg_user) for r in raw_reviewers):
            is_review = True
        elif any((p.get("role") == "REVIEWER") and _bb_user_matches(p.get("user"), ident, cfg_user) for p in participants):
            is_review = True

    reviewers_map: dict[str, str] = {}
    for r in raw_reviewers:
        name = r.get("display_name") or r.get("nickname") or r.get("username")
        if name:
            reviewers_map[name] = "pending"
    for p in participants:
        u = p.get("user") or {}
        name = u.get("display_name") or u.get("nickname") or u.get("username")
        if not name:
            continue
        state_raw = (p.get("state") or "").lower()
        approved = bool(p.get("approved", False))
        role = (p.get("role") or "").upper()
        if state_raw == "changes_requested":
            reviewers_map[name] = "changes_requested"
        elif approved or state_raw == "approved":
            reviewers_map[name] = "approved"
        elif role == "REVIEWER" and name not in reviewers_map:
            reviewers_map[name] = "pending"

    reviewers = [{"name": k, "state": v} for k, v in reviewers_map.items()]
    approvals = sum(1 for r in reviewers if r["state"] == "approved")
    changes_requested = sum(1 for r in reviewers if r["state"] == "changes_requested")
    if changes_requested > 0:
        review_state = "changes_requested"
    elif approvals > 0:
        review_state = "approved"
    else:
        review_state = "pending"

    ci_state, checks = _bb_ci_status(statuses_payload)
    ds = diffstat_summary or {"additions": 0, "deletions": 0, "changedFiles": 0}
    head_sha = ((((raw.get("source") or {}).get("commit") or {}).get("hash")) or "")[:12]

    return {
        "key": key,
        "profileId": profile_id,
        "provider": "bitbucket",
        "repo": repo_full,
        "repoShort": repo_short,
        "localPath": local_repos.get(slug),
        "number": number,
        "title": raw.get("title") or "",
        "url": (((raw.get("links") or {}).get("html") or {}).get("href")) or "",
        "author": author_obj.get("display_name") or author_obj.get("nickname") or author_obj.get("username") or "",
        "isMine": bool(is_mine),
        "isReviewRequested": bool(is_review),
        "draft": bool(raw.get("draft", False)),
        "createdAt": raw.get("created_on") or "",
        "updatedAt": raw.get("updated_on") or "",
        "sourceBranch": ((raw.get("source") or {}).get("branch") or {}).get("name") or "",
        "targetBranch": ((raw.get("destination") or {}).get("branch") or {}).get("name") or "",
        "headSha": head_sha,
        "ciState": ci_state,
        "checks": checks,
        "reviewState": review_state,
        "approvals": approvals,
        "changesRequested": changes_requested,
        "reviewers": reviewers,
        "conflicts": None,
        "commentCount": int(raw.get("comment_count") or 0),
        "unresolvedCount": int(raw.get("task_count") or 0),
        "additions": int(ds.get("additions") or 0),
        "deletions": int(ds.get("deletions") or 0),
        "changedFiles": int(ds.get("changedFiles") or 0),
    }


def _summarize_diffstat(payload: dict | list | str) -> dict:
    values = payload.get("values", []) if isinstance(payload, dict) else []
    additions = 0
    deletions = 0
    for item in values:
        if isinstance(item, dict):
            additions += int(item.get("lines_added") or 0)
            deletions += int(item.get("lines_removed") or 0)
    return {"additions": additions, "deletions": deletions, "changedFiles": len(values)}


def fetch_bitbucket_prs(
    profile_id: str,
    bb_cfg: dict,
    env: dict[str, str],
    local_repos: dict[str, str],
    cache: dict,
) -> tuple[list[dict], str | None]:
    headers, _, err = bitbucket_headers(bb_cfg, env)
    if err:
        return [], err
    workspace = (bb_cfg.get("workspace") or "").strip()
    if not workspace:
        return [], "Bitbucket workspace is not configured"

    ident, ident_err = _bb_identity(headers, bb_cfg, cache)
    if ident_err and not bb_cfg.get("repos"):
        return [], ident_err

    repos = normalize_str_list(bb_cfg.get("repos"))
    raw_items: list[dict] = []

    if repos:
        def _fetch_repo_prs(repo_name: str) -> list[dict]:
            slug = repo_name.split("/")[-1] if "/" in repo_name else repo_name
            ws = repo_name.split("/", 1)[0] if "/" in repo_name else workspace
            url = f"https://api.bitbucket.org/2.0/repositories/{urllib.parse.quote(ws, safe='')}/{urllib.parse.quote(slug, safe='')}/pullrequests?state=OPEN&pagelen=50"
            st, _, p = http_json(url, headers=headers)
            if st == 200 and isinstance(p, dict):
                return [x for x in p.get("values", []) if isinstance(x, dict)]
            return []

        with ThreadPoolExecutor(max_workers=6) as pool:
            for batch in pool.map(_fetch_repo_prs, repos):
                raw_items.extend(batch)
    else:
        selected_user = ident.get("account_id") or ident.get("uuid") or ident.get("username") or bb_cfg.get("username") or ""
        if not selected_user:
            return [], "Could not determine Bitbucket user identity; set Username in Bitbucket config."
        url = f"https://api.bitbucket.org/2.0/workspaces/{urllib.parse.quote(workspace, safe='')}/pullrequests/{urllib.parse.quote(selected_user, safe='')}?state=OPEN&pagelen=50"
        st, _, p = http_json(url, headers=headers)
        if st != 200 or not isinstance(p, dict):
            msg = ((p.get("error") or {}).get("message")) if isinstance(p, dict) else str(p)
            return [], f"Bitbucket HTTP {st}: {msg}"
        raw_items = [x for x in p.get("values", []) if isinstance(x, dict) and (x.get("state") or "OPEN").upper() == "OPEN"]

    # Deduplicate raw PRs by repo#id
    dedup: dict[str, dict] = {}
    for item in raw_items:
        repo_full = ((item.get("destination") or {}).get("repository") or {}).get("full_name") or ""
        pid = item.get("id")
        if repo_full and pid:
            dedup[f"{repo_full.lower()}#{pid}"] = item

    def _enrich(item: dict) -> dict | None:
        repo_full = ((item.get("destination") or {}).get("repository") or {}).get("full_name") or ""
        if "/" not in repo_full:
            return None
        ws_part, slug_part = repo_full.split("/", 1)
        pr_id = int(item.get("id") or 0)
        base = f"https://api.bitbucket.org/2.0/repositories/{urllib.parse.quote(ws_part, safe='')}/{urllib.parse.quote(slug_part, safe='')}/pullrequests/{pr_id}"

        full_pr = item
        if "participants" not in item:
            st_d, _, p_d = http_json(base, headers=headers)
            if st_d == 200 and isinstance(p_d, dict):
                full_pr = p_d

        st_s, _, p_s = http_json(f"{base}/statuses?pagelen=50", headers=headers)
        statuses = p_s if (st_s == 200 and isinstance(p_s, dict)) else {}

        head_sha = ((((full_pr.get("source") or {}).get("commit") or {}).get("hash")) or "")[:12]
        ds_key = f"bitbucket:{repo_full.lower()}#{pr_id}@{head_sha}"
        diffstat = cache["diffstats"].get(ds_key)
        if diffstat is None:
            st_ds, _, p_ds = http_json(f"{base}/diffstat?pagelen=100", headers=headers)
            diffstat = _summarize_diffstat(p_ds) if st_ds == 200 else {"additions": 0, "deletions": 0, "changedFiles": 0}
            if head_sha and st_ds == 200:
                cache["diffstats"][ds_key] = diffstat

        pr = normalize_bitbucket_pr(full_pr, statuses, diffstat, ident, bb_cfg, profile_id, local_repos)
        if not pr["isMine"] and not pr["isReviewRequested"]:
            return None
        return pr

    out: list[dict] = []
    if dedup:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for pr in pool.map(_enrich, dedup.values()):
                if pr is not None:
                    out.append(pr)
    return out, None


def test_bitbucket(bb_cfg: dict, env: dict[str, str]) -> dict:
    headers, mode, err = bitbucket_headers(bb_cfg, env)
    if err:
        return {"ok": False, "error": err, "hint": "Configure BB_USER + BB_TOKEN or Basic/Bearer credentials."}

    status, _, payload = http_json("https://api.bitbucket.org/2.0/user", headers=headers)
    if status == 401:
        return {
            "ok": False,
            "error": "Bitbucket HTTP 401: Unauthorized",
            "hint": "For Atlassian API tokens (ATATT...), use your Atlassian email as User in Basic auth; for Workspace/Repo Access Tokens, use Bearer mode.",
        }

    identity = ""
    display_name = ""
    if status == 200 and isinstance(payload, dict):
        identity = payload.get("nickname") or payload.get("username") or payload.get("account_id") or ""
        display_name = payload.get("display_name") or identity
    elif status == 403 and mode == "bearer":
        identity = bb_cfg.get("username") or "(workspace token)"
        display_name = identity
    elif status != 200:
        msg = ((payload.get("error") or {}).get("message")) if isinstance(payload, dict) else str(payload)
        return {"ok": False, "error": f"Bitbucket HTTP {status}: {msg}", "hint": ""}

    workspace = (bb_cfg.get("workspace") or "").strip()
    if workspace:
        ws_url = f"https://api.bitbucket.org/2.0/workspaces/{urllib.parse.quote(workspace, safe='')}/repositories?pagelen=1"
        ws_st, _, ws_p = http_json(ws_url, headers=headers)
        if ws_st != 200:
            msg = ((ws_p.get("error") or {}).get("message")) if isinstance(ws_p, dict) else str(ws_p)
            return {
                "ok": False,
                "error": f"Workspace '{workspace}' HTTP {ws_st}: {msg}",
                "hint": "Check workspace slug and pullrequest:read permission.",
            }

    return {"ok": True, "identity": identity, "displayName": display_name}


def fetch_bitbucket_detail(bb_cfg: dict, env: dict[str, str], repo_full: str, number: int) -> dict:
    headers, _, err = bitbucket_headers(bb_cfg, env)
    if err:
        return {"ok": False, "error": err}
    if "/" not in repo_full:
        return {"ok": False, "error": f"Invalid repo slug: {repo_full}"}
    ws_part, slug_part = repo_full.split("/", 1)
    base = f"https://api.bitbucket.org/2.0/repositories/{urllib.parse.quote(ws_part, safe='')}/{urllib.parse.quote(slug_part, safe='')}/pullrequests/{number}"
    st_pr, _, p_pr = http_json(base, headers=headers)
    if st_pr != 200 or not isinstance(p_pr, dict):
        msg = ((p_pr.get("error") or {}).get("message")) if isinstance(p_pr, dict) else str(p_pr)
        return {"ok": False, "error": f"Bitbucket HTTP {st_pr}: {msg}"}

    desc = ((p_pr.get("summary") or {}).get("raw")) or p_pr.get("description") or ""
    st_c, _, p_c = http_json(f"{base}/comments?pagelen=20&sort=-created_on", headers=headers)
    comments = []
    if st_c == 200 and isinstance(p_c, dict):
        for c in p_c.get("values", []):
            if not isinstance(c, dict) or c.get("deleted"):
                continue
            u = c.get("user") or {}
            comments.append({
                "author": u.get("display_name") or u.get("nickname") or "user",
                "text": ((c.get("content") or {}).get("raw") or "").strip(),
                "createdAt": c.get("created_on") or "",
                "url": (((c.get("links") or {}).get("html") or {}).get("href")) or "",
                "path": ((c.get("inline") or {}).get("path")) or "",
            })
            if len(comments) >= 10:
                break
    return {"ok": True, "description": desc.strip(), "comments": comments}


def compute_notification_events(
    prev_snapshot: dict | None,
    curr_prs: list[dict],
    notif_cfg: dict,
) -> list[dict]:
    if prev_snapshot is None or not notif_cfg.get("enabled", True):
        return []

    events: list[dict] = []
    for pr in curr_prs:
        key = pr["key"]
        prev = prev_snapshot.get(key)
        short = f"{pr['repoShort']} #{pr['number']}"
        if pr.get("isMine") and prev is not None:
            if notif_cfg.get("ci", True):
                if pr["ciState"] == "failure" and prev.get("ciState") != "failure":
                    events.append({
                        "kind": "ci_failed",
                        "prKey": key,
                        "profileId": pr["profileId"],
                        "level": "error",
                        "title": f"CI failed: {short}",
                        "body": pr["title"],
                    })
                elif pr["ciState"] == "success" and prev.get("ciState") in ("failure", "pending"):
                    events.append({
                        "kind": "ci_passed",
                        "prKey": key,
                        "profileId": pr["profileId"],
                        "level": "success",
                        "title": f"CI passed: {short}",
                        "body": pr["title"],
                    })
            if notif_cfg.get("reviews", True):
                if pr["changesRequested"] > prev.get("changesRequested", 0) or (
                    pr["reviewState"] == "changes_requested" and prev.get("reviewState") != "changes_requested"
                ):
                    events.append({
                        "kind": "changes_requested",
                        "prKey": key,
                        "profileId": pr["profileId"],
                        "level": "warning",
                        "title": f"Changes requested: {short}",
                        "body": pr["title"],
                    })
                elif pr["approvals"] > prev.get("approvals", 0) or (
                    pr["reviewState"] == "approved" and prev.get("reviewState") != "approved"
                ):
                    events.append({
                        "kind": "approved",
                        "prKey": key,
                        "profileId": pr["profileId"],
                        "level": "success",
                        "title": f"PR approved: {short}",
                        "body": pr["title"],
                    })
            if notif_cfg.get("comments", True):
                if pr["commentCount"] > prev.get("commentCount", 0) or pr["unresolvedCount"] > prev.get("unresolvedCount", 0):
                    events.append({
                        "kind": "new_comments",
                        "prKey": key,
                        "profileId": pr["profileId"],
                        "level": "info",
                        "title": f"New comment: {short}",
                        "body": pr["title"],
                    })

        if pr.get("isReviewRequested") and not pr.get("isMine") and notif_cfg.get("reviewRequests", True):
            if prev is None or not prev.get("isReviewRequested"):
                events.append({
                    "kind": "review_requested",
                    "prKey": key,
                    "profileId": pr["profileId"],
                    "level": "info",
                    "title": f"Review requested: {short}",
                    "body": f"{pr['author']}: {pr['title']}",
                })
    return events


def _snapshot_entry(pr: dict) -> dict:
    return {
        "ciState": pr["ciState"],
        "reviewState": pr["reviewState"],
        "approvals": pr["approvals"],
        "changesRequested": pr["changesRequested"],
        "commentCount": pr["commentCount"],
        "unresolvedCount": pr["unresolvedCount"],
        "isMine": pr["isMine"],
        "isReviewRequested": pr["isReviewRequested"],
    }


def build_by_branch_index(prs: list[dict]) -> dict[str, dict]:
    by_branch: dict[str, dict] = {}
    for pr in prs:
        if not pr.get("repo") or not pr.get("sourceBranch"):
            continue
        bkey = f"{pr['provider']}:{pr['repo'].lower()}::{pr['sourceBranch']}"
        existing = by_branch.get(bkey)
        if existing and existing.get("isMine") and not pr.get("isMine"):
            continue
        by_branch[bkey] = {
            "key": pr["key"],
            "profileId": pr["profileId"],
            "provider": pr["provider"],
            "number": pr["number"],
            "title": pr["title"],
            "url": pr["url"],
            "ciState": pr["ciState"],
            "reviewState": pr["reviewState"],
            "approvals": pr["approvals"],
            "changesRequested": pr["changesRequested"],
            "draft": pr["draft"],
            "conflicts": pr["conflicts"],
            "unresolvedCount": pr["unresolvedCount"],
            "isMine": pr["isMine"],
            "isReviewRequested": pr["isReviewRequested"],
        }
    return by_branch


def sync_all(profile_filter: str | None = None) -> dict:
    cfg = load_forge_config()
    env = load_env()
    sf = read_space_folders()
    local_repos, _ = discover_local_repos(sf)
    cache = _load_cache()

    configured_profiles: list[str] = []
    tasks: list[tuple[str, str, dict]] = []

    for pid, pcfg in cfg["profiles"].items():
        if profile_filter and pid != profile_filter:
            continue
        gh = pcfg["github"]
        bb = pcfg["bitbucket"]
        if gh.get("enabled") or bb.get("enabled"):
            configured_profiles.append(pid)
        if gh.get("enabled"):
            tasks.append((pid, "github", gh))
        if bb.get("enabled"):
            tasks.append((pid, "bitbucket", bb))

    prs: list[dict] = []
    errors: dict[str, str] = {}

    def _run_task(task: tuple[str, str, dict]) -> tuple[str, str, list[dict], str | None]:
        pid, prov, pcfg = task
        try:
            if prov == "github":
                items, err = fetch_github_prs(pid, pcfg, env, local_repos)
            else:
                items, err = fetch_bitbucket_prs(pid, pcfg, env, local_repos, cache)
            return pid, prov, items, err
        except Exception as exc:  # noqa: BLE001
            return pid, prov, [], str(exc)

    if tasks:
        with ThreadPoolExecutor(max_workers=min(6, len(tasks))) as pool:
            for pid, prov, items, err in pool.map(_run_task, tasks):
                prs.extend(items)
                if err:
                    errors[f"{pid}:{prov}"] = err

    _save_cache(cache)

    prs.sort(key=lambda p: (p.get("updatedAt") or ""), reverse=True)
    by_branch = build_by_branch_index(prs)

    summary_by_profile: dict[str, dict] = {}
    for prof in sf.get("profiles", DEFAULT_PROFILES):
        pid = prof.get("id")
        if pid:
            summary_by_profile[pid] = {
                "mine": 0,
                "review": 0,
                "total": 0,
                "failingCi": 0,
                "changesRequested": 0,
                "configured": pid in configured_profiles,
            }
    for pid in configured_profiles:
        summary_by_profile.setdefault(pid, {
            "mine": 0,
            "review": 0,
            "total": 0,
            "failingCi": 0,
            "changesRequested": 0,
            "configured": True,
        })

    for pr in prs:
        pid = pr["profileId"]
        s = summary_by_profile.setdefault(pid, {
            "mine": 0,
            "review": 0,
            "total": 0,
            "failingCi": 0,
            "changesRequested": 0,
            "configured": True,
        })
        s["total"] += 1
        if pr["isMine"]:
            s["mine"] += 1
        if pr["isReviewRequested"] and not pr["isMine"]:
            s["review"] += 1
        if pr["ciState"] == "failure":
            s["failingCi"] += 1
        if pr["reviewState"] == "changes_requested":
            s["changesRequested"] += 1

    snap_path = cache_dir_path() / "snapshot.json"
    prev_raw = read_json_file(snap_path)
    prev_snap = prev_raw.get("prs") if isinstance(prev_raw, dict) and isinstance(prev_raw.get("prs"), dict) else None
    events = compute_notification_events(prev_snap, prs, cfg["notifications"]) if not profile_filter else []
    if not profile_filter:
        # Preserve entries from providers that errored this poll to avoid spurious transitions
        next_snap = dict(prev_snap or {})
        errored_keys = set(errors.keys())
        for k in list(next_snap.keys()):
            # key is "<provider>:<repo>#<num>"
            prov = k.split(":", 1)[0]
            # Find if matching profile/provider errored; if none errored, drop closed PRs
            if not any(ek.endswith(f":{prov}") for ek in errored_keys):
                next_snap.pop(k, None)
        for pr in prs:
            next_snap[pr["key"]] = _snapshot_entry(pr)
        write_json_atomic(snap_path, {"updatedAt": now_iso(), "prs": next_snap}, mode=0o600)

    return {
        "prs": prs,
        "byBranch": by_branch,
        "summaryByProfile": summary_by_profile,
        "configuredProfiles": configured_profiles,
        "errors": errors,
        "events": events,
        "pollIntervalSec": cfg["pollIntervalSec"],
        "updatedAt": now_iso(),
    }


def prepare_worktree(repo_path: str, branch: str) -> dict:
    repo = Path(repo_path).expanduser()
    if not repo.is_dir():
        return {"ok": False, "error": f"Local repo not found: {repo_path}"}
    try:
        wt_res = subprocess.run(
            ["git", "-C", str(repo), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        existing_path = None
        if wt_res.returncode == 0:
            for block in wt_res.stdout.split("\n\n"):
                lines = block.splitlines()
                wpath = next((l[9:] for l in lines if l.startswith("worktree ")), None)
                wbr = next((l[7:].removeprefix("refs/heads/") for l in lines if l.startswith("branch ")), None)
                if wpath and wbr == branch:
                    existing_path = wpath
                    break

        if existing_path:
            return {
                "ok": True,
                "existingWorktreePath": existing_path,
                "repoPath": str(repo),
                "branch": branch,
                "fetched": False,
            }

        has_local = subprocess.run(
            ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
            capture_output=True,
            timeout=5,
            check=False,
        ).returncode == 0

        fetched = False
        if not has_local:
            fetch_res = subprocess.run(
                ["git", "-C", str(repo), "fetch", "origin", branch],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            fetched = fetch_res.returncode == 0
            if fetched:
                subprocess.run(
                    ["git", "-C", str(repo), "branch", "--track", branch, "FETCH_HEAD"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )

        return {
            "ok": True,
            "existingWorktreePath": None,
            "repoPath": str(repo),
            "branch": branch,
            "fetched": fetched,
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": str(exc)}


def _read_payload_file(path_str: str) -> dict:
    p = Path(path_str)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    finally:
        try:
            p.unlink()
        except OSError:
            pass


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Herdr GitHub/Bitbucket PR helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("get-config")
    sub.add_parser("gh-accounts")
    p_gh_start = sub.add_parser("gh-login-start")
    p_gh_start.add_argument("--host", default="github.com")
    sub.add_parser("gh-login-status")
    sub.add_parser("gh-login-cancel")
    p_gh_worker = sub.add_parser("_gh-login-worker")
    p_gh_worker.add_argument("--session", required=True)
    p_gh_worker.add_argument("--host", required=True)

    p_save = sub.add_parser("save-config")
    p_save.add_argument("--from-file", required=True)

    p_del = sub.add_parser("delete-profile")
    p_del.add_argument("--id", required=True)

    sub.add_parser("detect")

    p_test = sub.add_parser("test")
    p_test.add_argument("--from-file", required=True)

    p_sync = sub.add_parser("sync")
    p_sync.add_argument("--profile", default=None)
    p_sync.add_argument("--force", action="store_true")

    p_det = sub.add_parser("detail")
    p_det.add_argument("--profile", required=True)
    p_det.add_argument("--provider", required=True, choices=["github", "bitbucket"])
    p_det.add_argument("--repo", required=True)
    p_det.add_argument("--number", required=True, type=int)

    p_wt = sub.add_parser("prepare-worktree")
    p_wt.add_argument("--repo-path", required=True)
    p_wt.add_argument("--branch", required=True)

    return parser


def _cmd_save_config(args: argparse.Namespace) -> dict:
    update = _read_payload_file(args.from_file)
    saved = save_forge_config(merge_config_update(load_forge_config(), update))
    return {"ok": True, "config": sanitize_config(saved, load_env())}


def _cmd_delete_profile(args: argparse.Namespace) -> dict:
    cfg = load_forge_config()
    removed = cfg["profiles"].pop(args.id, None) is not None
    save_forge_config(cfg)
    return {"ok": True, "removed": removed}


def _cmd_test(args: argparse.Namespace) -> dict:
    payload = _read_payload_file(args.from_file)
    provider = payload.get("provider")
    existing = load_forge_config()["profiles"].get(payload.get("profileId")) or default_profile_cfg()
    env = load_env()
    config = payload.get("config") or {}
    if provider == "github":
        return test_github(normalize_profile_cfg({"github": config})["github"], env)
    if provider == "bitbucket":
        cand = normalize_profile_cfg({"bitbucket": config})["bitbucket"]
        cand["token"] = _apply_token_action(existing["bitbucket"]["token"], config)
        return test_bitbucket(cand, env)
    return {"ok": False, "error": f"Unknown provider: {provider}"}


def _cmd_detail(args: argparse.Namespace) -> dict:
    cfg = load_forge_config()["profiles"].get(args.profile)
    if not cfg:
        return {"ok": False, "error": f"Profile '{args.profile}' not configured"}
    fetch = fetch_github_detail if args.provider == "github" else fetch_bitbucket_detail
    return fetch(cfg[args.provider], load_env(), args.repo, args.number)


COMMANDS = {
    "get-config": lambda _a: sanitize_config(load_forge_config(), load_env()),
    "gh-accounts": lambda _a: list_gh_accounts(),
    "gh-login-start": lambda a: start_gh_login(a.host),
    "gh-login-status": lambda _a: get_gh_login_status(),
    "gh-login-cancel": lambda _a: cancel_gh_login(),
    "save-config": _cmd_save_config,
    "delete-profile": _cmd_delete_profile,
    "detect": lambda _a: detect_profiles_config(),
    "test": _cmd_test,
    "sync": lambda a: sync_all(profile_filter=a.profile),
    "detail": _cmd_detail,
    "prepare-worktree": lambda a: prepare_worktree(a.repo_path, a.branch),
}


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.cmd == "_gh-login-worker":
        return run_gh_login_worker(args.session, args.host)
    handler = COMMANDS.get(args.cmd)
    out = handler(args) if handler else {"ok": False, "error": f"Unknown command: {args.cmd}"}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
