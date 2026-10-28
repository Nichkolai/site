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

MAX_BODY = 1_000_000


def authorize(received: str, expected: str | None = None) -> tuple[int, str] | None:
    """Check the webhook secret. Returns (status, error) to reject, or None to accept.

    Fail closed: without a configured secret anybody could POST a forged update
    (including a fake ``successful_payment``), so every request is refused.
    """
    if expected is None:
        expected = os.environ.get("WEBHOOK_SECRET", "")
    expected = expected.strip()
    if not expected:
        return 503, "webhook_not_configured"
    if not hmac.compare_digest(received.encode("utf-8"), expected.encode("utf-8")):
        return 403, "forbidden"
    return None


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

        rejected = authorize(self.headers.get("X-Telegram-Bot-Api-Secret-Token", "") or "")
        if rejected:
            status, error = rejected
            if status == 503:
                print("[webhook] WEBHOOK_SECRET is not set: refusing all updates", flush=True)
            self._send_json(status, {"ok": False, "error": error})
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
