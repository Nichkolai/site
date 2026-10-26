#!/usr/bin/env python3
"""
KAZ — Telegram/ShuzaGram bot + static server for the Mini App.

Run:
    python bot.py

Environment variables:
    BOT_TOKEN       token from @BotFather (required for the bot)
    WEBAPP_URL      public HTTPS URL of this app (required by Telegram)
    PORT            local static server port (default 8080)
    HOST            bind address (default 0.0.0.0)
    SHUZA_API_BASE  Bot API base (default https://api.shuzagram.com)

No third-party packages are required: this file uses only the Python
standard library. The app itself is a static SPA and stores progress in
the user's browser via localStorage.
"""

from __future__ import annotations

import html
import json
import mimetypes
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Windows consoles often default to cp1252/cp866; the bot prints Russian text.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass


def log(message: str) -> None:
    print(message, flush=True)

ROOT = Path(__file__).resolve().parent
ALLOWED_SUFFIXES = {
    ".html", ".css", ".js", ".mjs", ".json", ".webmanifest",
    ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".gif",
    ".woff", ".woff2", ".ttf", ".otf",
}

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE, # comments). Existing env wins."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip().lstrip("\ufeff")
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[7:].strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


load_dotenv()

API_BASE = os.environ.get("SHUZA_API_BASE", "https://api.shuzagram.com").rstrip("/")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
try:
    PORT = int(os.environ.get("PORT", "8080") or 8080)
except ValueError:
    PORT = 8080
HOST = os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0"
WEBAPP_URL = (os.environ.get("WEBAPP_URL", "").strip() or f"http://127.0.0.1:{PORT}").rstrip("/")
ADMIN_ID = os.environ.get("ADMIN_ID", "").strip()
ADMIN_IDS = [
    part.strip()
    for part in (os.environ.get("ADMIN_IDS") or ADMIN_ID).replace(";", ",").split(",")
    if part.strip()
]


class BotAPIError(RuntimeError):
    def __init__(self, method: str, description: str, code: int | None = None) -> None:
        super().__init__(f"{method}: {description}")
        self.method = method
        self.description = description
        self.code = code


def api(method: str, payload: dict | None = None, timeout: float = 35.0):
    """Call a Bot API method on ShuzaGram (Telegram-compatible)."""
    if not BOT_TOKEN:
        raise BotAPIError(method, "BOT_TOKEN is not set")

    url = f"{API_BASE}/bot{BOT_TOKEN}/{method}"
    body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            data = json.loads(raw.decode("utf-8"))
            description = data.get("description") or str(exc)
            code = data.get("error_code") or exc.code
        except Exception:
            description = str(exc)
            code = exc.code
        raise BotAPIError(method, description, code) from exc
    except urllib.error.URLError as exc:
        raise BotAPIError(method, f"network error: {exc.reason}") from exc

    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise BotAPIError(method, "invalid JSON response") from exc

    if not data.get("ok"):
        raise BotAPIError(method, data.get("description", "unknown error"), data.get("error_code"))
    return data.get("result")


def can_use_webapp() -> bool:
    """Telegram only accepts Mini App buttons over HTTPS."""
    return WEBAPP_URL.lower().startswith("https://")


def webapp_keyboard() -> dict:
    return {
        "inline_keyboard": [[
            {"text": "⭐ Открыть KAZ", "web_app": {"url": WEBAPP_URL}}
        ]]
    }


def url_keyboard() -> dict:
    return {
        "inline_keyboard": [[
            {"text": "⭐ Открыть KAZ", "url": WEBAPP_URL}
        ]]
    }


def open_keyboard(chat_type: str = "private") -> dict:
    # Inline web_app buttons are supported in private chats. In groups (and
    # without HTTPS) use a normal URL button so /start still works.
    if chat_type == "private" and can_use_webapp():
        return webapp_keyboard()
    return url_keyboard()


def send_message(chat_id: int, text: str, keyboard: dict | None = None) -> None:
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if keyboard:
        payload["reply_markup"] = keyboard
    try:
        api("sendMessage", payload)
    except BotAPIError as exc:
        # If web_app buttons are not supported by the current API build,
        # fall back to a normal URL button instead of losing the message.
        if keyboard and "web_app" in json.dumps(keyboard):
            payload["reply_markup"] = url_keyboard()
            api("sendMessage", payload)
        else:
            raise exc


