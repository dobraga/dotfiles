# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "pydantic", "pydantic-settings"]
# ///
"""Compact Bitbucket Cloud client for agents. Reads are free; writes preview unless --yes.

Usage:
    uv run bb.py prs [WS/SLUG] [--mine] [--limit N]
    uv run bb.py pr WS/SLUG#ID [--comments N]
    uv run bb.py ci WS/SLUG#ID
    uv run bb.py comments WS/SLUG#ID [--limit N]
    uv run bb.py pr-create WS/SLUG --title T --source BRANCH [--dest develop] --body-file f.md [--yes]
    uv run bb.py pr-edit WS/SLUG#ID [--title T] [--body-file f.md] [--yes]
    uv run bb.py comment WS/SLUG#ID --body TEXT [--path FILE --line N] [--yes]
    uv run bb.py reply WS/SLUG#ID COMMENT_ID --body TEXT [--yes]
"""

import asyncio
import base64
import json
import logging
import sys
from pathlib import Path
from typing import Annotated, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic_settings import (
    BaseSettings,
    CliApp,
    CliImplicitFlag,
    CliPositionalArg,
    CliSubCommand,
    SettingsConfigDict,
)

API = "https://api.bitbucket.org/2.0"
CI_LABEL = {"SUCCESSFUL": "ok", "INPROGRESS": "run"}
PrRef = Annotated[str, StringConstraints(pattern=r"^[^/#\s]+/[^/#\s]+#\d+$")]

logger = logging.getLogger("bb")


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    CliApp.run(Bb)


class Settings(BaseSettings):
    """Credentials, read from the environment or the dotfiles repo's .env."""

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[2] / ".env", extra="ignore"
    )

    bb_email: str = ""
    bb_token: str = ""
    bb_workspace: str = ""


