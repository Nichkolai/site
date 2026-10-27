"""Telegram Stars payments and purchase storage for KAZ.

Purchases are verified by Telegram in the bot webhook and stored in a private
Vercel Blob store. The Mini App only receives the purchases of the Telegram
user whose signed initData is sent to /api/purchases.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
from typing import Any

PURCHASE_PREFIX = "kaz/purchases"
MAX_PURCHASES = 20
INIT_DATA_MAX_AGE = 7 * 24 * 60 * 60
SESSION_TTL = 30 * 24 * 60 * 60
MIN_TOPUP = 1
MAX_TOPUP = 1_000_000
DEFAULT_TOPUP = 500


class PaymentStorageError(RuntimeError):
    """The payment ledger is unavailable or rejected a write."""


def _blob() -> Any:
    try:
        from vercel.blob import sync as blob
    except ImportError as exc:  # Local bot without the Vercel dependency.
        raise PaymentStorageError("vercel-blob is not installed") from exc
    return blob


def _safe_part(value: Any, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_-]", "_", str(value or ""))[:80]
    return text or fallback


def _path(user_id: int, charge_id: str) -> str:
    return f"{PURCHASE_PREFIX}/{_safe_part(user_id, 'unknown')}/{_safe_part(charge_id, 'unknown')}.json"


def _is_duplicate(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    text = str(exc).lower()
    return status in (409, 412) or "already exists" in text or "conflict" in text


def save_purchase(
    *,
    user_id: int,
    amount: int,
    currency: str,
    charge_id: str,
    payload: str,
) -> bool:
    """Store a verified successful payment. Returns False for a duplicate."""
    if amount < MIN_TOPUP or amount > MAX_TOPUP:
        raise PaymentStorageError("invalid top-up amount")
    if not charge_id:
        raise PaymentStorageError("missing charge id")

    record = {
        "user_id": int(user_id),
        "amount": int(amount),
        "currency": str(currency),
        "charge_id": str(charge_id),
        "payload": str(payload)[:128],
        "created_at": int(time.time()),
        "status": "paid",
    }
    blob = _blob()
    try:
        blob.put_blob(
            _path(user_id, charge_id),
            json.dumps(record, ensure_ascii=False).encode("utf-8"),
            access="private",
            content_type="application/json",
            allow_overwrite=False,
        )
    except blob.BlobError as exc:
        if _is_duplicate(exc):
            return False
        raise PaymentStorageError(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - converted for the webhook retry
        raise PaymentStorageError(str(exc)) from exc
    return True


def list_purchases(user_id: int) -> list[dict]:
    """Return the latest verified purchases for one Telegram user."""
    blob = _blob()
    prefix = f"{PURCHASE_PREFIX}/{_safe_part(user_id, 'unknown')}/"
    try:
        items = list(blob.query_blobs(prefix=prefix, page_size=100))
    except Exception as exc:  # noqa: BLE001
        raise PaymentStorageError(str(exc)) from exc

    records: list[dict] = []
    for item in items[:100]:
        try:
            downloaded = blob.get_blob(item.url, access="private")
            record = json.loads(downloaded.body.decode("utf-8"))
        except blob.BlobNotFoundError:
            continue
        except Exception as exc:  # noqa: BLE001 - one bad record must not break the rest
            print(f"[payments] read {getattr(item, 'pathname', '?')}: {exc}", flush=True)
            continue
        if not isinstance(record, dict) or int(record.get("user_id", 0)) != int(user_id):
            continue
        amount = max(0, min(MAX_TOPUP, int(record.get("amount", 0))))
        charge_id = str(record.get("charge_id") or "")
        if not amount or not charge_id:
            continue
        records.append({
            "charge_id": charge_id,
            "amount": amount,
            "created_at": int(record.get("created_at", 0)),
            "title": "Пополнение",
        })

    records.sort(key=lambda item: item["created_at"], reverse=True)
    return records[:MAX_PURCHASES]


def validate_init_data(init_data: str, bot_token: str) -> dict | None:
    """Verify Telegram WebApp initData and return its user object."""
    if not init_data or not bot_token:
        return None
    try:
        pairs = urllib.parse.parse_qsl(init_data, keep_blank_values=True)
    except (TypeError, ValueError):
        return None

    data: dict[str, str] = {}
    for key, value in pairs:
        if key in data:
            return None
        data[key] = value

    received_hash = data.pop("hash", "")
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{key}={data[key]}" for key in sorted(data))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        return None

    try:
        auth_date = int(data.get("auth_date", "0"))
    except (TypeError, ValueError):
        return None
    if auth_date <= 0 or abs(time.time() - auth_date) > INIT_DATA_MAX_AGE:
        return None

    try:
        user = json.loads(data.get("user", "{}"))
    except (TypeError, ValueError):
        return None
    if not isinstance(user, dict):
        return None
    try:
        user_id = int(user.get("id", 0))
    except (TypeError, ValueError):
        return None
    if user_id <= 0:
        return None
    return user


def _session_secret() -> bytes:
    secret = (
        os.environ.get("SESSION_SECRET")
        or os.environ.get("WEBHOOK_SECRET")
        or os.environ.get("BOT_TOKEN")
        or ""
    ).strip()
    return secret.encode("utf-8")


def create_session_token(user_id: int, ttl: int = SESSION_TTL) -> str:
    """Create a signed bearer token for clients without Telegram initData."""
    secret = _session_secret()
    if not secret:
        raise PaymentStorageError("session secret is not configured")
    payload = json.dumps(
        {"uid": int(user_id), "exp": int(time.time()) + int(ttl)},
        separators=(",", ":"),
    ).encode("utf-8")
    body = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
    signature = hmac.new(secret, body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def validate_session_token(token: str) -> int | None:
    """Return the user id from a signed session token, or None."""
    if not isinstance(token, str):
        return None
    token = token.strip()
    if not token or len(token) > 512 or token.count(".") != 1:
        return None
    secret = _session_secret()
    if not secret:
        return None
    body, received = token.split(".", 1)
    expected = hmac.new(secret, body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received):
        return None
    try:
        padded = body + "=" * (-len(body) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        user_id = int(data.get("uid", 0))
        expires = int(data.get("exp", 0))
    except (TypeError, ValueError, KeyError, json.JSONDecodeError):
        return None
    if user_id <= 0 or expires < int(time.time()):
        return None
    return user_id


def resolve_user_id(init_data: str, token: str, bot_token: str) -> int | None:
    """Prefer signed initData, then fall back to a signed session token."""
    user = validate_init_data(init_data, bot_token)
    if user:
        try:
            user_id = int(user["id"])
        except (KeyError, TypeError, ValueError):
            user_id = 0
        if user_id > 0:
            return user_id
    return validate_session_token(token)