WELCOME = (
    "<b>KAZ</b> — казино на виртуальные звёзды.\n\n"
    "На старте — <b>50 ★</b>, ежедневный бонус — <b>10 ★</b>.\n"
    "Слоты, блэкджек, рулетка, мины, краш и апгрейд.\n\n"
)

HELP = (
    "<b>Команды</b>\n"
    "/start — открыть казино\n"
    "/play — кнопка запуска Mini App\n"
    "/stars — как работают звёзды\n"
    "/id — ваш Telegram ID (для связи с администратором)\n"
    "/help — эта справка\n\n"
    "Прогресс хранится локально в вашем браузере."
)

STARS = (
    "<b>Виртуальные звёзды</b>\n\n"
    "★ — внутренняя валюта KAZ. Это не Telegram Stars и не платёжное средство.\n"
    "Вывод оформляется заявкой: укажите сумму в приложении — бот сам "
    "определит ваш профиль, а заявка уйдёт администратору.\n"
    "Баланс и история сохраняются в localStorage вашего браузера."
)


def handle_web_app_data(message: dict, chat_id: int) -> None:
    payload = message.get("web_app_data") or {}
    raw = payload.get("data") if isinstance(payload, dict) else ""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096:
        send_message(chat_id, "Не удалось прочитать заявку. Откройте приложение и попробуйте ещё раз.")
        return

    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        send_message(chat_id, "Не удалось прочитать заявку. Откройте приложение и попробуйте ещё раз.")
        return

    if not isinstance(data, dict) or data.get("type") != "withdraw":
        return

    try:
        amount = int(data.get("amount"))
    except (TypeError, ValueError):
        amount = 0
    contact = str(data.get("contact") or "").strip()[:80]
    request_id = str(data.get("id") or "—").strip()[:60]
    if amount <= 0:
        send_message(chat_id, "Заявка не создана: проверьте сумму.")
        return

    user = message.get("from") or {}
    user_id = user.get("id", "—")
    username = user.get("username")
    full_name = " ".join(
        part for part in (user.get("first_name"), user.get("last_name")) if part
    ).strip()
    player = f"@{username}" if username else full_name or "без имени"
    if not contact:
        contact = player

    if not ADMIN_IDS:
        log("[bot] withdraw: ADMIN_ID/ADMIN_IDS не заданы — заявка не отправлена администраторам")
        send_message(
            chat_id,
            f"Заявка на <b>{amount} ★</b> создана, но администраторы ещё не подключены. "
            "Свяжитесь с ними напрямую и передайте номер заявки.",
        )
        return

    admin_text = (
        "<b>💸 Заявка на вывод</b>\n\n"
        f"Сумма: <b>{amount} ★</b>\n"
        f"Контакт: {html.escape(contact)}\n"
        f"Игрок: {html.escape(player)} (ID <code>{html.escape(str(user_id))}</code>)\n"
        f"Заявка: <code>{html.escape(request_id)}</code>\n"
        f"Время: {time.strftime('%d.%m.%Y %H:%M')}"
    )
    player_id = str(user_id) if str(user_id).lstrip("-").isdigit() else ""
    withdraw_callback = f"withdraw:paid:{player_id}" if player_id else "withdraw:paid"
    reject_callback = f"withdraw:reject:{player_id}" if player_id else "withdraw:reject"

    delivered = 0
    for admin_id in ADMIN_IDS:
        admin_chat = int(admin_id) if admin_id.lstrip("-").isdigit() else admin_id
        try:
            api("sendMessage", {
                "chat_id": admin_chat,
                "text": admin_text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
                "reply_markup": {
                    "inline_keyboard": [[
                        {"text": "✅ Выплачено", "callback_data": withdraw_callback},
                        {"text": "❌ Отклонить", "callback_data": reject_callback},
                    ]]
                },
            })
            delivered += 1
        except BotAPIError as exc:
            log(f"[bot] withdraw: админ {admin_id}: {exc.description}")

    if not delivered:
        send_message(
            chat_id,
            "Заявка создана, но отправить её администраторам сейчас не удалось. "
            "Попробуйте позже или свяжитесь с администратором напрямую.",
        )
        return

    send_message(
        chat_id,
        f"Заявка на <b>{amount} ★</b> отправлена администраторам ({delivered}). "
        f"Номер: <code>{html.escape(request_id)}</code>.",
    )


