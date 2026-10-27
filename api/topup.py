"""Authenticated top-up invoice creation for the KAZ Mini App.

The Mini App calls this endpoint to have the bot send a Stars invoice
straight into the user's chat, so top-up does not depend on deep-link
support in the ShuzaGram client.
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bot  # noqa: E402
import payments  # noqa: E402

MAX_BODY = 20_000
INVOICE_COOLDOWN = 4.0
_last_invoice: dict[int, float] = {}


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
        if self._path() not in ("/api/topup", "/api/topup/health"):
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        self._send_json(200, {"ok": True, "service": "kaz-topup"})

    def do_POST(self) -> None:
        if self._path() != "/api/topup":
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

        init_data = payload.get("initData") if isinstance(payload, dict) else ""
        user = payments.validate_init_data(init_data, bot.BOT_TOKEN)
        if not user:
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        try:
            user_id = int(user["id"])
            amount = int(payload.get("amount"))
        except (KeyError, TypeError, ValueError):
            self._send_json(400, {"ok": False, "error": "invalid_amount"})
            return

        if amount < payments.MIN_TOPUP or amount > payments.MAX_TOPUP:
            self._send_json(400, {"ok": False, "error": "invalid_amount"})
            return

        now = time.monotonic()
        if now - _last_invoice.get(user_id, 0.0) < INVOICE_COOLDOWN:
            self._send_json(429, {"ok": False, "error": "too_many_requests"})
            return
        _last_invoice[user_id] = now
        if len(_last_invoice) > 5000:
            _last_invoice.clear()
            _last_invoice[user_id] = now

        try:
            message_id = bot.send_topup_invoice(user_id, amount)
        except bot.BotAPIError as exc:
            print(f"[topup] telegram api: {exc.description}", flush=True)
            self._send_json(502, {"ok": False, "error": "invoice_failed"})
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[topup] unexpected: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal_error"})
            return

        self._send_json(200, {"ok": True, "message_id": message_id})
