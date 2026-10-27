"""Vercel entrypoint for Telegram updates.

The Mini App uses Telegram.WebApp.sendData(), so production updates arrive as
Telegram webhook requests. The bot logic stays in bot.py; this module only
verifies the webhook secret and dispatches the update.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bot  # noqa: E402

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").strip()
MAX_BODY = 1_000_000


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
        if self._path() not in ("/api/telegram", "/api/telegram/health"):
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        self._send_json(200, {"ok": True, "service": "kaz-telegram"})

    def do_POST(self) -> None:
        if self._path() != "/api/telegram":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        if WEBHOOK_SECRET:
            received = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
            if not hmac.compare_digest(received, WEBHOOK_SECRET):
                self._send_json(403, {"ok": False, "error": "forbidden"})
                return

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"ok": False, "error": "bad_body"})
            return

        try:
            raw = self.rfile.read(length)
            update = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            print(f"[webhook] invalid update: {type(exc).__name__}", flush=True)
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        if not isinstance(update, dict):
            self._send_json(400, {"ok": False, "error": "invalid_update"})
            return

        try:
            bot.handle_update(update)
        except bot.payments.PaymentStorageError as exc:
            print(f"[webhook] payment storage error: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "payment_storage"})
            return
        except bot.BotAPIError as exc:
            print(f"[webhook] telegram api error: {exc.description}", flush=True)
        except Exception as exc:  # keep Telegram from retrying forever
            print(f"[webhook] handler error: {type(exc).__name__}: {exc}", flush=True)

        self._send_json(200, {"ok": True})