class Loose(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Account(Loose):
    display_name: str = ""
    nickname: str = ""
    account_id: str = ""

    @property
    def name(self) -> str:
        return self.display_name or self.nickname or "?"


class Branch(Loose):
    name: str = ""


class Ref(Loose):
    branch: Branch = Field(default_factory=Branch)


class Participant(Loose):
    user: Account = Field(default_factory=Account)
    role: str = ""
    approved: bool = False


class Summary(Loose):
    raw: str = ""


class PullRequest(Loose):
    id: int
    title: str = ""
    state: str = ""
    author: Account = Field(default_factory=Account)
    source: Ref = Field(default_factory=Ref)
    destination: Ref = Field(default_factory=Ref)
    participants: list[Participant] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    comment_count: int = 0


class Status(Loose):
    state: str = ""
    name: str = ""
    key: str = ""
    url: str = ""


class DiffStat(Loose):
    lines_added: int = 0
    lines_removed: int = 0


class Content(Loose):
    raw: str = ""


class Inline(Loose):
    path: str = ""
    to: int | None = None


class Parent(Loose):
    id: int


class Comment(Loose):
    id: int = 0
    parent: Parent | None = None
    user: Account = Field(default_factory=Account)
    content: Content = Field(default_factory=Content)
    inline: Inline | None = None
    deleted: bool = False


class Client:
    """Async authenticated client with paging."""

    def __init__(self, settings: Settings) -> None:
        self._http = httpx.AsyncClient(
            headers=self._headers(settings), timeout=20, follow_redirects=True
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._http.aclose()

    async def get(self, url: str, **params: str | int) -> dict:
        resp = await self._http.get(url, params=params)
        hints = {
            401: "bad credentials",
            403: "token lacks scope",
            404: "not found or no access",
        }
        return self._check(resp, (200,), hints)

    async def send(self, method: str, url: str, body: dict) -> dict:
        resp = await self._http.request(method, url, json=body)
        hints = {401: "bad credentials", 403: "token may lack write scope"}
        return self._check(resp, (200, 201), hints)

    async def values(self, url: str, limit: int, **params: str | int) -> list[dict]:
        page = await self.get(url, pagelen=min(limit, 50), **params)
        out = list(page.get("values", []))
        while len(out) < limit and page.get("next"):
            page = self._check(await self._http.get(page["next"]), (200,), {})
            out.extend(page.get("values", []))
        return out[:limit]

    @staticmethod
    def _check(
        resp: httpx.Response, ok: tuple[int, ...], hints: dict[int, str]
    ) -> dict:
        if resp.status_code in ok:
            return resp.json()
        msg = resp.json().get("error", {}).get("message", "") if resp.content else ""
        raise SystemExit(
            f"Bitbucket HTTP {resp.status_code} ({hints.get(resp.status_code, '')}): {msg}"
        )

    @staticmethod
    def _headers(settings: Settings) -> dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": "bb-cli"}
        if not settings.bb_token:
            raise SystemExit("BB_TOKEN is not set (env or dotfiles .env).")
        if settings.bb_email:
            creds = f"{settings.bb_email}:{settings.bb_token}"
            headers["Authorization"] = (
                "Basic " + base64.b64encode(creds.encode()).decode()
            )
        else:
            headers["Authorization"] = f"Bearer {settings.bb_token}"
        return headers


class Command(BaseModel):
    """A subcommand: opens a client, runs, prints the lines."""

    async def cli_cmd(self) -> None:
        async with Client(Settings()) as client:
            sys.stdout.write("\n".join(await self.run(client)) + "\n")

    async def run(self, client: Client) -> list[str]:
        raise NotImplementedError


class Prs(Command):
    """Open PRs with CI roll-up."""

    repo: CliPositionalArg[str] = ""
    mine: CliImplicitFlag[bool] = False
    limit: int = 20

    @model_validator(mode="after")
    def _needs_target(self) -> Self:
        if not (self.repo or self.mine):
            raise ValueError("prs needs WS/SLUG or --mine")
        return self

    async def run(self, client: Client) -> list[str]:
        if self.repo:
            url = f"{API}/repositories/{self.repo}/pullrequests"
            raw = await client.values(url, self.limit, state="OPEN")
            repos = [self.repo] * len(raw)
        else:
            raw, repos = await self._mine(client)
        prs = [PullRequest.model_validate(item) for item in raw]
        rollups = await asyncio.gather(
            *(_ci_rollup(client, r, p.id) for r, p in zip(repos, prs, strict=True))
        )
        return [
            f"{r}#{p.id} [{ci}] {p.title} ({p.author.name}) {p.source.branch.name}->{p.destination.branch.name}"
            for r, p, ci in zip(repos, prs, rollups, strict=True)
        ] or ["no open PRs"]

    async def _mine(self, client: Client) -> tuple[list[dict], list[str]]:
        workspace = Settings().bb_workspace
        if not workspace:
            raise SystemExit("Set BB_WORKSPACE for --mine.")
        me = (await client.get(f"{API}/user"))["account_id"]
        url = f"{API}/workspaces/{workspace}/pullrequests/{me}"
        raw = await client.values(url, self.limit, state="OPEN")
        repos = [
            i.get("destination", {}).get("repository", {}).get("full_name", workspace)
            for i in raw
        ]
        return raw, repos


class Pr(Command):
    """PR summary: reviewers, diffstat, CI, comments."""

    ref: CliPositionalArg[PrRef]
    comments: int = 5

    async def run(self, client: Client) -> list[str]:
        repo, pr_id = _split(self.ref)
        base = f"{API}/repositories/{repo}/pullrequests/{pr_id}"
        raw, stat, ci, comments = await asyncio.gather(
            client.get(base),
            _diffstat(client, base),
            _ci_lines(client, repo, pr_id),
            _comment_lines(client, base, self.comments) if self.comments else _none(),
        )
        pr = PullRequest.model_validate(raw)
        reviewers = [
            f"{p.user.name}{' (approved)' if p.approved else ''}"
            for p in pr.participants
            if p.role == "REVIEWER"
        ]
        lines = [
            f"{repo}#{pr.id} {pr.state} {pr.title}",
            f"author {pr.author.name} | {pr.source.branch.name}->{pr.destination.branch.name} | +{stat[0]} -{stat[1]} | {pr.comment_count} comments",
            f"reviewers: {', '.join(reviewers) or 'none'}",
        ]
        if desc := pr.summary.raw.strip():
            lines.append("description: " + _clip(desc, 600))
        return [*lines, *ci, *comments]


class Ci(Command):
    """CI checks with URLs."""

    ref: CliPositionalArg[PrRef]

    async def run(self, client: Client) -> list[str]:
        repo, pr_id = _split(self.ref)
        return await _ci_lines(client, repo, pr_id)


class Comments(Command):
    """Latest comments with ids, parents and file:line."""

    ref: CliPositionalArg[PrRef]
    limit: int = 10

    async def run(self, client: Client) -> list[str]:
        repo, pr_id = _split(self.ref)
        base = f"{API}/repositories/{repo}/pullrequests/{pr_id}"
        return await _comment_lines(client, base, self.limit) or ["no comments"]


class Write(Command):
    """A write: previews unless --yes."""

    body: str | None = None
    body_file: Path | None = None
    yes: CliImplicitFlag[bool] = False

    async def run(self, client: Client) -> list[str]:
        method, url, payload, what = self.request()
        if not self.yes:
            return [
                f"PREVIEW ({what}, not sent; add --yes to send)",
                f"{method} {url}",
                json.dumps(payload, indent=2),
            ]
        result = await client.send(method, url, payload)
        return [
            f"sent: {what} {result.get('links', {}).get('html', {}).get('href', '')}"
        ]

    def request(self) -> tuple[str, str, dict, str]:
        raise NotImplementedError

    def text(self) -> str:
        if self.body_file:
            return self.body_file.read_text()
        if self.body is None:
            raise SystemExit("give --body or --body-file")
        return self.body


class PrCreate(Write):
    """Open a PR."""

    repo: CliPositionalArg[str]
    title: str
    source: str
    dest: str = "develop"

    def request(self) -> tuple[str, str, dict, str]:
        payload = {
            "title": self.title,
            "source": {"branch": {"name": self.source}},
            "destination": {"branch": {"name": self.dest}},
            "description": self.text(),
        }
        url = f"{API}/repositories/{self.repo}/pullrequests"
        return "POST", url, payload, "create PR"


class PrEdit(Write):
    """Change a PR's title and/or description."""

    ref: CliPositionalArg[PrRef]
    title: str | None = None

    def request(self) -> tuple[str, str, dict, str]:
        payload: dict = {}
        if self.title:
            payload["title"] = self.title
        if self.body is not None or self.body_file:
            payload["description"] = self.text()
        if not payload:
            raise SystemExit("pr-edit needs --title and/or --body/--body-file")
        repo, pr_id = _split(self.ref)
        return (
            "PUT",
            f"{API}/repositories/{repo}/pullrequests/{pr_id}",
            payload,
            "edit PR",
        )


class CommentAdd(Write):
    """Add a comment (inline with --path and --line)."""

    ref: CliPositionalArg[PrRef]
    path: str | None = None
    line: int | None = None

    def request(self) -> tuple[str, str, dict, str]:
        payload: dict = {"content": {"raw": self.text()}}
        if self.path:
            payload["inline"] = {"path": self.path, "to": self.line}
        repo, pr_id = _split(self.ref)
        url = f"{API}/repositories/{repo}/pullrequests/{pr_id}/comments"
        return "POST", url, payload, "add comment"


class Reply(Write):
    """Reply to a comment by id."""

    ref: CliPositionalArg[PrRef]
    comment_id: CliPositionalArg[int]

    def request(self) -> tuple[str, str, dict, str]:
        payload = {"content": {"raw": self.text()}, "parent": {"id": self.comment_id}}
        repo, pr_id = _split(self.ref)
        url = f"{API}/repositories/{repo}/pullrequests/{pr_id}/comments"
        return "POST", url, payload, "reply"


class Bb(BaseSettings, cli_kebab_case=True, cli_prog_name="bb"):
    """Bitbucket Cloud: read PRs, CI and comments; write with --yes."""

    prs: CliSubCommand[Prs]
    pr: CliSubCommand[Pr]
    ci: CliSubCommand[Ci]
    comments: CliSubCommand[Comments]
    pr_create: CliSubCommand[PrCreate]
    pr_edit: CliSubCommand[PrEdit]
    comment: CliSubCommand[CommentAdd]
    reply: CliSubCommand[Reply]

    def cli_cmd(self) -> None:
        CliApp.run_subcommand(self)


def _split(ref: str) -> tuple[str, int]:
    repo, pr_id = ref.rsplit("#", 1)
    return repo, int(pr_id)


async def _none() -> list[str]:
    return []


async def _statuses(client: Client, repo: str, pr_id: int) -> list[Status]:
    url = f"{API}/repositories/{repo}/pullrequests/{pr_id}/statuses"
    return [Status.model_validate(s) for s in await client.values(url, 50)]


async def _ci_rollup(client: Client, repo: str, pr_id: int) -> str:
    return _rollup(await _statuses(client, repo, pr_id))


async def _ci_lines(client: Client, repo: str, pr_id: int) -> list[str]:
    statuses = await _statuses(client, repo, pr_id)
    if not statuses:
        return ["ci: none"]
    return [
        f"ci: {_rollup(statuses)}",
        *(
            f"  {CI_LABEL.get(s.state.upper(), 'FAIL')} {s.name or s.key or 'pipeline'} {s.url}"
            for s in statuses
        ),
    ]


def _rollup(statuses: list[Status]) -> str:
    states = {s.state.upper() for s in statuses}
    if not states:
        return "none"
    if states - {"SUCCESSFUL", "INPROGRESS"}:
        return "FAIL"
    return "run" if "INPROGRESS" in states else "ok"


async def _diffstat(client: Client, base: str) -> tuple[int, int]:
    stats = [DiffStat.model_validate(s) for s in await client.values(f"{base}/diffstat", 100)]
    return sum(s.lines_added for s in stats), sum(s.lines_removed for s in stats)


async def _comment_lines(client: Client, base: str, limit: int) -> list[str]:
    raw = await client.values(f"{base}/comments", limit, sort="-created_on")
    comments = [c for c in (Comment.model_validate(i) for i in raw) if not c.deleted]
    return [
        f"- #{c.id}{' re #' + str(c.parent.id) if c.parent else ''} {c.user.name}{_where(c)}: {_clip(c.content.raw.strip(), 600)}"
        for c in comments
    ]


def _where(c: Comment) -> str:
    if not (c.inline and c.inline.path):
        return ""
    return f" @{c.inline.path}{':' + str(c.inline.to) if c.inline.to else ''}"


def _clip(text: str, size: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= size else flat[: size - 1] + "…"


if __name__ == "__main__":
    main()
