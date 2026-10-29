"""
Админ-панель для бота KAZ: изменение (пополнение / списание) и проверка баланса.

Подключается к bot.py тремя небольшими вставками (см. инструкцию).
Доступна только пользователям из ADMIN_IDS и только в личном чате с ботом.

Команды:
    /admin                  — панель с кнопками
    /give <id|@username|me> <сумма> — пополнить баланс
    /take <id|@username|me> <сумма> — списать с баланса
    /balance [id|@username|me]      — показать баланс
    /id <@username|id>      — найти игрока по юзернейму или ID
    /stats                  — статистика по игрокам, пополнениям и выводам
    /cancel                 — отменить текущий ввод

Каждое изменение требует подтверждения кнопкой, пишется в лог,
об изменении уведомляются остальные админы и сам игрок.
"""
from __future__ import annotations

import html
import json
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

import payments
from kaz import store as kaz_store

CONFIRM_TTL = 300          # секунд на подтверждение операции
NOTIFY_PLAYER = True       # сообщать игроку об изменении баланса
NOTIFY_OTHER_ADMINS = True # сообщать остальным админам

_api = None
_send = None
_log = None
_api_error = Exception
_admins: set[str] = set()

_pending: dict[int, dict] = {}   # admin_id -> ожидаемый ввод
_ops: dict[str, dict] = {}       # token -> операция, ждущая подтверждения


# --------------------------------------------------------------------------
# Подключение к bot.py
# --------------------------------------------------------------------------
def setup(*, api, send_message, log, api_error, admin_ids) -> None:
    global _api, _send, _log, _api_error, _admins
    _api = api
    _send = send_message
    _log = log
    _api_error = api_error
    _admins = {str(a).strip() for a in admin_ids if str(a).strip()}
    _log(f"[admin] панель включена, админов: {len(_admins)}")


def is_admin(user_id) -> bool:
    return str(user_id) in _admins


# --------------------------------------------------------------------------
# Утилиты
# --------------------------------------------------------------------------
def _fmt(n: int) -> str:
    return f"{int(n):,}".replace(",", " ")


def _parse_amount(text: str) -> int | None:
    cleaned = (
        str(text).strip()
        .replace(" ", "").replace("\u00a0", "").replace("_", "").replace(",", "")
    )
    try:
        return int(cleaned)
    except ValueError:
        return None


_USERNAME_RE = re.compile(r"^[a-z0-9_]{3,32}$")
_USER_INDEX_TTL = 15
_user_index_cache: dict = {"at": 0.0, "map": {}}


def _normalize_username(value) -> str:
    return str(value or "").strip().lstrip("@").lower()


def _find_uid(username: str) -> int | None:
    name = _normalize_username(username)
    if not name:
        return None
    try:
        return _username_index().get(name)
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] username lookup {name}: {exc}")
        return None


def _username_index(force: bool = False) -> dict[str, int]:
    """username -> uid for players whose profile has a saved username."""
    now = time.time()
    cached = _user_index_cache.get("map") or {}
    if not force and cached and now - _user_index_cache.get("at", 0.0) < _USER_INDEX_TTL:
        return cached
    docs, _found, _failed = _load_docs()
    mapping: dict[str, int] = {}
    for uid, doc in docs.items():
        name = _normalize_username(doc.get("username"))
        if name:
            mapping[name] = int(uid)
    _user_index_cache.update(at=now, map=mapping)
    return mapping


def _read_player(uid: int) -> dict | None:
    """Read one player without creating a fresh profile for an unknown ID."""
    blob = payments._blob()
    revisions = kaz_store._list_revisions(blob, uid)
    if not revisions:
        return None
    _rev, doc = kaz_store._read(blob, uid, revisions)
    return doc


def _parse_uid(text: str, admin_id: int) -> int | None:
    value = str(text).strip().lower()
    if value in ("me", "я", "себе"):
        return int(admin_id)
    if value.isdigit():
        return int(value)
    name = _normalize_username(value)
    if name and _USERNAME_RE.match(name):
        return _find_uid(name)
    return None


def _answer(callback_id, text: str = "", alert: bool = False) -> None:
    payload = {"callback_query_id": callback_id}
    if text:
        payload["text"] = text
    if alert:
        payload["show_alert"] = True
    try:
        _api("answerCallbackQuery", payload)
    except _api_error as exc:
        _log(f"[admin] answerCallbackQuery: {exc.description}")


