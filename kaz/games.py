"""KAZ games, computed on the server with honest, published odds.

Everything random comes from ``secrets``.  What the player sees on the board
is what the server plays: no hidden weighting, no hidden reductions.  The
return-to-player (RTP) of every game is listed in ``RULES`` and shown in the
app.
"""

from __future__ import annotations

import math
import secrets
import time
from typing import Any

from .store import (
    GameError,
    MAX_WITHDRAWALS,
    credit,
    debit,
    record_result,
)

MAX_BET = 1_000_000
DAILY_BONUS = 10
MIN_WITHDRAW = 500
MSK_OFFSET = 3 * 3600  # daily bonus resets at midnight Moscow time

_rng = secrets.SystemRandom()


def _round(value: float) -> int:
    """Round half up, like JavaScript's Math.round for positive numbers."""
    return int(math.floor(value + 0.5))


def _bet(doc: dict, params: dict, minimum: int) -> int:
    try:
        bet = int(params.get("bet"))
    except (TypeError, ValueError):
        raise GameError("invalid_bet", "Некорректная ставка.") from None
    if bet < minimum or bet > MAX_BET:
        raise GameError("invalid_bet", f"Ставка от {minimum} ★.")
    if bet > doc["balance"]:
        raise GameError("insufficient_funds", "Мало звёзд на балансе.")
    return bet


def day_key(stamp: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(stamp / 1000 + MSK_OFFSET))


# --------------------------------------------------------------------------
# Published rules / RTP (shown in the app)
# --------------------------------------------------------------------------

SLOT_SYMBOLS = [
    ("cherry", 30, 10),
    ("lemon", 23, 16),
    ("bell", 19, 24),
    ("star", 13, 50),
    ("seven", 9, 100),
    ("diamond", 6, 240),
]
SLOT_LINES = [(0, 1, 2), (3, 4, 5), (6, 7, 8), (0, 4, 8), (2, 4, 6)]
SLOT_TOTAL_WEIGHT = sum(weight for _, weight, _ in SLOT_SYMBOLS)

WHEEL_ORDER = [
    0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, 37,
    27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
]  # 37 is the "00" pocket
RED_NUMBERS = {1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36}

MINES_CELLS = 25
MINES_COUNT = 5
MINES_EDGE = 0.92
MINES_MAX_MULTIPLIER = 250

CRASH_EDGE = 0.84
CRASH_MAX = 50
CRASH_GROWTH = 0.22

UPGRADER_EDGE = 0.93
UPGRADER_TARGETS = (1.5, 2.0, 3.0, 5.0, 10.0)

BJ_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


# --------------------------------------------------------------------------
# Slots
# --------------------------------------------------------------------------

def _slot_symbol() -> str:
    ticket = secrets.randbelow(SLOT_TOTAL_WEIGHT)
    for symbol, weight, _ in SLOT_SYMBOLS:
        ticket -= weight
        if ticket < 0:
            return symbol
    return SLOT_SYMBOLS[0][0]


def slots_spin(doc: dict, params: dict, ctx: dict) -> dict:
    bet = _bet(doc, params, 1)
    debit(doc, bet)
    grid = [_slot_symbol() for _ in range(9)]
    triple = {symbol: payout for symbol, _, payout in SLOT_SYMBOLS}
    line_stake = bet / len(SLOT_LINES)

    total = 0
    lines = 0
    wins: set[int] = set()
    for line in SLOT_LINES:
        symbols = [grid[index] for index in line]
        if symbols[0] == symbols[1] == symbols[2]:
            total += _round(line_stake * triple[symbols[0]])
            lines += 1
            wins.update(line)

    credit(doc, total)
    word = "линия" if lines == 1 else "линии" if lines < 5 else "линий"
    record_result(
        doc, "slots", "Слоты",
        f"{lines} {word}" if total else "Без выигрыша",
        total - bet, bet, ctx["now"],
    )
    return {"grid": grid, "total": total, "lines": lines, "wins": sorted(wins), "bet": bet}


