import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

HELPER_PATH = Path(__file__).resolve().parents[1] / "herdr-app" / "mods" / "prs-panel" / "forge-helper.py"
SPEC = importlib.util.spec_from_file_location("forge_helper", HELPER_PATH)
forge = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(forge)


class ForgeHelperTests(unittest.TestCase):
    def test_parse_remote_url(self):
        gh_ssh = forge.parse_remote_url("git@github.com:Dobraga/Health-Cockpit.git")
        self.assertEqual(
            gh_ssh,
            {
                "provider": "github",
                "owner": "Dobraga",
                "repo": "Health-Cockpit",
                "full": "Dobraga/Health-Cockpit",
                "slug": "github:dobraga/health-cockpit",
            },
        )
        gh_https = forge.parse_remote_url("https://github.com/dobraga/dotfiles/")
        self.assertEqual(gh_https["slug"], "github:dobraga/dotfiles")

        bb_ssh = forge.parse_remote_url("git@bitbucket.org:tricura/ml-tagging.git")
        self.assertEqual(bb_ssh["slug"], "bitbucket:tricura/ml-tagging")

        bb_ssh_scheme = forge.parse_remote_url("ssh://git@bitbucket.org/tricura/orion-backend.git")
        self.assertEqual(bb_ssh_scheme["slug"], "bitbucket:tricura/orion-backend")

        bb_https = forge.parse_remote_url("https://user@bitbucket.org/tricura/ml-research.git")
        self.assertEqual(bb_https["slug"], "bitbucket:tricura/ml-research")

        self.assertIsNone(forge.parse_remote_url("https://gitlab.com/foo/bar.git"))
        self.assertIsNone(forge.parse_remote_url(""))

    def test_parse_env_file_and_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / ".env"
            env_path.write_text(
                (
                    "# comment\n"
                    "TEST_FORGE_USER=douglas@tricura.com\n"
                    "BB_TOKEN=ATAT_secret=123\n"
                    "GITHUB_TOKEN='ghp_from_file'\n"
                    "INVALID-NAME=ignored\n"
                    "INLINE=val # trailing comment"
                ),
                encoding="utf-8",
            )
            parsed = forge.parse_env_file(env_path)
            self.assertEqual(parsed["TEST_FORGE_USER"], "douglas@tricura.com")
            self.assertEqual(parsed["BB_TOKEN"], "ATAT_secret=123")
            self.assertEqual(parsed["GITHUB_TOKEN"], "ghp_from_file")
            self.assertEqual(parsed["INLINE"], "val")
            self.assertNotIn("INVALID-NAME", parsed)

            with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_from_env"}, clear=True):
                loaded = forge.load_env(env_path)
                self.assertEqual(loaded["GITHUB_TOKEN"], "ghp_from_env")
                self.assertEqual(loaded["TEST_FORGE_USER"], "douglas@tricura.com")

    def test_config_roundtrip_permissions_and_masking(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cfg_path = tmp_path / "herdr-forge.json"
            env_path = tmp_path / ".env"
            env_path.write_text("BB_USER=u\nBB_TOKEN=t\n", encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {
                    "HERDR_FORGE_CONFIG": str(cfg_path),
                    "HERDR_ENV_FILE": str(env_path),
                },
                clear=False,
            ):
                payload_file = tmp_path / "save1.json"
                payload_file.write_text(
                    json.dumps({
                        "pollIntervalSec": 120,
                        "profiles": {
                            "personal": {
                                "github": {
                                    "enabled": True,
                                    "host": "github.com",
                                    "account": "dobraga",
                                },
                                "bitbucket": {
                                    "enabled": True,
                                    "workspace": "tricura",
                                    "authMode": "basic",
                                    "user": "doug@tricura.com",
                                    "tokenAction": "set",
                                    "token": "ATAT_supersecret123456",
                                },
                            }
                        },
                    }),
                    encoding="utf-8",
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    rc = forge.main(["save-config", "--from-file", str(payload_file)])
                self.assertEqual(rc, 0)
                self.assertFalse(payload_file.exists())
                self.assertTrue(cfg_path.exists())
                mode = stat.S_IMODE(cfg_path.stat().st_mode)
                self.assertEqual(mode, 0o600)

                # Keep secret when updating unrelated fields with blank token + tokenAction=keep
                payload_keep = tmp_path / "save2.json"
                payload_keep.write_text(
                    json.dumps({
                        "profiles": {
                            "personal": {
                                "github": {
                                    "enabled": True,
                                    "host": "github.com",
                                    "account": "dobraga",
                                },
                                "bitbucket": {
                                    "enabled": True,
                                    "workspace": "tricura",
                                    "authMode": "basic",
                                    "user": "doug@tricura.com",
                                    "tokenAction": "keep",
                                    "token": "",
                                },
                            }
                        }
                    }),
                    encoding="utf-8",
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    forge.main(["save-config", "--from-file", str(payload_keep)])
                raw_saved = json.loads(cfg_path.read_text(encoding="utf-8"))
                self.assertEqual(raw_saved["profiles"]["personal"]["bitbucket"]["token"], "ATAT_supersecret123456")
                self.assertNotIn("token", raw_saved["profiles"]["personal"]["github"])

                sanitized = forge.sanitize_config(raw_saved, forge.load_env(), include_gh_accounts=False)
                bb_san = sanitized["profiles"]["personal"]["bitbucket"]
                self.assertTrue(bb_san["hasToken"])
                self.assertEqual(bb_san["token"], "")
                self.assertEqual(bb_san["tokenPreview"], "ATAT••••3456")
                self.assertNotIn("ATAT_supersecret123456", json.dumps(sanitized))

                # Clear secret
                payload_clear = tmp_path / "save3.json"
                payload_clear.write_text(
                    json.dumps({
                        "profiles": {
                            "personal": {
                                "bitbucket": {"enabled": True, "authMode": "basic", "tokenAction": "clear"}
                            }
                        }
                    }),
                    encoding="utf-8",
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    forge.main(["save-config", "--from-file", str(payload_clear)])
                raw_cleared = json.loads(cfg_path.read_text(encoding="utf-8"))
                self.assertEqual(raw_cleared["profiles"]["personal"]["bitbucket"]["token"], "")

                # Delete profile
                with contextlib.redirect_stdout(io.StringIO()):
                    forge.main(["delete-profile", "--id", "personal"])
                raw_after_del = json.loads(cfg_path.read_text(encoding="utf-8"))
                self.assertNotIn("personal", raw_after_del["profiles"])

    def test_gh_cli_accounts_and_token_resolution(self):
        status_output = (
            "github.com\n"
            "  ✓ Logged in to github.com account dobraga-personal (keyring)\n"
            "  - Active account: true\n"
            "  - Git operations protocol: https\n"
            "\n"
            "  ✓ Logged in to github.com account dobraga-work (keyring)\n"
            "  - Active account: false"
        )
        with tempfile.TemporaryDirectory() as tmp:
            hosts_file = Path(tmp) / "hosts.yml"
            hosts_file.write_text(
                (
                    "github.com:\n"
                    "    users:\n"
                    "        dobraga-personal:\n"
                    "            oauth_token: gho_1\n"
                    "        dobraga-work:\n"
                    "            oauth_token: gho_2\n"
                    "    user: dobraga-personal\n"
                    "ghe.internal.corp:\n"
                    "    user: corp-user\n"
                    "    oauth_token: gho_3"
                ),
                encoding="utf-8",
            )
            fake_status = subprocess.CompletedProcess(["gh", "auth", "status"], 0, stdout=status_output, stderr="")
            with mock.patch.object(forge.shutil, "which", return_value="/usr/bin/gh"), \
                 mock.patch.object(forge.subprocess, "run", return_value=fake_status):
                info = forge.list_gh_accounts(hosts_file)
                self.assertTrue(info["installed"])
                pairs = {(a["host"], a["user"]): a["active"] for a in info["accounts"]}
                self.assertEqual(pairs[("github.com", "dobraga-personal")], True)
                self.assertEqual(pairs[("github.com", "dobraga-work")], False)
                self.assertEqual(pairs[("ghe.internal.corp", "corp-user")], True)

        calls = []

        def fake_token_run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="gho_multi_tok\n", stderr="")

        with mock.patch.object(forge.shutil, "which", return_value="/usr/bin/gh"), \
             mock.patch.object(forge.subprocess, "run", side_effect=fake_token_run):
            tok1, err1 = forge.resolve_gh_cli_token({"host": "github.com", "account": "dobraga-work"})
            tok2, err2 = forge.resolve_gh_cli_token({"host": "ghe.internal.corp", "account": ""})
        self.assertIsNone(err1)
        self.assertEqual(tok1, "gho_multi_tok")
        self.assertIsNone(err2)
        self.assertEqual(tok2, "gho_multi_tok")
        self.assertEqual(calls[0], ["gh", "auth", "token", "--hostname", "github.com", "--user", "dobraga-work"])
        self.assertEqual(calls[1], ["gh", "auth", "token", "--hostname", "ghe.internal.corp"])

    def test_github_graphql_normalization(self):
        sample = {
            "data": {
                "mine": {
                    "nodes": [
                        {
                            "number": 42,
                            "title": "Add PR panel",
                            "url": "https://github.com/dobraga/dotfiles/pull/42",
                            "isDraft": True,
                            "createdAt": "2026-11-20T10:00:00Z",
                            "updatedAt": "2026-11-22T12:00:00Z",
                            "headRefName": "feat/prs",
                            "baseRefName": "master",
                            "headRefOid": "abcdef1234567890",
                            "additions": 100,
                            "deletions": 20,
                            "changedFiles": 5,
                            "mergeable": "CONFLICTING",
                            "reviewDecision": "CHANGES_REQUESTED",
                            "author": {"login": "dobraga"},
                            "repository": {"nameWithOwner": "dobraga/dotfiles", "url": "https://github.com/dobraga/dotfiles"},
                            "comments": {"totalCount": 3},
                            "reviewThreads": {"nodes": [{"isResolved": False}, {"isResolved": True}]},
                            "reviewRequests": {"nodes": [{"requestedReviewer": {"__typename": "User", "login": "alice"}}]},
                            "latestOpinionatedReviews": {"nodes": [{"state": "CHANGES_REQUESTED", "author": {"login": "bob"}}]},
                            "commits": {
                                "nodes": [
                                    {
                                        "commit": {
                                            "statusCheckRollup": {
                                                "state": "FAILURE",
                                                "contexts": {
                                                    "nodes": [
                                                        {
                                                            "__typename": "CheckRun",
                                                            "name": "pytest",
                                                            "status": "COMPLETED",
                                                            "conclusion": "FAILURE",
                                                            "detailsUrl": "https://github.com/checks/1",
                                                        },
                                                        {
                                                            "__typename": "StatusContext",
                                                            "context": "lint",
                                                            "state": "SUCCESS",
                                                            "targetUrl": "https://github.com/checks/2",
                                                        },
                                                    ]
                                                },
                                            }
                                        }
                                    }
                                ]
                            },
                        }
                    ]
                },
                "reviewing": {
                    "nodes": [
                        {
                            "number": 7,
                            "title": "Fix widget",
                            "url": "https://github.com/dobraga/health-cockpit/pull/7",
                            "isDraft": False,
                            "createdAt": "2026-11-21T10:00:00Z",
                            "updatedAt": "2026-11-22T14:00:00Z",
                            "headRefName": "fix/widget",
                            "baseRefName": "main",
                            "headRefOid": "112233445566",
                            "additions": 12,
                            "deletions": 4,
                            "changedFiles": 2,
                            "mergeable": "MERGEABLE",
                            "reviewDecision": "APPROVED",
                            "author": {"login": "teammate"},
                            "repository": {"nameWithOwner": "dobraga/health-cockpit", "url": "https://github.com/dobraga/health-cockpit"},
                            "comments": {"totalCount": 1},
                            "reviewThreads": {"nodes": []},
                            "reviewRequests": {"nodes": []},
                            "latestOpinionatedReviews": {"nodes": [{"state": "APPROVED", "author": {"login": "dobraga"}}]},
                            "commits": {"nodes": []},
                        }
                    ]
                },
            }
        }
        gh_cfg = {"enabled": True, "host": "github.com", "account": "dobraga"}
        local_repos = {"github:dobraga/dotfiles": "/home/dobraga/src/dotfiles"}
        with mock.patch.object(forge, "resolve_gh_cli_token", return_value=("gho_cli_tok", None)), \
             mock.patch.object(forge, "http_json", return_value=(200, {}, sample)):
            prs, err = forge.fetch_github_prs("personal", gh_cfg, {}, local_repos)
        self.assertIsNone(err)
        self.assertEqual(len(prs), 2)
        by_key = {p["key"]: p for p in prs}
        mine = by_key["github:dobraga/dotfiles#42"]
        self.assertTrue(mine["isMine"])
        self.assertFalse(mine["isReviewRequested"])
        self.assertTrue(mine["draft"])
        self.assertTrue(mine["conflicts"])
        self.assertEqual(mine["ciState"], "failure")
        self.assertEqual(mine["reviewState"], "changes_requested")
        self.assertEqual(mine["unresolvedCount"], 1)
        self.assertEqual(mine["localPath"], "/home/dobraga/src/dotfiles")
        self.assertEqual(len(mine["checks"]), 2)

        rev = by_key["github:dobraga/health-cockpit#7"]
        self.assertFalse(rev["isMine"])
        self.assertTrue(rev["isReviewRequested"])
        self.assertEqual(rev["reviewState"], "approved")
        self.assertEqual(rev["approvals"], 1)

    def test_bitbucket_rest_normalization_and_auth(self):
        bb_env_cfg = {"authMode": "env", "userEnvVar": "BB_USER", "tokenEnvVar": "BB_TOKEN"}
        hdrs, mode, err = forge.bitbucket_headers(bb_env_cfg, {"BB_USER": "doug@work.com", "BB_TOKEN": "ATAT123"})
        self.assertIsNone(err)
        self.assertEqual(mode, "env")
        expected_b64 = base64.b64encode(b"doug@work.com:ATAT123").decode("ascii")
        self.assertEqual(hdrs["Authorization"], f"Basic {expected_b64}")

        # Literal Atlassian email inside userEnvVar paired with BB_TOKEN env var
        bb_literal_email_cfg = {"authMode": "env", "userEnvVar": "douglas@tricura.com", "tokenEnvVar": "BB_TOKEN"}
        norm_lit = forge.normalize_profile_cfg({"bitbucket": bb_literal_email_cfg})["bitbucket"]
        self.assertEqual(norm_lit["userEnvVar"], "douglas@tricura.com")
        hdrs_lit, _, err_lit = forge.bitbucket_headers(norm_lit, {"BB_USER": "shortuser", "BB_TOKEN": "ATAT_XYZ"})
        self.assertIsNone(err_lit)
        expected_lit_b64 = base64.b64encode(b"douglas@tricura.com:ATAT_XYZ").decode("ascii")
        self.assertEqual(hdrs_lit["Authorization"], f"Basic {expected_lit_b64}")

        # userNeedsEmailHint diagnostic flag when ATAT* token paired with non-email BB_USER
        san_hint = forge.sanitize_config(
            {"profiles": {"work": {"bitbucket": {"enabled": True, "authMode": "env", "userEnvVar": "BB_USER", "tokenEnvVar": "BB_TOKEN"}}}},
            {"BB_USER": "dbraga", "BB_TOKEN": "ATAT_secret"},
            include_gh_accounts=False,
        )
        self.assertTrue(san_hint["profiles"]["work"]["bitbucket"]["userNeedsEmailHint"])
        self.assertFalse(san_hint["profiles"]["work"]["bitbucket"]["userIsEmail"])

        bb_bearer_cfg = {"authMode": "bearer", "token": "ws_tok"}
        hdrs_b, mode_b, err_b = forge.bitbucket_headers(bb_bearer_cfg, {})
        self.assertIsNone(err_b)
        self.assertEqual(mode_b, "bearer")
        self.assertEqual(hdrs_b["Authorization"], "Bearer ws_tok")

        ident = {"uuid": "{u-1}", "account_id": "acc-1", "nickname": "doug", "username": "doug"}
        raw_pr = {
            "id": 99,
            "title": "ML pipeline speedup",
            "state": "OPEN",
            "draft": False,
            "created_on": "2026-11-21T08:00:00Z",
            "updated_on": "2026-11-22T15:00:00Z",
            "comment_count": 4,
            "task_count": 2,
            "links": {"html": {"href": "https://bitbucket.org/tricura/ml-tagging/pull-requests/99"}},
            "author": {"uuid": "{u-1}", "display_name": "Douglas"},
            "source": {"branch": {"name": "perf/infer"}, "commit": {"hash": "998877665544"}, "repository": {"full_name": "tricura/ml-tagging"}},
            "destination": {"branch": {"name": "main"}, "repository": {"full_name": "tricura/ml-tagging"}},
            "reviewers": [{"uuid": "{u-2}", "display_name": "Ana"}],
            "participants": [
                {"role": "REVIEWER", "approved": True, "state": "approved", "user": {"uuid": "{u-2}", "display_name": "Ana"}},
            ],
        }
        statuses = {
            "values": [
                {"key": "build", "name": "Bitbucket Pipelines", "state": "SUCCESSFUL", "url": "https://bitbucket.org/pipelines/1"},
                {"key": "lint", "name": "Ruff", "state": "INPROGRESS", "url": ""},
            ]
        }
        diffstat = {"values": [{"lines_added": 50, "lines_removed": 10}, {"lines_added": 5, "lines_removed": 2}]}

        def fake_http(url, headers=None, method="GET", body=None, timeout=20):
            if url.endswith("/2.0/user"):
                return 200, {}, ident
            if "/workspaces/tricura/pullrequests/" in url:
                return 200, {}, {"values": [raw_pr]}
            if url.endswith("/statuses?pagelen=50"):
                return 200, {}, statuses
            if url.endswith("/diffstat?pagelen=100"):
                return 200, {}, diffstat
            return 404, {}, {}

        bb_cfg = {"enabled": True, "workspace": "tricura", "authMode": "env", "userEnvVar": "BB_USER", "tokenEnvVar": "BB_TOKEN"}
        cache = {"identities": {}, "diffstats": {}}
        with mock.patch.object(forge, "http_json", side_effect=fake_http):
            prs, fetch_err = forge.fetch_bitbucket_prs(
                "work",
                bb_cfg,
                {"BB_USER": "doug@work.com", "BB_TOKEN": "ATAT123"},
                {"bitbucket:tricura/ml-tagging": "/home/dobraga/src/ml-tagging"},
                cache,
            )
        self.assertIsNone(fetch_err)
        self.assertEqual(len(prs), 1)
        pr = prs[0]
        self.assertEqual(pr["key"], "bitbucket:tricura/ml-tagging#99")
        self.assertTrue(pr["isMine"])
        self.assertFalse(pr["isReviewRequested"])
        self.assertEqual(pr["ciState"], "pending")
        self.assertEqual(pr["reviewState"], "approved")
        self.assertEqual(pr["approvals"], 1)
        self.assertEqual(pr["unresolvedCount"], 2)
        self.assertEqual(pr["commentCount"], 4)
        self.assertEqual(pr["additions"], 55)
        self.assertEqual(pr["deletions"], 12)
        self.assertEqual(pr["changedFiles"], 2)

    def test_notification_diff_engine(self):
        pr_base = {
            "key": "github:dobraga/dotfiles#10",
            "profileId": "personal",
            "repoShort": "dotfiles",
            "number": 10,
            "title": "Test PR",
            "author": "dobraga",
            "isMine": True,
            "isReviewRequested": False,
            "ciState": "pending",
            "reviewState": "pending",
            "approvals": 0,
            "changesRequested": 0,
            "commentCount": 0,
            "unresolvedCount": 0,
        }
        pr_rev = {
            "key": "bitbucket:tricura/ml-tagging#5",
            "profileId": "work",
            "repoShort": "ml-tagging",
            "number": 5,
            "title": "Review me",
            "author": "alice",
            "isMine": False,
            "isReviewRequested": True,
            "ciState": "success",
            "reviewState": "pending",
            "approvals": 0,
            "changesRequested": 0,
            "commentCount": 0,
            "unresolvedCount": 0,
        }
        notif = dict(forge.DEFAULT_NOTIFICATIONS)
        # First baseline run produces no events
        self.assertEqual(forge.compute_notification_events(None, [pr_base, pr_rev], notif), [])

        prev = {
            pr_base["key"]: forge._snapshot_entry(pr_base),
        }
        # Identical poll produces no duplicate events
        self.assertEqual(forge.compute_notification_events(prev, [pr_base], notif), [])

        # CI fail + changes requested + comment + new review request
        pr_changed = {
            **pr_base,
            "ciState": "failure",
            "reviewState": "changes_requested",
            "changesRequested": 1,
            "commentCount": 2,
        }
        events = forge.compute_notification_events(prev, [pr_changed, pr_rev], notif)
        kinds = {e["kind"] for e in events}
        self.assertEqual(kinds, {"ci_failed", "changes_requested", "new_comments", "review_requested"})

        # Recovery: CI passed + approved
        prev2 = {pr_changed["key"]: forge._snapshot_entry(pr_changed), pr_rev["key"]: forge._snapshot_entry(pr_rev)}
        pr_recovered = {
            **pr_changed,
            "ciState": "success",
            "reviewState": "approved",
            "approvals": 1,
            "changesRequested": 0,
        }
        events2 = forge.compute_notification_events(prev2, [pr_recovered, pr_rev], notif)
        kinds2 = {e["kind"] for e in events2}
        self.assertEqual(kinds2, {"ci_passed", "approved"})

        # Respects disabled notifications
        self.assertEqual(forge.compute_notification_events(prev, [pr_changed, pr_rev], {**notif, "enabled": False}), [])
        events_no_ci = forge.compute_notification_events(prev, [pr_changed, pr_rev], {**notif, "ci": False})
        self.assertNotIn("ci_failed", {e["kind"] for e in events_no_ci})

    def test_detect_and_by_branch_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            gh_repo = tmp_path / "src" / "dotfiles"
            bb_repo = tmp_path / "src" / "ml-tagging"
            for repo_dir, remote in [
                (gh_repo, "git@github.com:dobraga/dotfiles.git"),
                (bb_repo, "git@bitbucket.org:tricura/ml-tagging.git"),
            ]:
                repo_dir.mkdir(parents=True)
                subprocess.run(["git", "init", str(repo_dir)], capture_output=True, check=True)
                subprocess.run(["git", "-C", str(repo_dir), "remote", "add", "origin", remote], capture_output=True, check=True)

            sf_path = tmp_path / "herdr-space-folders.json"
            sf_path.write_text(
                json.dumps({
                    "profiles": None,
                    "list": [
                        {"id": "f1", "name": "dotfiles", "path": str(gh_repo), "profile": "personal"},
                        {"id": "f2", "name": "tagging", "path": str(bb_repo), "profile": "work"},
                    ],
                }),
                encoding="utf-8",
            )
            env_path = tmp_path / ".env"
            env_path.write_text("BB_USER=doug\nBB_TOKEN=tok\n", encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {
                    "HERDR_SPACE_FOLDERS_CONFIG": str(sf_path),
                    "HERDR_ENV_FILE": str(env_path),
                    "HERDR_SRC_ROOT": str(tmp_path / "src"),
                },
                clear=False,
            ):
                detected = forge.detect_profiles_config()
                self.assertTrue(detected["envDetected"]["BB_USER"])
                self.assertTrue(detected["envDetected"]["BB_TOKEN"])
                p_sug = detected["suggestions"]["personal"]
                self.assertTrue(p_sug["github"]["enabled"])
                self.assertEqual(p_sug["github"]["account"], "dobraga")
                w_sug = detected["suggestions"]["work"]
                self.assertTrue(w_sug["bitbucket"]["enabled"])
                self.assertEqual(w_sug["bitbucket"]["workspace"], "tricura")

            by_branch = forge.build_by_branch_index([
                {
                    "key": "github:dobraga/dotfiles#1",
                    "profileId": "personal",
                    "provider": "github",
                    "repo": "dobraga/dotfiles",
                    "sourceBranch": "feat/x",
                    "number": 1,
                    "title": "X",
                    "url": "https://github.com/dobraga/dotfiles/pull/1",
                    "ciState": "success",
                    "reviewState": "approved",
                    "approvals": 1,
                    "changesRequested": 0,
                    "draft": False,
                    "conflicts": False,
                    "unresolvedCount": 0,
                    "isMine": True,
                    "isReviewRequested": False,
                }
            ])
            self.assertIn("github:dobraga/dotfiles::feat/x", by_branch)
            self.assertEqual(by_branch["github:dobraga/dotfiles::feat/x"]["number"], 1)

    def test_gh_login_flow_parser_worker_and_cancel(self):
        plain = (
            "! First copy your one-time code: A1B2-C3D4\n"
            "Open this URL to continue in your web browser: https://github.com/login/device\n"
            "✓ Logged in as dobraga\n"
        )
        self.assertEqual(
            forge.parse_gh_login_output(plain),
            {"code": "A1B2-C3D4", "url": "https://github.com/login/device", "user": "dobraga"},
        )
        colored = (
            "\x1b[0;1;93m! First copy your one-time code: \x1b[0mZX98-YQ12\n"
            "Open this URL: https://ghe.internal.com/login/device\n"
        )
        self.assertEqual(
            forge.parse_gh_login_output(colored),
            {"code": "ZX98-YQ12", "url": "https://ghe.internal.com/login/device", "user": ""},
        )

        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp) / "cache"
            with mock.patch.dict(
                os.environ,
                {"HERDR_FORGE_CACHE_DIR": str(cache_dir), "GH_TOKEN": "should_be_cleared", "GITHUB_TOKEN": "also_cleared"},
                clear=False,
            ):
                bad_host = forge.start_gh_login("github.com;evil")
                self.assertFalse(bad_host["ok"])
                self.assertEqual(bad_host["status"], "error")

                with mock.patch.object(forge.shutil, "which", return_value=None):
                    missing = forge.start_gh_login("github.com")
                    self.assertFalse(missing["ok"])
                    self.assertIn("not installed", missing["error"])

                r_fd, w_fd = os.pipe()
                os.write(
                    w_fd,
                    (
                        "! First copy your one-time code: ABCD-1234\n"
                        "Open this URL to continue in your web browser: https://github.com/login/device\n"
                        "✓ Logged in as dobraga-work\n"
                    ).encode(),
                )
                os.close(w_fd)
                r_file = os.fdopen(r_fd, "rb")

                fake_proc = mock.MagicMock()
                fake_proc.pid = 424242
                fake_proc.stdout = r_file
                fake_proc.poll.return_value = 0
                fake_proc.wait.return_value = 0

                seen_env = {}

                def fake_popen(args, **kwargs):
                    seen_env.update(kwargs.get("env") or {})
                    return fake_proc

                session_id = "testsession1"
                forge.write_json_atomic(
                    forge.gh_login_state_path(),
                    {
                        "sessionId": session_id,
                        "status": "starting",
                        "host": "github.com",
                        "code": "",
                        "url": "",
                        "user": "",
                        "error": "",
                        "workerPid": None,
                        "ghPid": None,
                        "beforeAccounts": [],
                    },
                    mode=0o600,
                )

                gh_accounts_mock = {
                    "installed": True,
                    "accounts": [{"host": "github.com", "user": "dobraga-work", "active": True}],
                }
                with (
                    mock.patch.object(forge.subprocess, "Popen", side_effect=fake_popen),
                    mock.patch.object(forge, "list_gh_accounts", return_value=gh_accounts_mock),
                ):
                    rc = forge.run_gh_login_worker(session_id, "github.com", timeout_sec=10)
                    r_file.close()
                    self.assertEqual(rc, 0)
                    self.assertEqual(seen_env.get("GH_PROMPT_DISABLED"), "1")
                    self.assertEqual(seen_env.get("GH_BROWSER"), "true")
                    self.assertEqual(seen_env.get("BROWSER"), "true")
                    self.assertNotIn("GH_TOKEN", seen_env)
                    self.assertNotIn("GITHUB_TOKEN", seen_env)

                    status = forge.get_gh_login_status()
                    self.assertTrue(status["ok"])
                    self.assertEqual(status["status"], "completed")
                    self.assertEqual(status["code"], "ABCD-1234")
                    self.assertEqual(status["url"], "https://github.com/login/device")
                    self.assertEqual(status["user"], "dobraga-work")
                    self.assertEqual(status["gh"], gh_accounts_mock)

                cancelled = forge.cancel_gh_login()
                self.assertEqual(cancelled, {"ok": True, "status": "cancelled"})
                self.assertEqual(forge.get_gh_login_status()["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