def _edit(chat_id, message_id, text: str, keyboard: dict | None = None) -> None:
    try:
        _api("editMessageText", {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "reply_markup": keyboard or {"inline_keyboard": []},
        })
    except _api_error as exc:
        _log(f"[admin] editMessageText: {exc.description}")


def _cleanup() -> None:
    now = time.time()
    for token in [t for t, op in _ops.items() if op["expires"] < now]:
        _ops.pop(token, None)


def _read_balance(uid: int) -> int:
    return int(kaz_store.read_doc(uid).get("balance", 0))


def _apply(uid: int, delta: int) -> tuple[int, int]:
    def change(doc):
        old = int(doc.get("balance", 0))
        doc["balance"] = max(0, min(kaz_store.MAX_BALANCE, old + delta))
        return (old, doc["balance"]), True

    (old, new), _doc = kaz_store.transact(uid, change)
    return int(old), int(new)


# --------------------------------------------------------------------------
# Интерфейс
# --------------------------------------------------------------------------
PANEL_TEXT = (
    "<b>🛠 Админ-панель KAZ</b>\n\n"
    "Выберите действие или используйте команды:\n"
    "<code>/give 123456789 500000</code> — пополнить\n"
    "<code>/give @username 500</code> — пополнить по юзернейму\n"
    "<code>/take 123456789 1000</code> — списать\n"
    "<code>/balance @username</code> — баланс игрока\n"
    "<code>/id @username</code> — узнать ID по юзернейму\n"
    "<code>/stats</code> — статистика\n"
    "Вместо ID можно написать <code>me</code> — это вы."
)


def _menu_kb() -> dict:
    return {"inline_keyboard": [
        [{"text": "💰 Изменить баланс", "callback_data": "adm:adj"}],
        [
            {"text": "🔎 Проверить баланс", "callback_data": "adm:chk"},
            {"text": "👤 Себе", "callback_data": "adm:self"},
        ],
        [{"text": "📊 Статистика", "callback_data": "adm:stats"}],
    ]}


def _confirm_kb(token: str) -> dict:
    return {"inline_keyboard": [[
        {"text": "✅ Подтвердить", "callback_data": f"adm:ok:{token}"},
        {"text": "✖ Отмена", "callback_data": f"adm:no:{token}"},
    ]]}


def _send_panel(chat_id: int) -> None:
    _send(chat_id, PANEL_TEXT, _menu_kb())


def _show_balance(chat_id: int, uid: int) -> None:
    try:
        balance = _read_balance(uid)
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] read balance uid={uid}: {exc}")
        _send(chat_id, "Не удалось прочитать баланс: хранилище недоступно.")
        return
    _send(chat_id, f"Игрок <code>{uid}</code>\nБаланс: <b>{_fmt(balance)} ★</b>", _menu_kb())


def _show_username_lookup(chat_id: int, query: str) -> None:
    value = str(query or "").strip()
    if not value:
        _send(chat_id, "Формат: <code>/id @username</code> или <code>/id 123456789</code>.", _menu_kb())
        return

    if value.isdigit():
        uid = int(value)
        try:
            doc = _read_player(uid)
        except Exception as exc:  # noqa: BLE001
            _log(f"[admin] read uid={uid}: {exc}")
            _send(chat_id, "Не удалось прочитать профиль: хранилище недоступно.", _menu_kb())
            return
        if doc is None:
            _send(chat_id, f"Игрок с ID <code>{uid}</code> не найден.", _menu_kb())
            return
        name = _normalize_username(doc.get("username"))
        balance = _int(doc.get("balance"))
        if name:
            _send(
                chat_id,
                f"ID <code>{uid}</code> → @{html.escape(name)}\n"
                f"Баланс: <b>{_fmt(balance)} ★</b>",
                _menu_kb(),
            )
        else:
            _send(
                chat_id,
                f"ID <code>{uid}</code>\n"
                "Юзернейм не сохранён — игрок ещё не открывал приложение.\n"
                f"Баланс: <b>{_fmt(balance)} ★</b>",
                _menu_kb(),
            )
        return

    name = _normalize_username(value)
    if not _USERNAME_RE.match(name):
        _send(chat_id, "Укажите @username или числовой ID.", _menu_kb())
        return
    uid = _find_uid(name)
    if uid is None:
        _send(
            chat_id,
            f"@{html.escape(name)} не найден.\n\n"
            "Бот знает только игроков, которые открывали приложение. "
            "Попросите их открыть KAZ или написать /start, затем повторите.",
            _menu_kb(),
        )
        return
    try:
        balance = _read_balance(uid)
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] read balance uid={uid}: {exc}")
        balance = 0
    _send(
        chat_id,
        f"@{html.escape(name)} → <code>{uid}</code>\n"
        f"Баланс: <b>{_fmt(balance)} ★</b>",
        _menu_kb(),
    )