# --------------------------------------------------------------------------
# Roulette (American, 38 equally likely pockets)
# --------------------------------------------------------------------------

def _roulette_valid_key(key: str) -> bool:
    if key == "num:00":
        return True
    if key.startswith("num:"):
        return key[4:].isdigit() and 0 <= int(key[4:]) <= 36 and str(int(key[4:])) == key[4:]
    return key in {"red", "black", "even", "odd", "low", "high", "dozen:1", "dozen:2", "dozen:3"}


def _roulette_wins(key: str, number: int) -> bool:
    if key.startswith("num:"):
        return (37 if key == "num:00" else int(key[4:])) == number
    if number in (0, 37):
        return False
    return {
        "red": number in RED_NUMBERS,
        "black": number not in RED_NUMBERS,
        "even": number % 2 == 0,
        "odd": number % 2 == 1,
        "low": 1 <= number <= 18,
        "high": 19 <= number <= 36,
        "dozen:1": 1 <= number <= 12,
        "dozen:2": 13 <= number <= 24,
        "dozen:3": 25 <= number <= 36,
    }[key]


def roulette_spin(doc: dict, params: dict, ctx: dict) -> dict:
    raw = params.get("bets")
    if not isinstance(raw, dict) or not raw or len(raw) > 60:
        raise GameError("invalid_bet", "Сделайте ставку.")
    bets: dict[str, int] = {}
    for key, amount in raw.items():
        if not isinstance(key, str) or not _roulette_valid_key(key):
            raise GameError("invalid_bet", "Некорректная ставка.")
        try:
            value = int(amount)
        except (TypeError, ValueError):
            raise GameError("invalid_bet", "Некорректная ставка.") from None
        if value < 1 or value > MAX_BET:
            raise GameError("invalid_bet", "Некорректная ставка.")
        bets[key] = value
    stake = sum(bets.values())
    if stake > MAX_BET:
        raise GameError("invalid_bet", "Слишком большая ставка.")
    if stake > doc["balance"]:
        raise GameError("insufficient_funds", "Мало звёзд на балансе.")

    debit(doc, stake)
    winner_index = secrets.randbelow(len(WHEEL_ORDER))
    number = WHEEL_ORDER[winner_index]
    payout = 0
    for key, amount in bets.items():
        if _roulette_wins(key, number):
            multiplier = 36 if key.startswith("num:") else 3 if key.startswith("dozen:") else 2
            payout += amount * multiplier
    credit(doc, payout)

    label = "00" if number == 37 else str(number)
    record_result(doc, "roulette", "Рулетка", f"Выпало {label}", payout - stake, stake, ctx["now"])
    return {"winnerIndex": winner_index, "number": number, "payout": payout, "stake": stake}


# --------------------------------------------------------------------------
# Blackjack (one fresh deck per round, 6:5 blackjack, dealer hits soft 17)
# --------------------------------------------------------------------------

def _bj_points(rank: str) -> int:
    if rank == "A":
        return 11
    if rank in ("K", "Q", "J"):
        return 10
    return int(rank)


def _bj_value(hand: list) -> tuple[int, bool]:
    total = sum(_bj_points(card[0]) for card in hand)
    aces = sum(1 for card in hand if card[0] == "A")
    while total > 21 and aces:
        total -= 10
        aces -= 1
    return total, aces > 0


def _bj_deck() -> list:
    deck = [[rank, suit] for suit in range(4) for rank in BJ_RANKS]
    _rng.shuffle(deck)
    return deck


def _bj_view(bj: dict, reveal: bool = False) -> dict:
    reveal = reveal or bj["phase"] == "done"
    dealer = bj["dealer"] if reveal else [bj["dealer"][0], None]
    return {
        "phase": bj["phase"],
        "player": bj["player"],
        "dealer": dealer,
        "hidden": not reveal,
        "wager": bj["wager"],
        "bet": bj["bet"],
        "doubled": bj["doubled"],
        "playerTotal": _bj_value(bj["player"])[0],
        "dealerTotal": _bj_value(bj["dealer"])[0] if reveal else _bj_value([bj["dealer"][0]])[0],
    }