def handle_callback_query(callback: dict) -> None:
    callback_id = callback.get("id")
    if not callback_id:
        return

    user = callback.get("from") or {}
    user_id = str(user.get("id", ""))
    if user_id not in ADMIN_IDS:
        try:
            api("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Недостаточно прав.",
                "show_alert": True,
            })
        except BotAPIError as exc:
            log(f"[bot] callback: {exc.description}")
        return

    raw_action = callback.get("data") or ""
    parts = raw_action.split(":")
    if len(parts) < 2 or parts[0] != "withdraw" or parts[1] not in ("paid", "reject"):
        try:
            api("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Неизвестное действие.",
            })
        except BotAPIError as exc:
            log(f"[bot] callback: {exc.description}")
        return

    action = parts[1]
    player_id = parts[2] if len(parts) >= 3 else ""

    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    message_id = message.get("message_id")
    if not chat_id or not message_id:
        try:
            api("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Сообщение с заявкой не найдено.",
                "show_alert": True,
            })
        except BotAPIError as exc:
            log(f"[bot] callback: {exc.description}")
        return

    original = message.get("text") or "Заявка на вывод"
    if "✅ Выплачено" in original or "❌ Отклонено" in original:
        try:
            api("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Заявка уже обработана.",
            })
        except BotAPIError as exc:
            log(f"[bot] callback: {exc.description}")
        return

    username = user.get("username")
    full_name = " ".join(
        part for part in (user.get("first_name"), user.get("last_name")) if part
    ).strip()
    admin = f"@{username}" if username else full_name or f"ID {user_id}"
    status = "✅ Выплачено" if action == "paid" else "❌ Отклонено"
    updated = f"{original}\n\n<b>{status}</b>\nОбработал: {html.escape(admin)}"

    try:
        api("editMessageText", {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": updated,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": []},
        })
    except BotAPIError as exc:
        log(f"[bot] callback edit: {exc.description}")
        try:
            api("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Не удалось обновить заявку.",
                "show_alert": True,
            })
        except BotAPIError as answer_exc:
            log(f"[bot] callback: {answer_exc.description}")
        return

    try:
        api("answerCallbackQuery", {
            "callback_query_id": callback_id,
            "text": f"Заявка: {status}",
        })
    except BotAPIError as exc:
        log(f"[bot] callback: {exc.description}")

    if player_id.lstrip("-").isdigit() and player_id != user_id:
        try:
            send_message(
                int(player_id),
                f"Ваша заявка на вывод: <b>{status}</b>.\n"
                "Администратор обработал заявку.",
            )
        except BotAPIError as exc:
            log(f"[bot] callback notify {player_id}: {exc.description}")


def handle_update(update: dict) -> None:
    callback = update.get("callback_query")
    if callback:
        handle_callback_query(callback)
        return

    message = update.get("message")
    if not message:
        return

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not chat_id:
        return

    if message.get("web_app_data"):
        handle_web_app_data(message, chat_id)
        return

    text = (message.get("text") or "").strip()
    if not text.startswith("/"):
        return

    command = text.split()[0].split("@", 1)[0].lower()
    chat_type = chat.get("type", "private")
    if command in ("/start", "/play"):
        send_message(chat_id, WELCOME, open_keyboard(chat_type))
    elif command == "/stars":
        send_message(chat_id, STARS)
    elif command == "/id":
        user = message.get("from") or {}
        user_id = html.escape(str(user.get("id", "—")))
        send_message(
            chat_id,
            f"Ваш Telegram ID: <code>{user_id}</code>\n\n"
            "Чтобы получать заявки на вывод, добавьте в <code>.env</code>:\n"
            f"<code>ADMIN_IDS={user_id}</code>\n"
            "Несколько ID — через запятую. После этого перезапустите <code>bot.py</code>.",
        )
    elif command == "/help":
        send_message(chat_id, HELP)
    else:
        send_message(chat_id, "Неизвестная команда.\n\n" + HELP)