def _start_confirm(admin_id: int, chat_id: int, uid: int, delta: int) -> None:
    if delta == 0:
        _send(chat_id, "Сумма не должна быть нулевой.")
        return
    try:
        current = _read_balance(uid)
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] read balance uid={uid}: {exc}")
        _send(chat_id, "Не удалось прочитать баланс: хранилище недоступно.")
        return

    expected = max(0, min(kaz_store.MAX_BALANCE, current + delta))
    notes = []
    if delta > 0 and current + delta > kaz_store.MAX_BALANCE:
        notes.append(f"Достигнут лимит баланса: {_fmt(kaz_store.MAX_BALANCE)} ★.")
    if delta < 0 and current + delta < 0:
        notes.append("Баланс не может быть меньше 0 — спишется только остаток.")

    _cleanup()
    token = secrets.token_hex(6)
    _ops[token] = {
        "admin": admin_id,
        "uid": uid,
        "delta": delta,
        "expires": time.time() + CONFIRM_TTL,
    }
    action = "Пополнение" if delta > 0 else "Списание"
    text = (
        "<b>Подтвердите операцию</b>\n\n"
        f"Игрок: <code>{uid}</code>\n"
        f"{action}: <b>{_fmt(abs(delta))} ★</b>\n"
        f"Баланс: {_fmt(current)} ★ → <b>{_fmt(expected)} ★</b>"
    )
    if notes:
        text += "\n\n⚠️ " + "\n⚠️ ".join(notes)
    _send(chat_id, text, _confirm_kb(token))


def _execute(token: str, admin_id: int, chat_id, message_id, callback_id) -> None:
    _cleanup()
    op = _ops.get(token)
    if op and op["admin"] != admin_id:
        _answer(callback_id, "Эту операцию создал другой админ.", alert=True)
        return
    if not op:
        _answer(callback_id, "Операция устарела. Создайте новую.", alert=True)
        _edit(chat_id, message_id, "Операция устарела или уже выполнена.")
        return
    _ops.pop(token, None)

    uid, delta = op["uid"], op["delta"]
    try:
        old, new = _apply(uid, delta)
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] FAILED admin={admin_id} uid={uid} delta={delta:+}: {exc}")
        _answer(callback_id, "Ошибка записи. Баланс не изменён.", alert=True)
        _edit(chat_id, message_id, "Не удалось изменить баланс: хранилище недоступно. Повторите позже.")
        return

    _log(f"[admin] admin={admin_id} uid={uid} delta={delta:+} balance {old} -> {new}")
    _answer(callback_id, "Готово")
    sign = "+" if new >= old else "−"
    _edit(
        chat_id, message_id,
        "<b>✅ Готово</b>\n\n"
        f"Игрок: <code>{uid}</code>\n"
        f"Изменение: <b>{sign}{_fmt(abs(new - old))} ★</b>\n"
        f"Баланс: {_fmt(old)} ★ → <b>{_fmt(new)} ★</b>",
        _menu_kb(),
    )

    if NOTIFY_OTHER_ADMINS:
        for other in _admins:
            if other == str(admin_id) or not other.lstrip("-").isdigit():
                continue
            try:
                _send(
                    int(other),
                    f"ℹ️ Админ <code>{admin_id}</code> изменил баланс игрока "
                    f"<code>{uid}</code>: {_fmt(old)} → <b>{_fmt(new)} ★</b>",
                )
            except _api_error as exc:
                _log(f"[admin] notify admin {other}: {exc.description}")

    if NOTIFY_PLAYER and uid != admin_id and new != old:
        try:
            _send(
                uid,
                f"Баланс изменён администратором: <b>{sign}{_fmt(abs(new - old))} ★</b>.\n"
                f"Текущий баланс: <b>{_fmt(new)} ★</b>.",
            )
        except _api_error as exc:
            _log(f"[admin] notify player {uid}: {exc.description}")