def _bj_settle(doc: dict, bj: dict, outcome: str, ctx: dict) -> dict:
    wager = bj["wager"]
    player_total = _bj_value(bj["player"])[0]
    dealer_total = _bj_value(bj["dealer"])[0]
    blackjack_profit = _round(wager * 1.2)
    payout = 0
    detail = ""
    if outcome == "blackjack":
        payout = wager + blackjack_profit
        detail = "Блэкджек"
    elif outcome == "win":
        payout = wager * 2
        detail = f"{player_total}:{dealer_total} в вашу пользу"
    elif outcome == "dealerBust":
        payout = wager * 2
        detail = f"Перебор дилера {dealer_total}"
    elif outcome == "push":
        payout = wager
        detail = f"Ничья {player_total}:{dealer_total} · возврат ставки"
    elif outcome == "bust":
        detail = f"Перебор {player_total}"
    elif outcome == "dealerBlackjack":
        detail = "Блэкджек у дилера"
    else:
        detail = f"Дилер {dealer_total}:{player_total}"

    credit(doc, payout)
    record_result(doc, "blackjack", "Блэкджек", detail, payout - wager, wager, ctx["now"])
    doc["active"].pop("blackjack", None)
    bj["phase"] = "done"
    view = _bj_view(bj, reveal=True)
    view.update({"outcome": outcome, "payout": payout, "net": payout - wager})
    return {"view": view}


def _bj_dealer_turn(doc: dict, bj: dict, ctx: dict) -> dict:
    while True:
        total, soft = _bj_value(bj["dealer"])
        if total < 17 or (total == 17 and soft):
            bj["dealer"].append(bj["deck"].pop())
        else:
            break
    player_total = _bj_value(bj["player"])[0]
    dealer_total = _bj_value(bj["dealer"])[0]
    if dealer_total > 21:
        outcome = "dealerBust"
    elif player_total > dealer_total:
        outcome = "win"
    elif player_total == dealer_total:
        outcome = "push"
    else:
        outcome = "lose"
    return _bj_settle(doc, bj, outcome, ctx)


def _bj_active(doc: dict) -> dict:
    bj = doc["active"].get("blackjack")
    if not bj or bj.get("phase") != "player":
        raise GameError("no_round", "Раунд не найден. Раздайте карты заново.")
    return bj


def blackjack_deal(doc: dict, params: dict, ctx: dict) -> dict:
    if "blackjack" in doc["active"]:
        raise GameError("round_active", "Раунд уже идёт.")
    bet = _bet(doc, params, 5)
    debit(doc, bet)
    deck = _bj_deck()
    player = [deck.pop(), deck.pop()]
    dealer = [deck.pop(), deck.pop()]
    bj = {
        "deck": deck, "player": player, "dealer": dealer,
        "wager": bet, "bet": bet, "doubled": False, "phase": "player",
    }
    player_total = _bj_value(player)[0]
    dealer_total = _bj_value(dealer)[0]
    if player_total == 21 or dealer_total == 21:
        if player_total == 21 and dealer_total == 21:
            outcome = "push"
        elif player_total == 21:
            outcome = "blackjack"
        else:
            outcome = "dealerBlackjack"
        return _bj_settle(doc, bj, outcome, ctx)
    doc["active"]["blackjack"] = bj
    return {"view": _bj_view(bj)}


def blackjack_hit(doc: dict, params: dict, ctx: dict) -> dict:
    bj = _bj_active(doc)
    bj["player"].append(bj["deck"].pop())
    total = _bj_value(bj["player"])[0]
    if total > 21:
        return _bj_settle(doc, bj, "bust", ctx)
    if total == 21:
        return _bj_dealer_turn(doc, bj, ctx)
    return {"view": _bj_view(bj)}


