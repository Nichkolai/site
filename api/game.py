"""Server-side game API for the KAZ Mini App.

One endpoint, one JSON body: ``{"initData": ..., "token": ..., "action": ...}``.
The server owns the balance and plays every game; the app only sends choices
(bet, tile, hit/stand, ...) and draws the results it gets back.
"""

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
from kaz import engine  # noqa: E402
from kaz.store import GameError  # noqa: E402

MAX_BODY = 20_000
RESERVED = {"action", "initData", "token"}


def _contact(user: dict | None) -> str:
    if not user:
        return ""
    if user.get("username"):
        return f"@{user['username']}"
    return " ".join(
        part for part in (user.get("first_name"), user.get("last_name")) if part
    ).strip()


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
        if self._path() not in ("/api/game", "/api/game/health"):
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        self._send_json(200, {"ok": True, "service": "kaz-game"})

    def do_POST(self) -> None:
        if self._path() != "/api/game":
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
        if not isinstance(payload, dict):
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        init_data = str(payload.get("initData") or "")
        token = str(payload.get("token") or "")
        user = payments.validate_init_data(init_data, bot.BOT_TOKEN) if init_data else None
        user_id = int(user["id"]) if user else payments.validate_session_token(token)
        if not user_id:
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        action = str(payload.get("action") or "")
        params = {key: value for key, value in payload.items() if key not in RESERVED}

        try:
            response = engine.run(user_id, action, params, _contact(user))
        except GameError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.code, "message": exc.message})
            return
        except payments.PaymentStorageError as exc:
            print(f"[game] storage: {exc}", flush=True)
            self._send_json(503, {"ok": False, "error": "storage_unavailable"})
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[game] unexpected: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal_error"})
            return

        if action == "withdraw.request":
            item = response["result"].get("withdrawal")
            if item:
                try:
                    response["result"]["notified"] = engine.notify_withdrawal(user_id, item)
                except Exception as exc:  # noqa: BLE001
                    print(f"[game] withdraw notify: {type(exc).__name__}: {exc}", flush=True)
                    response["result"]["notified"] = False

        self._send_json(200, response)