# --------------------------------------------------------------------------
# Статистика
# --------------------------------------------------------------------------
STATS_TTL = 30          # секунд кэша, чтобы не перечитывать хранилище на каждый клик
READ_WORKERS = 8        # параллельное чтение профилей
MAX_PLAYERS_READ = 5000 # верхняя граница числа читаемых профилей
DAY_MS = 86_400_000

_PATH_RE = re.compile(r"^kaz/players/(-?\d+)/r(\d{10})\.json$")
_stats_cache: dict = {"at": 0.0, "text": ""}


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _list_latest(blob) -> dict[int, tuple[int, object]]:
    """uid -> (номер последней ревизии, blob) по всем игрокам."""
    prefix = f"{kaz_store.PLAYER_PREFIX}/"
    try:
        items = list(blob.query_blobs(prefix=prefix, page_size=1000))
    except Exception:  # noqa: BLE001 - на случай меньшего лимита страницы
        items = list(blob.query_blobs(prefix=prefix, page_size=100))
    latest: dict[int, tuple[int, object]] = {}
    for item in items:
        match = _PATH_RE.match(str(getattr(item, "pathname", "")))
        if not match:
            continue
        uid, rev = int(match.group(1)), int(match.group(2))
        if uid not in latest or rev > latest[uid][0]:
            latest[uid] = (rev, item)
    return latest


def _load_docs() -> tuple[dict[int, dict], int, int]:
    """Возвращает (профили, всего найдено, не удалось прочитать)."""
    blob = payments._blob()
    latest = _list_latest(blob)
    uids = sorted(latest)[:MAX_PLAYERS_READ]

    def load(uid: int):
        try:
            downloaded = blob.get_blob(latest[uid][1].url, access="private")
            doc = json.loads(downloaded.body.decode("utf-8"))
            return uid, doc if isinstance(doc, dict) else None
        except Exception:  # noqa: BLE001
            return uid, None

    docs: dict[int, dict] = {}
    failed = 0
    with ThreadPoolExecutor(max_workers=READ_WORKERS) as pool:
        for uid, doc in pool.map(load, uids):
            if doc is None:
                failed += 1
            else:
                docs[uid] = doc
    return docs, len(latest), failed