def configure_bot() -> str:
    me = api("getMe")
    username = me.get("username", "bot")

    # Long polling and a webhook cannot be active at the same time.
    try:
        api("deleteWebhook", {"drop_pending_updates": False})
        log("[bot] webhook удалён, включён long polling")
    except BotAPIError as exc:
        log(f"[bot] deleteWebhook: {exc.description}")

    try:
        api("setMyCommands", {
            "commands": [
                {"command": "start", "description": "Открыть KAZ"},
                {"command": "play", "description": "Запустить Mini App"},
                {"command": "stars", "description": "О виртуальных звёздах"},
                {"command": "id", "description": "Мой Telegram ID"},
                {"command": "help", "description": "Справка"},
            ]
        })
    except BotAPIError as exc:
        log(f"[bot] setMyCommands: {exc.description}")

    menu_ready = False
    if can_use_webapp():
        try:
            api("setChatMenuButton", {
                "menu_button": {
                    "type": "web_app",
                    "text": "KAZ",
                    "web_app": {"url": WEBAPP_URL},
                }
            })
            menu_ready = True
            log("[bot] кнопка меню: Mini App")
        except BotAPIError as exc:
            log(f"[bot] menu button web_app: {exc.description}")

    if not menu_ready:
        try:
            api("setChatMenuButton", {"menu_button": {"type": "commands"}})
            log("[bot] кнопка меню: команды")
        except BotAPIError as exc:
            log(f"[bot] menu button commands: {exc.description}")

    return username


def poll_updates() -> None:
    offset = 0
    log("[bot] long polling started")
    while True:
        try:
            updates = api(
                "getUpdates",
                {"offset": offset, "timeout": 25, "allowed_updates": ["message", "callback_query"]},
                timeout=40.0,
            )
        except BotAPIError as exc:
            log(f"[bot] getUpdates: {exc.description}; retry in 3s")
            time.sleep(3)
            continue
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001 - keep the bot alive
            log(f"[bot] unexpected error: {exc}; retry in 3s")
            time.sleep(3)
            continue

        for update in updates or []:
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                offset = max(offset, update_id + 1)
            try:
                handle_update(update)
            except BotAPIError as exc:
                log(f"[bot] update error: {exc.description}")
            except Exception as exc:  # noqa: BLE001
                log(f"[bot] update error: {exc}")

        if not updates:
            time.sleep(0.25)


class StaticHandler(BaseHTTPRequestHandler):
    server_version = "KAZStatic/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def resolve(self) -> Path | None:
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path in ("", "/"):
            path = "/index.html"
        if "\x00" in path or "\\" in path:
            return None

        relative = Path(path.lstrip("/"))
        if any(part in ("..", "") for part in relative.parts):
            return None
        if any(part.startswith(".") for part in relative.parts):
            return None

        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            return None
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file() or target.suffix.lower() not in ALLOWED_SUFFIXES:
            return None
        return target

    def do_HEAD(self) -> None:  # noqa: N802
        self.respond(send_body=False)

    def do_GET(self) -> None:  # noqa: N802
        self.respond(send_body=True)

    def respond(self, send_body: bool) -> None:
        target = self.resolve()
        if target is None:
            body = b"Not found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if send_body:
                try:
                    self.wfile.write(body)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    self.close_connection = True
            return

        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(500)
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix.lower() in (".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".svg"):
            content_type += "; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if send_body:
            try:
                self.wfile.write(body)
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve() -> Server:
    try:
        server = Server((HOST, PORT), StaticHandler)
    except OSError as exc:
        log(f"[web] не удалось занять {HOST}:{PORT}: {exc}")
        raise SystemExit(1) from exc

    thread = threading.Thread(target=server.serve_forever, name="kaz-web", daemon=True)
    thread.start()
    display_host = "127.0.0.1" if HOST in ("0.0.0.0", "::", "") else HOST
    log(f"[web] http://{display_host}:{PORT}/")
    log(f"[web] WebApp URL: {WEBAPP_URL}")
    if not can_use_webapp():
        log("[web] ВНИМАНИЕ: Telegram открывает Mini App только по HTTPS.")
        log("      Для теста: cloudflared tunnel --url http://127.0.0.1:%d" % PORT)
    return server


def main() -> int:
    server = serve()

    if not BOT_TOKEN:
        log("\n[bot] BOT_TOKEN не задан — работает только веб-сервер.")
        log("      Создайте .env с BOT_TOKEN и WEBAPP_URL или задайте переменные окружения.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()
        return 0

    log(f"[bot] API: {API_BASE}")
    if not can_use_webapp():
        log("[bot] ВНИМАНИЕ: WEBAPP_URL не HTTPS — /start отправит обычную ссылку.")
    try:
        username = configure_bot()
        log(f"[bot] @{username} готов")
        poll_updates()
    except KeyboardInterrupt:
        log("\n[bot] остановлен")
    except BotAPIError as exc:
        log(f"[bot] ошибка: {exc.description}")
        return 1
    finally:
        server.shutdown()
        server.server_close()
    return 0


def _stop(signum, frame) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    for _sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(_sig, _stop)
        except (AttributeError, OSError, ValueError):
            pass
    sys.exit(main())
