#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import os
import plistlib
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-discord-token-identities.py")
SPEC = importlib.util.spec_from_file_location("discord_token_preflight", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DiscordTokenIdentityPreflightTests(unittest.TestCase):
    def fixture(self, mode: str = "ok") -> tuple[Path, Path, Path]:
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        agents = root / "agents"
        env_path = agents / "zara/.claude/discord/.env"
        env_path.parent.mkdir(parents=True)
        env_path.write_text("DISCORD_BOT_TOKEN=fixture-secret\n", encoding="utf-8")
        env_path.chmod(0o600)

        plist = root / "gateway.plist"
        with plist.open("wb") as handle:
            plistlib.dump(
                {"ProgramArguments": ["bash", "start-codex-discord-gateway.sh", "zara"]},
                handle,
            )

        curl = root / "curl"
        response_id = (
            MODULE.EXPECTED_BOT_IDS["zara"]
            if mode != "mismatch"
            else "999999999999999999"
        )
        status = {"ok": "200", "mismatch": "200", "unauthorized": "401", "blocked": "403"}[mode]
        curl.write_text(
            "#!/bin/sh\n"
            "IFS= read -r header\n"
            'printf "%s\\n" "$@" > "$FAKE_CURL_ARGV"\n'
            'printf "%s\\n" "$header" > "$FAKE_CURL_STDIN"\n'
            f"printf '%s\\n{status}' '{json.dumps({'id': response_id, 'username': 'Zara'})}'\n",
            encoding="utf-8",
        )
        curl.chmod(0o755)
        return agents, plist, curl

    def run_main(self, mode: str) -> tuple[int, str, Path, Path]:
        agents, plist, curl = self.fixture(mode)
        argv_capture = plist.parent / "argv"
        stdin_capture = plist.parent / "stdin"
        old = os.environ.copy()
        os.environ.update(FAKE_CURL_ARGV=str(argv_capture), FAKE_CURL_STDIN=str(stdin_capture))
        try:
            output = io.StringIO()
            with redirect_stdout(output):
                code = MODULE.main(
                    ["--plist", str(plist), "--agents-dir", str(agents), "--curl-bin", str(curl)]
                )
        finally:
            os.environ.clear()
            os.environ.update(old)
        return code, output.getvalue(), argv_capture, stdin_capture

    def test_passes_without_putting_token_in_argv_or_output(self) -> None:
        code, output, argv_capture, stdin_capture = self.run_main("ok")
        self.assertEqual(code, 0)
        self.assertIn('"status": "PASS"', output)
        self.assertNotIn("fixture-secret", output)
        self.assertNotIn("fixture-secret", argv_capture.read_text())
        self.assertIn("fixture-secret", stdin_capture.read_text())

    def test_identity_mismatch_fails(self) -> None:
        code, output, _, _ = self.run_main("mismatch")
        self.assertEqual(code, 1)
        self.assertIn('"status": "identity_mismatch"', output)

    def test_401_is_bad_token(self) -> None:
        code, output, _, _ = self.run_main("unauthorized")
        self.assertEqual(code, 1)
        self.assertIn('"status": "unauthorized"', output)

    def test_403_is_client_blocked(self) -> None:
        code, output, _, _ = self.run_main("blocked")
        self.assertEqual(code, 1)
        self.assertIn('"status": "client_blocked"', output)

    def test_missing_curl_fails_closed(self) -> None:
        agents, plist, _ = self.fixture("ok")
        output = io.StringIO()
        with redirect_stdout(output):
            code = MODULE.main(
                [
                    "--plist",
                    str(plist),
                    "--agents-dir",
                    str(agents),
                    "--curl-bin",
                    str(plist.parent / "missing-curl"),
                ]
            )
        self.assertEqual(code, 1)
        self.assertIn('"status": "curl_unavailable"', output.getvalue())


if __name__ == "__main__":
    unittest.main()