def blackjack_stand(doc: dict, params: dict, ctx: dict) -> dict:
    bj = _bj_active(doc)
    return _bj_dealer_turn(doc, bj, ctx)


def blackjack_double(doc: dict, params: dict, ctx: dict) -> dict:
    bj = _bj_active(doc)
    if bj["doubled"] or len(bj["player"]) != 2:
        raise GameError("invalid_action", "Удвоить можно только на первых двух картах.")
    debit(doc, bj["bet"])
    bj["wager"] += bj["bet"]
    bj["doubled"] = True
    bj["player"].append(bj["deck"].pop())
    if _bj_value(bj["player"])[0] > 21:
        return _bj_settle(doc, bj, "bust", ctx)
    return _bj_dealer_turn(doc, bj, ctx)


# --------------------------------------------------------------------------
# Mines (5 x 5, 5 mines)
# --------------------------------------------------------------------------

def mines_multiplier(picks: int) -> float:
    if not picks:
        return 1.0
    multiplier = 1.0
    for index in range(picks):
        multiplier *= (MINES_CELLS - index) / (MINES_CELLS - MINES_COUNT - index)
    return min(MINES_MAX_MULTIPLIER, multiplier * MINES_EDGE)


def _mines_view(game: dict) -> dict:
    picks = len(game["revealed"])
    return {
        "status": "playing",
        "wager": game["wager"],
        "revealed": game["revealed"],
        "picks": picks,
        "multiplier": mines_multiplier(picks),
        "potential": _round(game["wager"] * mines_multiplier(picks)) if picks else 0,
    }


def mines_start(doc: dict, params: dict, ctx: dict) -> dict:
    if "mines" in doc["active"]:
        raise GameError("round_active", "Раунд уже идёт.")
    bet = _bet(doc, params, 5)
    debit(doc, bet)
    cells = list(range(MINES_CELLS))
    _rng.shuffle(cells)
    game = {"mines": sorted(cells[:MINES_COUNT]), "revealed": [], "wager": bet}
    doc["active"]["mines"] = game
    return _mines_view(game)


def _mines_active(doc: dict) -> dict:
    game = doc["active"].get("mines")
    if not game:
        raise GameError("no_round", "Раунд не найден. Начните новую игру.")
    return game


def _mines_cash(doc: dict, game: dict, ctx: dict) -> dict:
    picks = len(game["revealed"])
    payout = _round(game["wager"] * mines_multiplier(picks))
    credit(doc, payout)
    net = payout - game["wager"]
    record_result(doc, "mines", "Мины", f"Открыто {picks} из 20", net, game["wager"], ctx["now"])
    doc["active"].pop("mines", None)
    return {
        "status": "cashed", "wager": game["wager"], "revealed": game["revealed"],
        "picks": picks, "multiplier": mines_multiplier(picks),
        "payout": payout, "net": net, "mines": game["mines"],
    }


def mines_reveal(doc: dict, params: dict, ctx: dict) -> dict:
    game = _mines_active(doc)
    try:
        index = int(params.get("index"))
    except (TypeError, ValueError):
        raise GameError("invalid_action", "Некорректная клетка.") from None
    if index < 0 or index >= MINES_CELLS or index in game["revealed"]:
        raise GameError("invalid_action", "Некорректная клетка.")

    if index in game["mines"]:
        picks = len(game["revealed"])
        word = "звезды" if picks == 1 else "звёзд"
        record_result(
            doc, "mines", "Мины", f"Мина после {picks} {word}",
            -game["wager"], game["wager"], ctx["now"],
        )
        doc["active"].pop("mines", None)
        return {
            "status": "lost", "wager": game["wager"], "revealed": game["revealed"],
            "picks": picks, "index": index, "mines": game["mines"], "net": -game["wager"],
        }

    game["revealed"].append(index)
    if len(game["revealed"]) >= MINES_CELLS - MINES_COUNT:
        return _mines_cash(doc, game, ctx)
    return _mines_view(game)


