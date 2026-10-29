"""Server-side player state for KAZ.

Every player has an append-only chain of revisions in the private Vercel Blob
store: ``kaz/players/<user_id>/r0000000042.json``.  A write creates the *next*
revision with ``allow_overwrite=False``, so two concurrent requests can never
both succeed for the same revision: the loser re-reads and retries.  This acts
as an atomic compare-and-set (no double spending, no lost updates) and also
avoids CDN caching of overwritten blobs, because a revision is never rewritten.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from typing import Any, Callable

import payments
from payments import PaymentStorageError

PLAYER_PREFIX = "kaz/players"
START_BALANCE = 50
MAX_BALANCE = 1_000_000_000
MAX_HISTORY = 100
MAX_WITHDRAWALS = 20
MAX_PURCHASES = 100
MAX_CREDITED = 400
KEEP_REVISIONS = 4
MAX_ATTEMPTS = 12

_REV_RE = re.compile(r"/r(\d{10})\.json$")


class GameError(Exception):
    """A request the player can fix (bad bet, not enough stars, ...)."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class _Conflict(Exception):
    """Another request already wrote this revision."""


def now_ms() -> int:
    return int(time.time() * 1000)


def new_doc(user_id: int) -> dict:
    stamp = now_ms()
    return {
        "v": 1,
        "uid": int(user_id),
        "username": "",
        "balance": START_BALANCE,
        "games": 0,
        "wagered": 0,
        "biggestWin": 0,
        "history": [],
        "withdrawals": [],
        "purchases": [],
        "credited": [],
        "lastDaily": None,
        "active": {},
        "created": stamp,
        "updated": stamp,
    }


def _path(user_id: int, rev: int) -> str:
    return f"{PLAYER_PREFIX}/{int(user_id)}/r{rev:010d}.json"


def _list_revisions(blob: Any, user_id: int) -> list[tuple[int, Any]]:
    prefix = f"{PLAYER_PREFIX}/{int(user_id)}/"
    try:
        items = list(blob.query_blobs(prefix=prefix, page_size=100))
    except Exception as exc:  # noqa: BLE001
        raise PaymentStorageError(str(exc)) from exc
    revisions: list[tuple[int, Any]] = []
    for item in items:
        match = _REV_RE.search(str(getattr(item, "pathname", "")))
        if match:
            revisions.append((int(match.group(1)), item))
    revisions.sort(key=lambda pair: pair[0])
    return revisions


