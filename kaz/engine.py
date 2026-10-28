"""Request dispatcher for the KAZ game API (used by api/game.py)."""

from __future__ import annotations

import html
import time

import payments

from . import games, store
from .store import GameError

CRASH_ACTIONS = {"crash.poll", "crash.cashout"}


def run(user_id: int, action: str, params: dict, contact: str = "") -> dict:
    """Execute one action for one player and return result + public state."""
    if action != "state" and action not in games.HANDLERS:
        raise GameError("unknown_action", "Неизвестное действие.")

    credited = 0
    if action == "state":
        try:
            credited = store.sync_purchases(user_id)
        except payments.PaymentStorageError as exc:
            # The state itself must still load; purchases are retried next time.
            print(f"[engine] purchase sync: {exc}", flush=True)

    def apply(doc: dict) -> tuple[dict, bool]:
        stamp = store.now_ms()
        changed = False
        if action not in CRASH_ACTIONS:
            changed = games.settle_expired(doc, stamp)
        if action == "state":
            return {"credited": credited}, changed
        ctx = {"now": stamp, "contact": contact}
        return games.run_action(doc, action, params, ctx), True

    result, doc = store.transact(user_id, apply)
    return {"ok": True, "result": result, "state": store.public_state(doc)}


def notify_withdrawal(user_id: int, item: dict) -> bool:
    """Send a new withdrawal request to the admins. Returns True if delivered."""
    import bot  # local import: bot imports this package for admin decisions

    if not bot.ADMIN_IDS:
        print("[engine] withdraw: ADMIN_IDS is empty, nobody was notified", flush=True)
        return False

    text = (
        "<b>💸 Заявка на вывод</b>\n\n"
        f"Сумма: <b>{item['amount']} ★</b>\n"
        f"Контакт: {html.escape(item['contact'])}\n"
        f'ShuzaGram ID: <code>{user_id}</code> · '
        f'<a href="sg://user?id={user_id}">открыть профиль</a>\n'
        f"Заявка: <code>{html.escape(item['id'])}</code>\n"
        f"Время: {time.strftime('%d.%m.%Y %H:%M', time.gmtime(item['at'] / 1000 + 3 * 3600))} МСК\n"
        "Звёзды списаны с баланса игрока и зарезервированы."
    )
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ Выплачено", "callback_data": f"withdraw:paid:{user_id}:{item['id']}"},
            {"text": "❌ Отклонить", "callback_data": f"withdraw:reject:{user_id}:{item['id']}"},
        ]]
    }
    delivered = 0
    for admin_id in bot.ADMIN_IDS:
        chat = int(admin_id) if admin_id.lstrip("-").isdigit() else admin_id
        try:
            bot.api("sendMessage", {
                "chat_id": chat,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
                "reply_markup": keyboard,
            })
            delivered += 1
        except bot.BotAPIError as exc:
            print(f"[engine] withdraw notify {admin_id}: {exc.description}", flush=True)
    return delivered > 0