def mines_cashout(doc: dict, params: dict, ctx: dict) -> dict:
    game = _mines_active(doc)
    if not game["revealed"]:
        raise GameError("invalid_action", "Сначала откройте хотя бы одну звезду.")
    return _mines_cash(doc, game, ctx)


# --------------------------------------------------------------------------
# Crash
# --------------------------------------------------------------------------

def _crash_point() -> float:
    roll = _rng.random()
    raw = CRASH_EDGE / max(0.0001, 1 - roll)
    return max(1.0, min(float(CRASH_MAX), round(raw * 100) / 100))


def _crash_duration_ms(crash_at: float) -> float:
    return math.log(crash_at) / CRASH_GROWTH * 1000


def _crash_lost(doc: dict, game: dict, stamp: int) -> dict:
    record_result(
        doc, "crash", "Краш", f"На {game['crashAt']:.2f}×",
        -game["wager"], game["wager"], stamp,
    )
    doc["active"].pop("crash", None)
    return {"status": "crashed", "crashAt": game["crashAt"], "wager": game["wager"]}


def crash_start(doc: dict, params: dict, ctx: dict) -> dict:
    if "crash" in doc["active"]:
        raise GameError("round_active", "Раунд уже идёт.")
    bet = _bet(doc, params, 2)
    debit(doc, bet)
    doc["active"]["crash"] = {
        "wager": bet, "crashAt": _crash_point(), "startedAt": ctx["now"],
    }
    return {"status": "running", "wager": bet, "elapsed": 0}


def _crash_active(doc: dict) -> dict:
    game = doc["active"].get("crash")
    if not game:
        raise GameError("no_round", "Раунд не найден.")
    return game


def crash_poll(doc: dict, params: dict, ctx: dict) -> dict:
    game = _crash_active(doc)
    elapsed = ctx["now"] - game["startedAt"]
    if elapsed >= _crash_duration_ms(game["crashAt"]):
        return _crash_lost(doc, game, ctx["now"])
    return {"status": "running", "wager": game["wager"], "elapsed": elapsed}


def crash_cashout(doc: dict, params: dict, ctx: dict) -> dict:
    game = _crash_active(doc)
    elapsed = ctx["now"] - game["startedAt"]
    if elapsed < 0:
        # A delayed request from a previous round must not cash out a new one.
        raise GameError("no_round", "Раунд не найден.")
    if elapsed >= _crash_duration_ms(game["crashAt"]):
        return _crash_lost(doc, game, ctx["now"])
    multiplier = math.exp(CRASH_GROWTH * max(0, elapsed) / 1000)
    payout = _round(game["wager"] * multiplier)
    net = payout - game["wager"]
    credit(doc, payout)
    record_result(
        doc, "crash", "Краш", f"Забрали на {multiplier:.2f}×",
        net, game["wager"], ctx["now"],
    )
    doc["active"].pop("crash", None)
    return {
        "status": "cashed", "multiplier": multiplier, "payout": payout,
        "net": net, "wager": game["wager"], "crashAt": game["crashAt"],
    }


def settle_expired(doc: dict, stamp: int) -> bool:
    """Crash rounds that ran past their crash point are lost. True if changed."""
    game = doc["active"].get("crash")
    if game and stamp - game["startedAt"] >= _crash_duration_ms(game["crashAt"]):
        _crash_lost(doc, game, stamp)
        return True
    return False


# --------------------------------------------------------------------------
# Upgrader
# --------------------------------------------------------------------------

def upgrader_chance(target: float) -> float:
    return min(1.0, UPGRADER_EDGE / target)


