#!/usr/bin/env python3
"""Exercise the local Allo queue MCP against a fake Allo API."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "allo_dialing_queues_mcp.py"
sys.path.insert(0, str(ROOT))
import allo_dialing_queues_mcp as mcp  # noqa: E402


class Recorder(BaseHTTPRequestHandler):
    seen: list[tuple[str, str, dict[str, str], bytes]] = []

    def do_GET(self) -> None:  # noqa: N802
        self._record()

    def do_POST(self) -> None:  # noqa: N802
        self._record()

    def do_PATCH(self) -> None:  # noqa: N802
        self._record()

    def do_DELETE(self) -> None:  # noqa: N802
        self._record()

    def _record(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        Recorder.seen.append((self.command, self.path, dict(self.headers), body))
        payload = json.dumps({"data": {"ok": True, "path": self.path, "method": self.command}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def frame(payload: dict) -> bytes:
    data = json.dumps(payload).encode()
    return f"Content-Length: {len(data)}\r\n\r\n".encode() + data


def read_frame(stream) -> dict:
    headers: dict[str, str] = {}
    while True:
        line = stream.readline()
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode().split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return json.loads(stream.read(int(headers["content-length"])))


def test_csv_and_guards() -> None:
    rows = mcp.parse_calling_list_csv(
        "company,mobile,first_name,last_name,email\nAcme,+14155550100,Ada,Lovelace,ada@acme.com\n"
    )
    assert rows == [
        {
            "number": "+14155550100",
            "company": "Acme",
            "name": "Ada",
            "last_name": "Lovelace",
            "emails": ["ada@acme.com"],
        }
    ]
    try:
        mcp.delete_queue({"queue_id": "pdl_test", "confirm": False})
        raise AssertionError("delete without confirm should fail")
    except mcp.ApiError as error:
        assert "confirm=true" in str(error)
    try:
        mcp.raw_request({"method": "GET", "path": "/v2/api/users"})
        raise AssertionError("raw request should stay on dialing queues")
    except mcp.ApiError as error:
        assert "dialing-queues" in str(error)


def test_protocol_against_fake_api() -> None:
    Recorder.seen = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    env = os.environ.copy()
    env["ALLO_API_KEY"] = "ak_live_test"
    env["ALLO_API_BASE"] = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(
            frame(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05"},
                }
            )
        )
        proc.stdin.write(frame({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        proc.stdin.write(frame({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        proc.stdin.write(
            frame(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "allo_create_dialing_queue",
                        "arguments": {"name": "Houston GCs", "description": "Week of Sep 23"},
                    },
                }
            )
        )
        proc.stdin.write(
            frame(
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "allo_update_dialing_queue",
                        "arguments": {"queue_id": "pdl_test", "name": "Dallas GCs"},
                    },
                }
            )
        )
        proc.stdin.write(
            frame(
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {
                        "name": "allo_append_dialing_queue_numbers",
                        "arguments": {
                            "queue_id": "pdl_test",
                            "csv": "phone,company\n(212) 555-0100,Acme\n+33 6 12 34 56 78,Beta\n",
                        },
                    },
                }
            )
        )
        proc.stdin.flush()

        init = read_frame(proc.stdout)
        tools = read_frame(proc.stdout)
        created = read_frame(proc.stdout)
        updated = read_frame(proc.stdout)
        appended = read_frame(proc.stdout)
    finally:
        proc.kill()
        httpd.shutdown()

    assert init["result"]["serverInfo"]["name"] == "allo-dialing-queues"
    names = {item["name"] for item in tools["result"]["tools"]}
    assert "allo_create_dialing_queue" in names
    assert "allo_update_dialing_queue" in names
    assert "allo_list_dialing_queues" in names
    assert created["result"]["isError"] is False
    assert updated["result"]["isError"] is False
    assert appended["result"]["isError"] is False

    methods_paths = [(item[0], item[1]) for item in Recorder.seen]
    assert ("POST", "/v2/api/dialing-queues") in methods_paths
    assert ("PATCH", "/v2/api/dialing-queues/pdl_test") in methods_paths
    assert ("POST", "/v2/api/dialing-queues/pdl_test/numbers") in methods_paths
    create_body = json.loads(Recorder.seen[0][3])
    assert create_body == {"name": "Houston GCs", "description": "Week of Sep 23"}
    assert Recorder.seen[0][2]["Authorization"] == "Api-Key ak_live_test"
    append_body = json.loads(Recorder.seen[2][3])
    assert append_body["numbers"][0]["number"] == "(212) 555-0100"
    assert append_body["numbers"][0]["company"] == "Acme"
    assert append_body["numbers"][1]["company"] == "Beta"


if __name__ == "__main__":
    test_csv_and_guards()
    test_protocol_against_fake_api()
    print("ok")