def _build_stats_text(docs: dict[int, dict], found: int, failed: int) -> str:
    now = kaz_store.now_ms()
    day, week = now - DAY_MS, now - 7 * DAY_MS

    created = [_int(d.get("created")) for d in docs.values()]
    updated = [_int(d.get("updated")) for d in docs.values()]
    new_24h = sum(1 for c in created if c >= day)
    new_7d = sum(1 for c in created if c >= week)
    active_24h = sum(1 for u in updated if u >= day)

    # Балансы считаем без админов, иначе админские начисления искажают картину.
    real = {u: d for u, d in docs.items() if str(u) not in _admins}
    total_balance = sum(_int(d.get("balance")) for d in real.values())
    top = sorted(real.items(), key=lambda kv: _int(kv[1].get("balance")), reverse=True)[:10]
    games = sum(_int(d.get("games")) for d in real.values())
    wagered = sum(_int(d.get("wagered")) for d in real.values())
    biggest = max((_int(d.get("biggestWin")) for d in real.values()), default=0)

    # Пополнения
    buckets = {"24h": [0, 0], "7d": [0, 0], "all": [0, 0]}  # [кол-во, сумма]
    payers = set()
    for uid, doc in docs.items():
        for purchase in doc.get("purchases") or []:
            amount, at = _int(purchase.get("amount")), _int(purchase.get("at"))
            payers.add(uid)
            buckets["all"][0] += 1
            buckets["all"][1] += amount
            if at >= week:
                buckets["7d"][0] += 1
                buckets["7d"][1] += amount
            if at >= day:
                buckets["24h"][0] += 1
                buckets["24h"][1] += amount

    # Выводы
    wd = {"pending": [0, 0], "paid": [0, 0], "rejected": [0, 0]}
    for doc in docs.values():
        for item in doc.get("withdrawals") or []:
            status = str(item.get("status") or "")
            if status in wd:
                wd[status][0] += 1
                wd[status][1] += _int(item.get("amount"))

    lines = [
        "<b>📊 Статистика KAZ</b>",
        "",
        "<b>Игроки</b>",
        f"Всего: <b>{_fmt(len(docs))}</b> · новых за 24 ч: {_fmt(new_24h)} · за 7 дн.: {_fmt(new_7d)}",
        f"Были изменения профиля за 24 ч: {_fmt(active_24h)}",
        "",
        "<b>Игра (без админов)</b>",
        f"Сумма балансов: <b>{_fmt(total_balance)} ★</b>",
        f"Игр: {_fmt(games)} · ставок на {_fmt(wagered)} ★ · макс. выигрыш {_fmt(biggest)} ★",
        "",
        "<b>Пополнения</b>",
        f"За 24 ч: {_fmt(buckets['24h'][0])} шт. · <b>{_fmt(buckets['24h'][1])} ★</b>",
        f"За 7 дн.: {_fmt(buckets['7d'][0])} шт. · <b>{_fmt(buckets['7d'][1])} ★</b>",
        f"Всего: {_fmt(buckets['all'][0])} шт. · <b>{_fmt(buckets['all'][1])} ★</b> · платящих: {_fmt(len(payers))}",
        "",
        "<b>Заявки на вывод</b>",
        f"Ожидают: <b>{_fmt(wd['pending'][0])}</b> на {_fmt(wd['pending'][1])} ★",
        f"Выплачено: {_fmt(wd['paid'][0])} на {_fmt(wd['paid'][1])} ★",
        f"Отклонено: {_fmt(wd['rejected'][0])} на {_fmt(wd['rejected'][1])} ★",
    ]
    if top:
        lines += ["", "<b>Топ-10 по балансу</b>"]
        for place, (uid, doc) in enumerate(top, 1):
            lines.append(f"{place}. <code>{uid}</code> — {_fmt(_int(doc.get('balance')))} ★")

    notes = []
    if found > len(docs) + failed:
        notes.append(f"прочитано {_fmt(len(docs))} из {_fmt(found)} профилей (лимит {_fmt(MAX_PLAYERS_READ)})")
    if failed:
        notes.append(f"не удалось прочитать профилей: {failed}")
    notes.append("в профиле хранится не более 100 пополнений и 20 заявок на игрока — у активных игроков итоги могут быть занижены")
    lines += ["", "<i>" + "; ".join(notes) + ".</i>", f"<i>Обновлено: {time.strftime('%H:%M:%S')}</i>"]
    return "\n".join(lines)


def _stats_text() -> str:
    if _stats_cache["text"] and time.time() - _stats_cache["at"] < STATS_TTL:
        return _stats_cache["text"]
    docs, found, failed = _load_docs()
    text = _build_stats_text(docs, found, failed)
    _stats_cache.update(at=time.time(), text=text)
    return text


def _send_stats(chat_id: int) -> None:
    try:
        text = _stats_text()
    except Exception as exc:  # noqa: BLE001
        _log(f"[admin] stats: {exc}")
        _send(chat_id, "Не удалось собрать статистику: хранилище недоступно.", _menu_kb())
        return
    _send(chat_id, text, {"inline_keyboard": [[
        {"text": "🔄 Обновить", "callback_data": "adm:stats"},
        {"text": "⬅ Панель", "callback_data": "adm:menu"},
    ]]})


