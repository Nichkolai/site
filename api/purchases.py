"""Authenticated purchase sync for the KAZ Mini App."""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bot  # noqa: E402
import payments  # noqa: E402

MAX_BODY = 20_000


class handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def _path(self) -> str:
        return (self.path or "").split("?", 1)[0].rstrip("/") or "/"

    def do_GET(self) -> None:
        if self._path() not in ("/api/purchases", "/api/purchases/health"):
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        self._send_json(200, {"ok": True, "service": "kaz-purchases"})

    def do_POST(self) -> None:
        if self._path() != "/api/purchases":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"ok": False, "error": "bad_body"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        data = payload if isinstance(payload, dict) else {}
        init_data = data.get("initData") or ""
        token = data.get("token") or ""
        user_id = payments.resolve_user_id(
            str(init_data), str(token), bot.BOT_TOKEN
        )
        if not user_id:
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        try:
            purchases = payments.list_purchases(user_id)
        except payments.PaymentStorageError as exc:
            print(f"[purchases] storage: {exc}", flush=True)
            self._send_json(503, {"ok": False, "error": "storage_unavailable"})
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[purchases] unexpected: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal_error"})
            return

        self._send_json(200, {
            "ok": True,
            "purchases": purchases,
        })
