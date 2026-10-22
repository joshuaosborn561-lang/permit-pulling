#!/usr/bin/env python3
"""Local MCP server for Allo Power Dialer queues.

The hosted Allo connector (https://mcp.withallo.com/mcp) only exposes the
current queue. GET /v2/api/me on this account also lists collection routes
that create, update, read, and delete queues by id. This server is those
routes, plus a CSV parser that posts numbers as JSON.

Auth header, from https://help.withallo.com/en/v2/api-reference/authentication :

    Authorization: Api-Key ak_live_...

Paste this into Claude Desktop (Settings > Developer > Edit Config), or merge
the same object into Claude Code's MCP config. Save this file first and
replace the path and key:

{
  "mcpServers": {
    "allo-dialing-queues": {
      "command": "python3",
      "args": ["ABSOLUTE_PATH/allo_dialing_queues_mcp.py"],
      "env": {
        "ALLO_API_KEY": "ak_live_your_key_here"
      }
    }
  }
}

Claude Code:

    claude mcp add allo-dialing-queues --transport stdio \\
      --env ALLO_API_KEY=ak_live_your_key_here -- \\
      python3 ABSOLUTE_PATH/allo_dialing_queues_mcp.py

Scope required on the key: DIALING_QUEUE_READ_WRITE.
Do not commit the key. Create it in Allo at Settings > API.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_BASE = os.environ.get("ALLO_API_BASE", "https://api.withallo.com").rstrip("/")
QUEUE_PREFIX = "/v2/api/dialing-queues"
MAX_APPEND = 1000
PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")

PHONE_COLUMNS = (
    "number",
    "phone",
    "phone_number",
    "mobile",
    "cell",
    "telephone",
    "number_to",
)
COLUMN_MAP = {
    "name": "name",
    "first_name": "name",
    "firstname": "name",
    "contact": "name",
    "last_name": "last_name",
    "lastname": "last_name",
    "surname": "last_name",
    "company": "company",
    "company_name": "company",
    "business": "company",
    "website": "website",
    "url": "website",
    "job_title": "job_title",
    "title": "job_title",
    "job": "job_title",
    "email": "emails",
    "emails": "emails",
    "address": "addresses",
    "addresses": "addresses",
}


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def auth_header() -> str:
    key = os.environ.get("ALLO_API_KEY", "").strip()
    if not key:
        raise ApiError(
            "ALLO_API_KEY is not set. Put the Allo API key in the MCP server env. "
            "Header form is 'Api-Key ak_live_...'; a bare ak_live_ key is also accepted."
        )
    lowered = key.lower()
    if lowered.startswith("api-key ") or lowered.startswith("bearer "):
        return key
    return f"Api-Key {key}"


def api(
    method: str,
    path: str,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
) -> Any:
    if not path.startswith(QUEUE_PREFIX):
        raise ApiError(f"Refusing path outside {QUEUE_PREFIX}: {path}")
    params = {
        key: value
        for key, value in (query or {}).items()
        if value is not None and value != ""
    }
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    headers = {
        "Authorization": auth_header(),
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        if error.code == 409 and path.endswith("/numbers") and method == "POST":
            raise ApiError(
                f"Allo returned 409 on append. The published meaning is a concurrent "
                f"position conflict, which is safe to retry. Body: {detail}",
                status=409,
            )
        raise ApiError(f"Allo {method} {path} returned {error.code}: {detail}", status=error.code) from error
    except urllib.error.URLError as error:
        raise ApiError(f"Could not reach Allo: {error.reason}") from error


def compact(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


def normalize_header(value: str) -> str:
    return value.strip().lower().replace(" ", "_").replace("-", "_")


def parse_calling_list_csv(text: str) -> list[dict[str, Any]]:
    sample = text.lstrip("\ufeff")
    if not sample.strip():
        raise ApiError("CSV is empty.")
    reader = csv.DictReader(io.StringIO(sample))
    if not reader.fieldnames:
        raise ApiError("CSV has no header row.")
    headers = [normalize_header(name) for name in reader.fieldnames if name]
    phone_key = next((name for name in headers if name in PHONE_COLUMNS), None)
    if phone_key is None:
        raise ApiError(
            "CSV needs a phone column named one of: " + ", ".join(PHONE_COLUMNS)
        )
    numbers: list[dict[str, Any]] = []
    for row in reader:
        source = {normalize_header(key): (value or "").strip() for key, value in row.items() if key}
        phone = source.get(phone_key, "")
        if not phone:
            continue
        item: dict[str, Any] = {"number": phone}
        for header, field in COLUMN_MAP.items():
            value = source.get(header, "")
            if not value or header == phone_key:
                continue
            if field in ("emails", "addresses"):
                item.setdefault(field, []).append(value)
            elif field not in item:
                item[field] = value
        numbers.append(item)
    if not numbers:
        raise ApiError("CSV header was recognized, but no rows had a phone number.")
    return numbers


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def require_confirm(arguments: dict[str, Any], action: str) -> None:
    if arguments.get("confirm") is not True:
        raise ApiError(f"{action} was not sent. Pass confirm=true to run it.")


def list_queues(arguments: dict[str, Any]) -> Any:
    return api(
        "GET",
        QUEUE_PREFIX,
        query={
            "page": arguments.get("page"),
            "size": arguments.get("size"),
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
        },
    )


def create_queue(arguments: dict[str, Any]) -> Any:
    body = compact(
        {
            "name": arguments.get("name"),
            "description": arguments.get("description"),
            "voicemail_handling": arguments.get("voicemail_handling"),
            "do_not_disturb": arguments.get("do_not_disturb"),
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
        }
    )
    return api("POST", QUEUE_PREFIX, body=body)


def get_queue(arguments: dict[str, Any]) -> Any:
    queue_id = required(arguments, "queue_id")
    return api(
        "GET",
        f"{QUEUE_PREFIX}/{urllib.parse.quote(queue_id, safe='')}",
        query={"page": arguments.get("page"), "size": arguments.get("size")},
    )


def update_queue(arguments: dict[str, Any]) -> Any:
    queue_id = required(arguments, "queue_id")
    body = compact(
        {
            "name": arguments.get("name"),
            "description": arguments.get("description"),
            "voicemail_handling": arguments.get("voicemail_handling"),
            "do_not_disturb": arguments.get("do_not_disturb"),
        }
    )
    if not body:
        raise ApiError("Pass at least one of name, description, voicemail_handling, do_not_disturb.")
    return api("PATCH", f"{QUEUE_PREFIX}/{urllib.parse.quote(queue_id, safe='')}", body=body)


def delete_queue(arguments: dict[str, Any]) -> Any:
    require_confirm(arguments, "Delete")
    queue_id = required(arguments, "queue_id")
    return api("DELETE", f"{QUEUE_PREFIX}/{urllib.parse.quote(queue_id, safe='')}")


def numbers_from_arguments(arguments: dict[str, Any]) -> list[dict[str, Any]]:
    numbers = arguments.get("numbers")
    csv_text = arguments.get("csv")
    if numbers and csv_text:
        raise ApiError("Pass numbers or csv, not both.")
    if csv_text:
        return parse_calling_list_csv(csv_text)
    if not numbers:
        raise ApiError("Pass numbers or csv.")
    return numbers


def append_numbers(arguments: dict[str, Any], path: str, assignee: dict[str, Any] | None = None) -> Any:
    items = numbers_from_arguments(arguments)
    batches = chunked(items, MAX_APPEND)
    combined: list[Any] = []
    for batch in batches:
        body: dict[str, Any] = {"numbers": batch}
        if assignee:
            body.update(compact(assignee))
        try:
            combined.append(api("POST", path, body=body))
        except ApiError as error:
            if error.status != 409:
                raise
            combined.append(api("POST", path, body=body))
    if len(combined) == 1:
        return combined[0]
    return {"batches": combined, "batch_count": len(combined)}


def append_queue_numbers(arguments: dict[str, Any]) -> Any:
    queue_id = required(arguments, "queue_id")
    return append_numbers(
        arguments,
        f"{QUEUE_PREFIX}/{urllib.parse.quote(queue_id, safe='')}/numbers",
    )


def clear_filters(arguments: dict[str, Any]) -> dict[str, Any]:
    number = arguments.get("number")
    position = arguments.get("position")
    unassigned = arguments.get("unassigned")
    if unassigned and (number or position is not None):
        raise ApiError("unassigned=true cannot be combined with number or position.")
    if not unassigned and not number and position is None:
        raise ApiError("Provide number, position, or unassigned=true.")
    return compact(
        {
            "number": number,
            "position": position,
            "unassigned": "true" if unassigned else None,
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
        }
    )


def clear_queue_numbers(arguments: dict[str, Any]) -> Any:
    queue_id = required(arguments, "queue_id")
    return api(
        "DELETE",
        f"{QUEUE_PREFIX}/{urllib.parse.quote(queue_id, safe='')}/numbers",
        query=clear_filters(arguments),
    )


def current_query(arguments: dict[str, Any]) -> dict[str, Any]:
    return compact(
        {
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
            "page": arguments.get("page"),
            "size": arguments.get("size"),
        }
    )


def get_current(arguments: dict[str, Any]) -> Any:
    return api("GET", f"{QUEUE_PREFIX}/current", query=current_query(arguments))


def update_current(arguments: dict[str, Any]) -> Any:
    body = compact(
        {
            "name": arguments.get("name"),
            "voicemail_handling": arguments.get("voicemail_handling"),
            "do_not_disturb": arguments.get("do_not_disturb"),
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
        }
    )
    if not any(key in body for key in ("name", "voicemail_handling", "do_not_disturb")):
        raise ApiError("Pass name, voicemail_handling, or do_not_disturb.")
    return api("PATCH", f"{QUEUE_PREFIX}/current", body=body)


def reset_current(arguments: dict[str, Any]) -> Any:
    require_confirm(
        arguments,
        "Reset replaces the active queue for that person. Older queues stop being returned by GET /current",
    )
    body = compact(
        {
            "name": arguments.get("name"),
            "user_id": arguments.get("user_id"),
            "email": arguments.get("email"),
        }
    )
    return api("POST", f"{QUEUE_PREFIX}/current", body=body)


def delete_current(arguments: dict[str, Any]) -> Any:
    require_confirm(arguments, "Delete current queue")
    return api(
        "DELETE",
        f"{QUEUE_PREFIX}/current",
        query=compact({"user_id": arguments.get("user_id"), "email": arguments.get("email")}),
    )


def append_current_numbers(arguments: dict[str, Any]) -> Any:
    return append_numbers(
        arguments,
        f"{QUEUE_PREFIX}/current/numbers",
        assignee={"user_id": arguments.get("user_id"), "email": arguments.get("email")},
    )


def clear_current_numbers(arguments: dict[str, Any]) -> Any:
    return api("DELETE", f"{QUEUE_PREFIX}/current/numbers", query=clear_filters(arguments))


def get_session(arguments: dict[str, Any]) -> Any:
    session_id = required(arguments, "session_id")
    return api("GET", f"{QUEUE_PREFIX}/sessions/{urllib.parse.quote(session_id, safe='')}")


def raw_request(arguments: dict[str, Any]) -> Any:
    method = str(arguments.get("method", "")).upper()
    if method not in {"GET", "POST", "PATCH", "DELETE"}:
        raise ApiError("method must be GET, POST, PATCH, or DELETE.")
    path = str(arguments.get("path", ""))
    if not path.startswith(QUEUE_PREFIX) or ".." in path or "://" in path:
        raise ApiError(f"path must start with {QUEUE_PREFIX}.")
    if method in {"DELETE", "POST"} and path.rstrip("/") in {
        QUEUE_PREFIX + "/current",
        QUEUE_PREFIX,
    }:
        require_confirm(arguments, f"{method} {path}")
    body = arguments.get("body")
    if body is not None and not isinstance(body, dict):
        raise ApiError("body must be a JSON object.")
    query = arguments.get("query")
    if query is not None and not isinstance(query, dict):
        raise ApiError("query must be a JSON object.")
    return api(method, path, query=query, body=body if method != "GET" else None)


def required(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ApiError(f"{key} is required.")
    return value.strip()


NUMBER_ITEM = {
    "type": "object",
    "additionalProperties": False,
    "required": ["number"],
    "properties": {
        "number": {"type": "string", "description": "Phone number. Allo normalizes it to E.164."},
        "name": {"type": "string"},
        "last_name": {"type": "string"},
        "company": {"type": "string"},
        "website": {"type": "string"},
        "job_title": {"type": "string"},
        "emails": {"type": "array", "items": {"type": "string"}},
        "addresses": {"type": "array", "items": {"type": "string"}},
    },
}

SETTINGS = {
    "voicemail_handling": {
        "type": "string",
        "enum": ["SKIP", "NO_SKIP"],
        "description": "SKIP advances past voicemail. NO_SKIP stays on the call.",
    },
    "do_not_disturb": {
        "type": "string",
        "enum": ["ENABLED", "DISABLED"],
        "description": "ENABLED silences inbound calls while this queue is running.",
    },
}

ASSIGNEE = {
    "user_id": {
        "type": "string",
        "description": "Teammate id from GET /v2/api/users. Wins over email.",
    },
    "email": {"type": "string", "description": "Teammate email. Same team as the API key."},
}


def tool(name: str, description: str, properties: dict[str, Any], required_fields: list[str], handler: Any) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
    }
    if required_fields:
        schema["required"] = required_fields
    return {
        "name": name,
        "description": description,
        "inputSchema": schema,
        "handler": handler,
    }


TOOLS = [
    tool(
        "allo_list_dialing_queues",
        "List Power Dialer queues. This is GET /v2/api/dialing-queues, which the hosted Allo MCP does not expose. Each person still has one active queue; this list is the stored queues your key can see.",
        {
            "page": {"type": "integer", "minimum": 1},
            "size": {"type": "integer", "minimum": 1, "maximum": 100},
            **ASSIGNEE,
        },
        [],
        list_queues,
    ),
    tool(
        "allo_create_dialing_queue",
        "Create a dialing queue with POST /v2/api/dialing-queues. Use this to keep a named list separate from the active queue. Do not use reset (POST /current) for that: reset replaces the queue the person is dialing. After create, append that CSV with allo_append_dialing_queue_numbers and the returned queue id.",
        {
            "name": {"type": "string", "minLength": 1, "maxLength": 255},
            "description": {"type": "string", "description": "Queue description. Advertised by GET /v2/api/me on the by-id update route."},
            **SETTINGS,
            **ASSIGNEE,
        },
        [],
        create_queue,
    ),
    tool(
        "allo_get_dialing_queue_by_id",
        "Read one queue and its numbers by id. GET /v2/api/dialing-queues/{queue_id}.",
        {
            "queue_id": {"type": "string", "description": "Queue id, prefix pdl."},
            "page": {"type": "integer", "minimum": 1},
            "size": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        ["queue_id"],
        get_queue,
    ),
    tool(
        "allo_update_dialing_queue",
        "Update a stored queue's name, description, voicemail handling, or do-not-disturb. PATCH /v2/api/dialing-queues/{queue_id}. This does not switch which queue the dialer is running.",
        {
            "queue_id": {"type": "string"},
            "name": {"type": "string", "minLength": 1, "maxLength": 255},
            "description": {"type": "string"},
            **SETTINGS,
        },
        ["queue_id"],
        update_queue,
    ),
    tool(
        "allo_delete_dialing_queue",
        "Delete one stored queue by id. Requires confirm=true. Does not delete the current queue unless that id is the current one.",
        {"queue_id": {"type": "string"}, "confirm": {"type": "boolean"}},
        ["queue_id", "confirm"],
        delete_queue,
    ),
    tool(
        "allo_append_dialing_queue_numbers",
        "Append a calling list to a queue id. Pass JSON numbers or a CSV string with a header. The CSV is parsed here and sent as JSON; Allo has no CSV upload on the API. Phone column: number, phone, phone_number, mobile, cell, telephone, or number_to. Optional columns: name, last_name, company, website, job_title, email, address. Sends at most 1000 numbers per request and repeats until the list is sent. Published queue cap in the OpenAPI error example is 25,000 numbers.",
        {
            "queue_id": {"type": "string"},
            "numbers": {"type": "array", "items": NUMBER_ITEM, "maxItems": MAX_APPEND},
            "csv": {"type": "string", "description": "Full CSV text including the header row."},
        },
        ["queue_id"],
        append_queue_numbers,
    ),
    tool(
        "allo_clear_dialing_queue_numbers",
        "Remove numbers from a queue id. Provide number, position, or unassigned=true. unassigned cannot be combined with the other filters. number plus position deletes one occurrence.",
        {
            "queue_id": {"type": "string"},
            "number": {"type": "string"},
            "position": {"type": "integer", "minimum": 0},
            "unassigned": {"type": "boolean"},
        },
        ["queue_id"],
        clear_queue_numbers,
    ),
    tool(
        "allo_get_current_dialing_queue",
        "Read the one active Power Dialer queue for the API key owner, or for a teammate when user_id or email is set.",
        {
            "page": {"type": "integer", "minimum": 1},
            "size": {"type": "integer", "minimum": 1, "maximum": 100},
            **ASSIGNEE,
        },
        [],
        get_current,
    ),
    tool(
        "allo_update_current_dialing_queue",
        "Update the active queue's name, voicemail handling, or do-not-disturb. PATCH /v2/api/dialing-queues/current. The published current-queue schema has no description field; use allo_update_dialing_queue for a stored queue id.",
        {
            "name": {"type": "string", "minLength": 1, "maxLength": 255},
            **SETTINGS,
            **ASSIGNEE,
        },
        [],
        update_current,
    ),
    tool(
        "allo_reset_current_dialing_queue",
        "Replace the active queue with a new empty one. POST /v2/api/dialing-queues/current. The previous queue for that person stops being returned by GET /current. Requires confirm=true. Use allo_create_dialing_queue when the list should be stored without replacing the live queue.",
        {
            "confirm": {"type": "boolean"},
            "name": {"type": "string", "maxLength": 255},
            **ASSIGNEE,
        },
        ["confirm"],
        reset_current,
    ),
    tool(
        "allo_delete_current_dialing_queue",
        "Delete the active queue. DELETE /v2/api/dialing-queues/current. Requires confirm=true.",
        {"confirm": {"type": "boolean"}, **ASSIGNEE},
        ["confirm"],
        delete_current,
    ),
    tool(
        "allo_append_current_dialing_queue_numbers",
        "Append JSON numbers or a CSV calling list to the active queue. Same CSV columns as allo_append_dialing_queue_numbers. Pass user_id or email to append to a teammate's active queue.",
        {
            "numbers": {"type": "array", "items": NUMBER_ITEM},
            "csv": {"type": "string"},
            **ASSIGNEE,
        },
        [],
        append_current_numbers,
    ),
    tool(
        "allo_clear_current_dialing_queue_numbers",
        "Remove numbers from the active queue. Same filters as allo_clear_dialing_queue_numbers.",
        {
            "number": {"type": "string"},
            "position": {"type": "integer", "minimum": 0},
            "unassigned": {"type": "boolean"},
            **ASSIGNEE,
        },
        [],
        clear_current_numbers,
    ),
    tool(
        "allo_get_dialing_session",
        "Read one Power Dialer session. GET /v2/api/dialing-queues/sessions/{id}.",
        {"session_id": {"type": "string"}},
        ["session_id"],
        get_session,
    ),
    tool(
        "allo_dialing_queue_request",
        "Call any /v2/api/dialing-queues route directly. Use this when a typed tool's body is rejected and the error tells you the field names. POST or DELETE of /v2/api/dialing-queues and /v2/api/dialing-queues/current require confirm=true.",
        {
            "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "DELETE"]},
            "path": {"type": "string", "description": "Must start with /v2/api/dialing-queues."},
            "query": {"type": "object", "additionalProperties": True},
            "body": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean"},
        },
        ["method", "path"],
        raw_request,
    ),
]

HANDLERS = {item["name"]: item["handler"] for item in TOOLS}


def tool_specs() -> list[dict[str, Any]]:
    return [
        {"name": item["name"], "description": item["description"], "inputSchema": item["inputSchema"]}
        for item in TOOLS
    ]


def call_tool(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    handler = HANDLERS.get(name)
    if handler is None:
        raise ApiError(f"Unknown tool {name}.")
    payload = handler(arguments or {})
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}], "isError": False}


def error_result(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    message_id = message.get("id")
    if message_id is None:
        return None
    if method == "initialize":
        requested = (message.get("params") or {}).get("protocolVersion")
        version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "allo-dialing-queues", "version": "1.0.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": message_id, "result": {"tools": tool_specs()}}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            result = call_tool(params.get("name", ""), params.get("arguments") or {})
        except ApiError as error:
            result = error_result(str(error))
        except Exception as error:  # noqa: BLE001 — return tool failures to the client
            result = error_result(f"{type(error).__name__}: {error}")
        return {"jsonrpc": "2.0", "id": message_id, "result": result}
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def read_message() -> dict[str, Any] | None:
    headers: dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        decoded = line.decode("utf-8", errors="replace")
        if ":" not in decoded:
            continue
        key, value = decoded.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode())


def write_message(payload: dict[str, Any]) -> None:
    data = json.dumps(payload).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
    sys.stdout.buffer.flush()


def serve() -> None:
    while True:
        message = read_message()
        if message is None:
            return
        response = handle(message)
        if response is not None:
            write_message(response)


def print_config() -> None:
    path = os.path.abspath(__file__)
    config = {
        "mcpServers": {
            "allo-dialing-queues": {
                "command": "python3",
                "args": [path],
                "env": {"ALLO_API_KEY": "PASTE_ALLO_API_KEY"},
            }
        }
    }
    print(json.dumps(config, indent=2))


if __name__ == "__main__":
    if "--print-config" in sys.argv:
        print_config()
    else:
        serve()