def _read(blob: Any, user_id: int, revisions: list[tuple[int, Any]]) -> tuple[int, dict]:
    if not revisions:
        return 0, new_doc(user_id)
    rev, item = revisions[-1]
    try:
        downloaded = blob.get_blob(item.url, access="private")
        doc = json.loads(downloaded.body.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise PaymentStorageError(f"cannot read player state: {exc}") from exc
    if not isinstance(doc, dict) or int(doc.get("uid", 0)) != int(user_id):
        raise PaymentStorageError("player state is corrupted")
    return rev, doc


def _commit(blob: Any, user_id: int, rev: int, doc: dict) -> None:
    doc["updated"] = now_ms()
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    try:
        blob.put_blob(
            _path(user_id, rev + 1),
            data,
            access="private",
            content_type="application/json",
            allow_overwrite=False,
        )
    except Exception as exc:  # noqa: BLE001
        if payments._is_duplicate(exc):
            raise _Conflict() from exc
        raise PaymentStorageError(str(exc)) from exc


def _cleanup(blob: Any, revisions: list[tuple[int, Any]], newest: int) -> None:
    if newest % 6:
        return
    stale = [item.url for rev, item in revisions if rev <= newest - KEEP_REVISIONS]
    if not stale:
        return
    try:
        blob.delete_blob(stale)
    except Exception as exc:  # noqa: BLE001 - best effort only
        print(f"[store] cleanup: {exc}", flush=True)


def read_doc(user_id: int) -> dict:
    """Latest state of a player (a fresh one if the player is new)."""
    blob = payments._blob()
    return _read(blob, user_id, _list_revisions(blob, user_id))[1]


def transact(user_id: int, fn: Callable[[dict], tuple[Any, bool]]) -> tuple[Any, dict]:
    """Run ``fn(doc) -> (result, changed)`` atomically for one player.

    ``fn`` may run several times (after a conflict), so it must only depend
    on ``doc``.  Returns ``(result, doc)``; ``doc`` is the committed state.
    """
    blob = payments._blob()
    for attempt in range(MAX_ATTEMPTS):
        revisions = _list_revisions(blob, user_id)
        rev, doc = _read(blob, user_id, revisions)
        result, changed = fn(doc)
        if not changed and rev:
            return result, doc
        try:
            _commit(blob, user_id, rev, doc)
        except _Conflict:
            time.sleep(min(0.6, 0.08 * (attempt + 1)) + secrets.randbelow(60) / 1000)
            continue
        _cleanup(blob, revisions, rev + 1)
        return result, doc
    raise PaymentStorageError("too many concurrent updates, try again")


# --------------------------------------------------------------------------
# Shared helpers used by the games
# --------------------------------------------------------------------------

def record_result(
    doc: dict,
    game: str,
    title: str,
    detail: str,
    delta: int,
    wager: int,
    stamp: int,
) -> None:
    doc["games"] += 1
    doc["wagered"] += int(wager)
    doc["biggestWin"] = max(doc["biggestWin"], int(delta))
    doc["history"].insert(0, {
        "id": f"{stamp}-{secrets.token_hex(3)}",
        "game": game,
        "title": title,
        "detail": detail[:140],
        "delta": int(delta),
        "wager": int(wager),
        "at": stamp,
    })
    del doc["history"][MAX_HISTORY:]


def credit(doc: dict, amount: int) -> None:
    doc["balance"] = min(MAX_BALANCE, doc["balance"] + int(amount))


def debit(doc: dict, amount: int) -> None:
    amount = int(amount)
    if amount <= 0 or amount > doc["balance"]:
        raise GameError("insufficient_funds", "Мало звёзд на балансе.")
    doc["balance"] -= amount


def apply_purchases(doc: dict, records: list[dict]) -> int:
    """Credit verified purchases that were not credited yet. Idempotent."""
    known = set(doc["credited"])
    total = 0
    for record in records:
        key = record["key"]
        if key in known:
            continue
        known.add(key)
        doc["credited"].append(key)
        doc["purchases"].insert(0, {
            "chargeId": record["charge_id"][:100],
            "amount": int(record["amount"]),
            "at": int(record["created_at"]) * 1000 or now_ms(),
        })
        credit(doc, record["amount"])
        total += int(record["amount"])
    del doc["credited"][:-MAX_CREDITED]
    del doc["purchases"][MAX_PURCHASES:]
    return total


def sync_purchases(user_id: int) -> int:
    """Credit new Telegram Stars purchases to the player. Returns stars added."""
    doc = read_doc(user_id)
    records = payments.purchases_excluding(user_id, set(doc["credited"]))
    if not records:
        return 0
    added, _ = transact(user_id, lambda d: _apply(d, records))
    return added


def _apply(doc: dict, records: list[dict]) -> tuple[int, bool]:
    added = apply_purchases(doc, records)
    return added, added > 0


def resolve_withdrawal(user_id: int, withdrawal_id: str, decision: str) -> str:
    """Admin decision for a withdrawal. Returns the new status or ``""``."""
    status_for = {"paid": "paid", "reject": "rejected"}
    if decision not in status_for:
        return ""

    def apply(doc: dict) -> tuple[str, bool]:
        for item in doc["withdrawals"]:
            if item["id"] != withdrawal_id:
                continue
            if item["status"] != "pending":
                return "", False
            item["status"] = status_for[decision]
            if decision == "reject":
                credit(doc, item["amount"])
            return item["status"], True
        return "", False

    result, _ = transact(user_id, apply)
    return result


def public_state(doc: dict, stamp: int | None = None) -> dict:
    """Everything the Mini App may see (no hidden cards, no mine positions)."""
    from . import games  # local import: games depends on this module

    stamp = stamp or now_ms()
    return {
        "balance": doc["balance"],
        "games": doc["games"],
        "wagered": doc["wagered"],
        "biggestWin": doc["biggestWin"],
        "history": doc["history"],
        "withdrawals": doc["withdrawals"],
        "purchases": doc["purchases"],
        "lastDaily": doc["lastDaily"],
        "today": games.day_key(stamp),
        "active": games.public_active(doc, stamp),
        "serverTime": stamp,
    }