# --------------------------------------------------------------------------
# Обработчики для handle_update
# --------------------------------------------------------------------------
def handle_message(message: dict) -> bool:
    """Возвращает True, если сообщение обработано админ-панелью."""
    user = message.get("from") or {}
    admin_id = user.get("id")
    if not admin_id or not is_admin(admin_id):
        return False
    chat = message.get("chat") or {}
    if chat.get("type", "private") != "private":
        return False
    chat_id = chat.get("id")
    text = (message.get("text") or "").strip()
    if not chat_id or not text:
        return False
    admin_id = int(admin_id)

    if text.startswith("/"):
        parts = text.split()
        command = parts[0].split("@", 1)[0].lower()
        args = parts[1:]
        if command not in ("/admin", "/give", "/take", "/balance", "/cancel", "/stats", "/id"):
            return False
        _pending.pop(admin_id, None)

        if command == "/cancel":
            _send(chat_id, "Отменено.", _menu_kb())
        elif command == "/admin":
            _send_panel(chat_id)
        elif command == "/stats":
            _send_stats(chat_id)
        elif command == "/id":
            if not args:
                # Let bot.py show the admin's own ID.
                return False
            _show_username_lookup(chat_id, args[0])
        elif command == "/balance":
            uid = _parse_uid(args[0], admin_id) if args else admin_id
            if uid is None:
                _send(chat_id, "Укажите ID числом, <code>@username</code> или <code>me</code>.")
            else:
                _show_balance(chat_id, uid)
        else:  # /give, /take
            if len(args) != 2:
                _send(chat_id, f"Формат: <code>{command} 123456789 500000</code> или <code>{command} @username 500</code>")
                return True
            uid = _parse_uid(args[0], admin_id)
            amount = _parse_amount(args[1])
            if uid is None or amount is None or amount == 0:
                _send(chat_id, f"Формат: <code>{command} 123456789 500000</code> или <code>{command} @username 500</code>")
                return True
            delta = abs(amount) if command == "/give" else -abs(amount)
            _start_confirm(admin_id, chat_id, uid, delta)
        return True

    pending = _pending.get(admin_id)
    if not pending:
        return False

    if pending["step"] == "uid":
        uid = _parse_uid(text, admin_id)
        if uid is None:
            _send(chat_id, "Нужен числовой ID, <code>@username</code> или <code>me</code>. Для выхода — /cancel.")
            return True
        if pending["mode"] == "chk":
            _pending.pop(admin_id, None)
            _show_balance(chat_id, uid)
        else:
            _pending[admin_id] = {"step": "amount", "uid": uid}
            _send(
                chat_id,
                f"Игрок <code>{uid}</code>. Введите сумму:\n"
                "<code>500000</code> — пополнить, <code>-200000</code> — списать.",
            )
        return True

    if pending["step"] == "amount":
        amount = _parse_amount(text)
        if amount is None or amount == 0:
            _send(chat_id, "Нужно ненулевое число, например <code>500000</code> или <code>-200000</code>.")
            return True
        uid = pending["uid"]
        _pending.pop(admin_id, None)
        _start_confirm(admin_id, chat_id, uid, amount)
        return True

    return False


def handle_callback(callback: dict) -> bool:
    """Возвращает True, если callback принадлежит админ-панели."""
    data = str(callback.get("data") or "")
    if not data.startswith("adm:"):
        return False

    callback_id = callback.get("id")
    admin_id = (callback.get("from") or {}).get("id")
    if not admin_id or not is_admin(admin_id):
        _answer(callback_id, "Недостаточно прав.", alert=True)
        return True
    admin_id = int(admin_id)

    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    message_id = message.get("message_id")
    if not chat_id:
        _answer(callback_id, "Сообщение не найдено.", alert=True)
        return True

    parts = data.split(":")
    action = parts[1] if len(parts) > 1 else ""
    token = parts[2] if len(parts) > 2 else ""

    if action == "adj":
        _pending[admin_id] = {"step": "uid", "mode": "adj"}
        _answer(callback_id)
        _send(chat_id, "Отправьте ID игрока (или <code>me</code>). Отмена — /cancel.")
    elif action == "chk":
        _pending[admin_id] = {"step": "uid", "mode": "chk"}
        _answer(callback_id)
        _send(chat_id, "Отправьте ID игрока (или <code>me</code>). Отмена — /cancel.")
    elif action == "self":
        _pending[admin_id] = {"step": "amount", "uid": admin_id}
        _answer(callback_id)
        _send(
            chat_id,
            f"Ваш ID <code>{admin_id}</code>. Введите сумму:\n"
            "<code>500000</code> — пополнить, <code>-200000</code> — списать.",
        )
    elif action == "stats":
        _answer(callback_id)
        _send_stats(chat_id)
    elif action == "menu":
        _answer(callback_id)
        _send_panel(chat_id)
    elif action == "ok" and token:
        _execute(token, admin_id, chat_id, message_id, callback_id)
    elif action == "no" and token:
        _ops.pop(token, None)
        _answer(callback_id, "Отменено")
        _edit(chat_id, message_id, "Операция отменена.", _menu_kb())
    else:
        _answer(callback_id, "Неизвестное действие.")
    return True
