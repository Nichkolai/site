"""Request dispatcher for the KAZ game API (used by api/game.py)."""

from __future__ import annotations

import html
import re
import time

import payments

from . import games, store
from .store import GameError

CRASH_ACTIONS = {"crash.poll", "crash.cashout"}

# Largest stake of one round (sum of all roulette bets).
MAX_STAKE = 100_000
# At most RATE_MAX_ACTIONS state-changing actions per player in RATE_WINDOW_MS.
RATE_WINDOW_MS = 10_000
RATE_MAX_ACTIONS = 60
# Results of the last requests are kept so that a retried request (same
# ``reqId``) returns the first result instead of playing a second round.
SEEN_LIMIT = 8
UNTRACKED_ACTIONS = {"state", "crash.poll"}
_REQ_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _check_stake(params: dict) -> None:
    """Reject a stake above MAX_STAKE (bad values are left to the game)."""
    stake = 0
    try:
        stake = int(params.get("bet"))
    except (TypeError, ValueError):
        pass
    bets = params.get("bets")
    if isinstance(bets, dict):
        try:
            stake = max(stake, sum(int(value) for value in bets.values()))
        except (TypeError, ValueError):
            pass
    if stake > MAX_STAKE:
        raise GameError(
            "bet_limit",
            f"Максимальная ставка — {MAX_STAKE:,} ★.".replace(",", " "),
        )


def _check_rate(doc: dict, stamp: int) -> None:
    window = doc.get("rl")
    start = int(window.get("t", 0)) if isinstance(window, dict) else 0
    if not isinstance(window, dict) or stamp < start or stamp - start >= RATE_WINDOW_MS:
        window = {"t": stamp, "n": 0}
    if int(window.get("n", 0)) >= RATE_MAX_ACTIONS:
        raise GameError(
            "rate_limited",
            "Слишком много действий подряд. Подождите пару секунд.",
            429,
        )
    window["n"] = int(window.get("n", 0)) + 1
    doc["rl"] = window


def _seen_result(doc: dict, req_id: str) -> dict | None:
    for entry in doc.get("seen") or []:
        if isinstance(entry, list) and len(entry) == 2 and entry[0] == req_id:
            return entry[1]
    return None


def _username_from_contact(contact: str) -> str:
    """``@name`` from the Telegram profile, lowercased for lookups."""
    value = str(contact or "").strip()
    if value.startswith("@") and len(value) > 1:
        return value[1:].lower()
    return ""


def _remember_username(doc: dict, username: str) -> bool:
    if not username or doc.get("username") == username:
        return False
    doc["username"] = username
    return True


def run(user_id: int, action: str, params: dict, contact: str = "") -> dict:
    """Execute one action for one player and return result + public state."""
    if action != "state" and action not in games.HANDLERS:
        raise GameError("unknown_action", "Неизвестное действие.")

    params = dict(params)
    req_id = str(params.pop("reqId", "") or "")
    if req_id and not _REQ_ID.match(req_id):
        req_id = ""
    if action in UNTRACKED_ACTIONS:
        req_id = ""
    if action != "state":
        _check_stake(params)

    # The moment the request reached the server. For a cash-out this is fairer
    # than the time after the Blob read: a slow read must not turn a press that
    # happened before the crash into a loss.
    request_stamp = store.now_ms()
    credited = 0
    if action == "state":
        try:
            credited = store.sync_purchases(user_id)
        except payments.PaymentStorageError as exc:
            # The state itself must still load; purchases are retried next time.
            print(f"[engine] purchase sync: {exc}", flush=True)

    username = _username_from_contact(contact)
    flags = {"replayed": False}

    def apply(doc: dict) -> tuple[dict, bool]:
        flags["replayed"] = False
        stamp = store.now_ms()
        if action == "crash.poll":
            # A running poll only reads the round: writing a new revision on
            # every 150 ms would add latency and could make the client lose
            # the crash while Blob is busy. The crash itself is committed.
            result = games.run_action(doc, action, params, {"now": stamp, "contact": contact})
            changed = result.get("status") == "crashed"
            if changed:
                changed = _remember_username(doc, username) or changed
            return result, changed
        if req_id:
            previous = _seen_result(doc, req_id)
            if previous is not None:
                flags["replayed"] = True
                return previous, False
        changed = False
        if action != "state":
            _check_rate(doc, stamp)
            changed = True
        if action not in CRASH_ACTIONS:
            changed = games.settle_expired(doc, stamp) or changed
        if _remember_username(doc, username):
            changed = True
        if action == "state":
            return {"credited": credited}, changed
        now = request_stamp if action == "crash.cashout" else stamp
        ctx = {"now": now, "contact": contact}
        result = games.run_action(doc, action, params, ctx)
        if req_id:
            seen = doc.setdefault("seen", [])
            seen.insert(0, [req_id, result])
            del seen[SEEN_LIMIT:]
        return result, True

    result, doc = store.transact(user_id, apply)
    response = {"ok": True, "result": result, "state": store.public_state(doc)}
    if flags["replayed"]:
        response["replayed"] = True
    return response


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