def upgrader_play(doc: dict, params: dict, ctx: dict) -> dict:
    try:
        target = float(params.get("target"))
    except (TypeError, ValueError):
        raise GameError("invalid_action", "Некорректный множитель.") from None
    if target not in UPGRADER_TARGETS:
        raise GameError("invalid_action", "Некорректный множитель.")
    bet = _bet(doc, params, 2)
    debit(doc, bet)

    chance = upgrader_chance(target)
    roll = _rng.random()
    won = roll < chance
    payout = _round(bet * target) if won else 0
    credit(doc, payout)
    net = payout - bet
    record_result(
        doc, "upgrader", "Апгрейд",
        f"Цель ×{target:.2f} · шанс {chance * 100:.1f}%".replace(".0%", "%"),
        net, bet, ctx["now"],
    )
    return {"won": won, "roll": roll, "chance": chance, "payout": payout, "net": net, "bet": bet}


# --------------------------------------------------------------------------
# Daily bonus and withdrawals
# --------------------------------------------------------------------------

def daily_claim(doc: dict, params: dict, ctx: dict) -> dict:
    today = day_key(ctx["now"])
    if doc["lastDaily"] == today:
        raise GameError("already_claimed", "Бонус уже получен. Новый будет завтра.")
    doc["lastDaily"] = today
    credit(doc, DAILY_BONUS)
    return {"amount": DAILY_BONUS}


def withdraw_request(doc: dict, params: dict, ctx: dict) -> dict:
    try:
        amount = int(params.get("amount"))
    except (TypeError, ValueError):
        raise GameError("invalid_amount", "Проверьте сумму.") from None
    if amount < MIN_WITHDRAW:
        raise GameError("invalid_amount", f"Минимум для вывода — {MIN_WITHDRAW} ★.")
    if amount > doc["balance"]:
        raise GameError("insufficient_funds", "Сумма больше баланса.")
    pending = [item for item in doc["withdrawals"] if item["status"] == "pending"]
    if len(pending) >= 5:
        raise GameError("too_many", "Сначала дождитесь обработки прошлых заявок.")

    debit(doc, amount)
    stamp = ctx["now"]
    item = {
        "id": f"W-{_base36(stamp)}-{secrets.token_hex(2).upper()}",
        "amount": amount,
        "contact": str(ctx.get("contact") or f"ID {doc['uid']}")[:80],
        "at": stamp,
        "status": "pending",
    }
    doc["withdrawals"].insert(0, item)
    del doc["withdrawals"][MAX_WITHDRAWALS:]
    return {"withdrawal": item}


def _base36(value: int) -> str:
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out = ""
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return out or "0"


# --------------------------------------------------------------------------
# Public view of active rounds
# --------------------------------------------------------------------------

def public_active(doc: dict, stamp: int) -> dict:
    active: dict[str, Any] = {}
    bj = doc["active"].get("blackjack")
    if bj:
        active["blackjack"] = _bj_view(bj)
    mines = doc["active"].get("mines")
    if mines:
        active["mines"] = _mines_view(mines)
    crash = doc["active"].get("crash")
    if crash:
        active["crash"] = {
            "status": "running", "wager": crash["wager"],
            "elapsed": max(0, stamp - crash["startedAt"]),
        }
    return active


HANDLERS = {
    "slots.spin": slots_spin,
    "roulette.spin": roulette_spin,
    "blackjack.deal": blackjack_deal,
    "blackjack.hit": blackjack_hit,
    "blackjack.stand": blackjack_stand,
    "blackjack.double": blackjack_double,
    "mines.start": mines_start,
    "mines.reveal": mines_reveal,
    "mines.cashout": mines_cashout,
    "crash.start": crash_start,
    "crash.poll": crash_poll,
    "crash.cashout": crash_cashout,
    "upgrader.play": upgrader_play,
    "daily.claim": daily_claim,
    "withdraw.request": withdraw_request,
}


def run_action(doc: dict, action: str, params: dict, ctx: dict) -> dict:
    handler = HANDLERS.get(action)
    if handler is None:
        raise GameError("unknown_action", "Неизвестное действие.")
    return handler(doc, params, ctx)
