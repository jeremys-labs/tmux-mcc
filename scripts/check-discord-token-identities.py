#!/usr/bin/env python3
"""Fail closed unless every on-disk gateway token has the expected bot identity.

Token values are read from each agent's .env and sent to curl over stdin. They
are never placed in argv or printed. Output contains agent names, HTTP/result
status, and public Discord bot IDs only.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import stat
import subprocess
import sys
from pathlib import Path


EXPECTED_BOT_IDS = {
    "zara": "1492550595897196654",
    "marcus": "1492890428691710022",
    "eli": "1491968676491165847",
    "isla": "1493424335073841273",
    "hercule": "1501435950369210470",
    "remy": "1492157157305745538",
    "lena": "1492534519264186408",
    "nova": "1494169424205447288",
    "jordan": "1493805289227550721",
    "val": "1495579390355046451",
    "enzo": "1495838734527238356",
    "hank": "1508216728679878717",
    "cecelia": "1521319323073773628",
    "simone": "1531064626702323947",
    "dana": "1531065289016344606",
}

DEFAULT_PLIST = Path.home() / "Library/LaunchAgents/com.jeremylahners.codex-discord-gateway.plist"
DEFAULT_AGENTS_DIR = Path("/Volumes/Repo-Drive/agents")
DISCORD_ME_URL = "https://discord.com/api/v10/users/@me"


def load_gateway_agents(plist_path: Path) -> list[str]:
    with plist_path.open("rb") as handle:
        plist = plistlib.load(handle)
    arguments = plist.get("ProgramArguments")
    if not isinstance(arguments, list) or len(arguments) < 3:
        raise ValueError("gateway plist has no agent arguments")
    agents = [str(value) for value in arguments[2:]]
    if not agents or len(agents) != len(set(agents)):
        raise ValueError("gateway plist agent arguments are empty or duplicated")
    return agents


def read_token(env_path: Path) -> str:
    mode = stat.S_IMODE(env_path.stat().st_mode)
    if mode & 0o077:
        raise ValueError(f"credential file mode is {mode:04o}, expected 0600 or stricter")
    values = [
        line.split("=", 1)[1].strip()
        for line in env_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("DISCORD_BOT_TOKEN=")
    ]
    if not values or not values[0]:
        raise ValueError("DISCORD_BOT_TOKEN is missing")
    return values[0]


def fetch_identity(curl_bin: str, token: str) -> tuple[int, int | None, dict[str, object] | None]:
    result = subprocess.run(
        [
            curl_bin,
            "-sS",
            "--connect-timeout",
            "5",
            "--max-time",
            "15",
            "-w",
            "\n%{http_code}",
            "-H",
            "@-",
            DISCORD_ME_URL,
        ],
        input=f"Authorization: Bot {token}\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    body, separator, raw_status = result.stdout.rpartition("\n")
    status = int(raw_status) if separator and raw_status.isdigit() else None
    payload = None
    if result.returncode == 0 and status == 200:
        try:
            decoded = json.loads(body)
            if isinstance(decoded, dict):
                payload = decoded
        except json.JSONDecodeError:
            pass
    return result.returncode, status, payload


def check_agent(agent: str, agents_dir: Path, curl_bin: str) -> dict[str, object]:
    expected_id = EXPECTED_BOT_IDS.get(agent)
    row: dict[str, object] = {"agent": agent, "expected_id": expected_id}
    if expected_id is None:
        return {**row, "status": "missing_expected_id"}

    env_path = agents_dir / agent / ".claude/discord/.env"
    try:
        token = read_token(env_path)
    except (OSError, UnicodeError, ValueError) as error:
        return {**row, "status": "invalid_env", "detail": str(error)}

    try:
        curl_rc, http_status, payload = fetch_identity(curl_bin, token)
    except OSError:
        return {**row, "status": "curl_unavailable"}
    row.update(curl_rc=curl_rc, http=http_status)
    if curl_rc != 0:
        return {**row, "status": "network_error"}
    if http_status == 401:
        return {**row, "status": "unauthorized"}
    if http_status == 403:
        return {**row, "status": "client_blocked"}
    if http_status != 200 or payload is None:
        return {**row, "status": "http_or_json_error"}

    actual_id = str(payload.get("id", ""))
    row.update(actual_id=actual_id, username=payload.get("username"))
    if actual_id != expected_id:
        return {**row, "status": "identity_mismatch"}
    return {**row, "status": "ok"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plist", type=Path, default=DEFAULT_PLIST)
    parser.add_argument("--agents-dir", type=Path, default=DEFAULT_AGENTS_DIR)
    parser.add_argument("--curl-bin", default="curl")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        agents = load_gateway_agents(args.plist)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(json.dumps({"status": "invalid_gateway_plist", "detail": str(error)}))
        return 1

    results = [check_agent(agent, args.agents_dir, args.curl_bin) for agent in agents]
    for row in results:
        print(json.dumps(row, sort_keys=True))
    failed = [row for row in results if row["status"] != "ok"]
    print(
        json.dumps(
            {
                "status": "FAIL" if failed else "PASS",
                "agents": len(results),
                "failed": len(failed),
            },
            sort_keys=True,
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
