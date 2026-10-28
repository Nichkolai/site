"""Offline tests for the KAZ server engine (fake Vercel Blob in memory)."""

import sys
import threading
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class FakeBlobError(Exception):
    def __init__(self, message, status_code=400, code=""):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class FakeNotFound(FakeBlobError):
    pass


class FakeStore:
    def __init__(self):
        self.files = {}
        self.uploaded = {}
        self.clock = 0
        self.lock = threading.Lock()


def install_fake_blob(store):
    class Item:
        def __init__(self, pathname):
            self.pathname = pathname
            self.url = "https://fake/" + pathname
            self.uploaded_at = store.uploaded.get(pathname, 0)

    class Got:
        def __init__(self, body):
            self.body = body

    def put_blob(path, data, *, access, content_type=None, allow_overwrite=False, **kw):
        assert access == "private"
        with store.lock:
            if path in store.files and not allow_overwrite:
                raise FakeBlobError("This blob already exists", 400, "blob_already_exists")
            store.files[path] = bytes(data)
            store.clock += 1
            store.uploaded[path] = store.clock

    def get_blob(url, *, access):
        path = url.replace("https://fake/", "")
        with store.lock:
            if path not in store.files:
                raise FakeNotFound("not found", 404)
            return Got(store.files[path])

    def query_blobs(*, prefix=None, page_size=None, cursor=None):
        with store.lock:
            names = sorted(n for n in store.files if n.startswith(prefix or ""))
        return iter([Item(n) for n in names])

    def delete_blob(urls, **kw):
        with store.lock:
            for url in urls if isinstance(urls, list) else [urls]:
                store.files.pop(url.replace("https://fake/", ""), None)

    sync = types.ModuleType("vercel.blob.sync")
    sync.put_blob, sync.get_blob = put_blob, get_blob
    sync.query_blobs, sync.delete_blob = query_blobs, delete_blob
    sync.BlobError, sync.BlobNotFoundError = FakeBlobError, FakeNotFound
    blob = types.ModuleType("vercel.blob")
    blob.sync = sync
    pkg = types.ModuleType("vercel")
    pkg.blob = blob
    sys.modules.update({"vercel": pkg, "vercel.blob": blob, "vercel.blob.sync": sync})


STORE = FakeStore()
install_fake_blob(STORE)

import payments  # noqa: E402
from kaz import engine, games, store  # noqa: E402
from kaz.store import GameError  # noqa: E402


def fresh_user(uid):
    return uid


class EngineTests(unittest.TestCase):
    def setUp(self):
        STORE.files.clear()

    def run_action(self, uid, action, **params):
        return engine.run(uid, action, params)

    def test_new_player_starts_with_50(self):
        state = self.run_action(1, "state")["state"]
        self.assertEqual(state["balance"], 50)

    def test_insufficient_funds_and_bad_bet(self):
        with self.assertRaises(GameError):
            self.run_action(2, "slots.spin", bet=51)
        with self.assertRaises(GameError):
            self.run_action(2, "slots.spin", bet=0)
        with self.assertRaises(GameError):
            self.run_action(2, "slots.spin", bet="x")
        self.assertEqual(self.run_action(2, "state")["state"]["balance"], 50)

    def test_slots_balance_and_history(self):
        out = self.run_action(3, "slots.spin", bet=10)
        state = out["state"]
        self.assertEqual(state["balance"], 50 - 10 + out["result"]["total"])
        self.assertEqual(state["games"], 1)
        self.assertEqual(state["wagered"], 10)
        self.assertEqual(state["history"][0]["delta"], out["result"]["total"] - 10)

    def test_daily_once_per_day(self):
        self.run_action(4, "daily.claim")
        with self.assertRaises(GameError):
            self.run_action(4, "daily.claim")
        self.assertEqual(self.run_action(4, "state")["state"]["balance"], 60)

    def test_purchases_credit_once(self):
        for charge in ("c1", "c2"):
            payments.save_purchase(user_id=5, amount=100, currency="XTR",
                                   charge_id=charge, payload="topup:100:x")
        first = self.run_action(5, "state")["state"]
        self.assertEqual(first["balance"], 250)
        self.assertEqual(len(first["purchases"]), 2)
        again = self.run_action(5, "state")["state"]
        self.assertEqual(again["balance"], 250)
        # a duplicate webhook delivery must not double credit
        self.assertFalse(payments.save_purchase(user_id=5, amount=100, currency="XTR",
                                                charge_id="c1", payload="p"))
        self.assertEqual(store.sync_purchases(5), 0)
        self.assertEqual(self.run_action(5, "state")["state"]["balance"], 250)

    def test_concurrent_requests_never_double_spend(self):
        results = []

        def spin():
            try:
                self.run_action(6, "upgrader.play", bet=50, target=10)
                results.append("ok")
            except GameError as exc:
                results.append(exc.code)

        threads = [threading.Thread(target=spin) for _ in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        state = self.run_action(6, "state")["state"]
        spent = state["wagered"]
        self.assertEqual(state["games"], results.count("ok"))
        self.assertEqual(spent, 50 * results.count("ok"))
        # balance identity: 50 + sum(deltas) == balance
        self.assertEqual(50 + sum(h["delta"] for h in state["history"]), state["balance"])

    def test_old_revisions_are_cleaned(self):
        for _ in range(14):
            self.run_action(7, "state")
            try:
                self.run_action(7, "slots.spin", bet=1)
            except GameError:
                pass
        files = [n for n in STORE.files if n.startswith("kaz/players/7/")]
        self.assertLess(len(files), 14)
        self.assertTrue(self.run_action(7, "state")["state"])


class GameTests(unittest.TestCase):
    def setUp(self):
        STORE.files.clear()

    def give(self, uid, amount):
        def apply(doc):
            doc["balance"] = amount
            return None, True
        store.transact(uid, apply)

    def act(self, uid, action, **params):
        return engine.run(uid, action, params)

    def test_roulette_validation_and_payout_identity(self):
        self.give(10, 1000)
        with self.assertRaises(GameError):
            self.act(10, "roulette.spin", bets={"num:37": 5})
        with self.assertRaises(GameError):
            self.act(10, "roulette.spin", bets={"red": 2000})
        with self.assertRaises(GameError):
            self.act(10, "roulette.spin", bets={"red": -5})
        out = self.act(10, "roulette.spin", bets={"red": 10, "num:00": 5, "dozen:2": 10})
        res = out["result"]
        self.assertEqual(games.WHEEL_ORDER[res["winnerIndex"]], res["number"])
        self.assertEqual(out["state"]["balance"], 1000 - 25 + res["payout"])

    def test_blackjack_hidden_card_never_leaks(self):
        self.give(11, 1000)
        for _ in range(30):
            try:
                out = self.act(11, "blackjack.deal", bet=5)
            except GameError:
                self.act(11, "blackjack.stand")
                continue
            view = out["result"]["view"]
            if view["phase"] == "player":
                self.assertIsNone(view["dealer"][1])
                self.assertNotIn("deck", str(out["state"]))
                state_view = out["state"]["active"]["blackjack"]
                self.assertIsNone(state_view["dealer"][1])
                self.act(11, "blackjack.stand")
        state = self.act(11, "state")["state"]
        self.assertEqual(1000 + sum(h["delta"] for h in state["history"]), state["balance"])

    def test_blackjack_cannot_double_after_hit_or_act_without_round(self):
        self.give(12, 1000)
        with self.assertRaises(GameError):
            self.act(12, "blackjack.hit")
        for _ in range(50):
            out = self.act(12, "blackjack.deal", bet=5)
            if out["result"]["view"]["phase"] == "player":
                break
        out = self.act(12, "blackjack.hit")
        if out["result"]["view"]["phase"] == "player":
            with self.assertRaises(GameError):
                self.act(12, "blackjack.double")

    def test_mines_flow(self):
        self.give(13, 1000)
        out = self.act(13, "mines.start", bet=10)
        self.assertNotIn("mines", out["result"])
        self.assertNotIn("mines", out["state"]["active"]["mines"])
        with self.assertRaises(GameError):
            self.act(13, "mines.cashout")
        with self.assertRaises(GameError):
            self.act(13, "mines.start", bet=10)
        status = "playing"
        for index in range(25):
            res = self.act(13, "mines.reveal", index=index)["result"]
            status = res["status"]
            if status != "playing":
                break
        self.assertIn(status, ("lost", "cashed"))
        self.assertEqual(len(res["mines"]), 5)
        state = self.act(13, "state")["state"]
        self.assertNotIn("mines", state["active"])
        self.assertEqual(1000 + sum(h["delta"] for h in state["history"]), state["balance"])

    def test_mines_cashout_value(self):
        self.give(14, 1000)
        self.act(14, "mines.start", bet=100)
        doc = store.read_doc(14)
        safe = [i for i in range(25) if i not in doc["active"]["mines"]["mines"]]
        res = self.act(14, "mines.reveal", index=safe[0])["result"]
        self.assertEqual(res["status"], "playing")
        self.assertAlmostEqual(res["multiplier"], 25 / 20 * 0.92, places=6)
        out = self.act(14, "mines.cashout")
        self.assertEqual(out["result"]["payout"], games._round(100 * 25 / 20 * 0.92))

    def test_crash_cashout_and_expiry(self):
        self.give(15, 1000)
        self.act(15, "crash.start", bet=10)
        # pin a far crash point first: a random point near 1.00x would expire the round
        # before the state check below and make this test flaky
        def force(d):
            d["active"]["crash"]["crashAt"] = 50.0
            return None, True
        store.transact(15, force)
        self.assertNotIn("crashAt", self.act(15, "state")["state"]["active"]["crash"])
        def advance(d):
            d["active"]["crash"]["startedAt"] -= 4000
            return None, True
        store.transact(15, advance)
        res = self.act(15, "crash.cashout")["result"]
        self.assertEqual(res["status"], "cashed")
        self.assertGreater(res["multiplier"], 2.4)
        # expired round is lost
        self.act(15, "crash.start", bet=10)
        def expire(d):
            d["active"]["crash"]["crashAt"] = 1.5
            d["active"]["crash"]["startedAt"] -= 60_000
            return None, True
        store.transact(15, expire)
        res = self.act(15, "crash.cashout")["result"]
        self.assertEqual(res["status"], "crashed")
        state = self.act(15, "state")["state"]
        self.assertNotIn("crash", state["active"])
        self.assertEqual(1000 + sum(h["delta"] for h in state["history"]), state["balance"])

    def test_crash_abandoned_round_is_settled_by_state(self):
        self.give(16, 100)
        self.act(16, "crash.start", bet=10)
        def expire(d):
            d["active"]["crash"]["crashAt"] = 1.2
            d["active"]["crash"]["startedAt"] -= 60_000
            return None, True
        store.transact(16, expire)
        state = self.act(16, "state")["state"]
        self.assertNotIn("crash", state["active"])
        self.assertEqual(state["balance"], 90)

    def test_upgrader_honest_chance(self):
        self.give(17, 1000)
        out = self.act(17, "upgrader.play", bet=10, target=2)
        self.assertAlmostEqual(out["result"]["chance"], 0.465)
        with self.assertRaises(GameError):
            self.act(17, "upgrader.play", bet=10, target=7)

    def test_withdraw_reserve_and_refund(self):
        self.give(18, 1000)
        with self.assertRaises(GameError):
            self.act(18, "withdraw.request", amount=0)
        with self.assertRaises(GameError):
            self.act(18, "withdraw.request", amount=1001)
        out = self.act(18, "withdraw.request", amount=600)
        item = out["result"]["withdrawal"]
        self.assertEqual(out["state"]["balance"], 400)
        self.assertEqual(store.resolve_withdrawal(18, item["id"], "reject"), "rejected")
        self.assertEqual(store.resolve_withdrawal(18, item["id"], "reject"), "")
        self.assertEqual(store.resolve_withdrawal(18, item["id"], "paid"), "")
        self.assertEqual(self.act(18, "state")["state"]["balance"], 1000)
        out = self.act(18, "withdraw.request", amount=1)
        item = out["result"]["withdrawal"]
        self.assertEqual(out["state"]["balance"], 999)
        self.assertEqual(store.resolve_withdrawal(18, item["id"], "paid"), "paid")
        self.assertEqual(self.act(18, "state")["state"]["balance"], 999)


class RtpTests(unittest.TestCase):
    """The odds the app publishes must match what the server really plays."""

    def test_slots_exact_rtp(self):
        total_weight = games.SLOT_TOTAL_WEIGHT
        rtp = sum((w / total_weight) ** 3 * t for _, w, t in games.SLOT_SYMBOLS)
        self.assertAlmostEqual(rtp, 0.8639, places=3)

    def test_roulette_uniform_and_rtp(self):
        self.assertEqual(len(games.WHEEL_ORDER), 38)
        self.assertEqual(len(set(games.WHEEL_ORDER)), 38)
        for key, pockets, mult in (("red", 18, 2), ("dozen:1", 12, 3), ("num:7", 1, 36)):
            wins = sum(games._roulette_wins(key, n) for n in games.WHEEL_ORDER)
            self.assertEqual(wins, pockets)
            self.assertAlmostEqual(wins / 38 * mult, 36 / 38, places=9)

    def test_upgrader_rtp(self):
        for target in games.UPGRADER_TARGETS:
            self.assertAlmostEqual(games.upgrader_chance(target) * target, 0.93, places=9)

    def test_mines_rtp_is_edge(self):
        # P(survive k picks) * multiplier(k) == edge (before the cap)
        for picks in range(1, 8):
            survive = 1.0
            for i in range(picks):
                survive *= (25 - 5 - i) / (25 - i)
            self.assertAlmostEqual(survive * games.mines_multiplier(picks), 0.92, places=9)

    def test_crash_point_distribution(self):
        n = 200_000
        points = [games._crash_point() for _ in range(n)]
        for x in (1.5, 2, 5, 10):
            observed = sum(p >= x for p in points) / n
            self.assertAlmostEqual(observed, 0.84 / x, delta=0.006)

    def test_blackjack_has_no_hidden_bias(self):
        # Hit once on 11 vs a fresh deck: ten-valued share must be 16/52 (30.8%).
        tens = trials = 0
        for _ in range(60_000):
            deck = games._bj_deck()
            card = deck.pop()
            trials += 1
            tens += games._bj_points(card[0]) == 10
        self.assertAlmostEqual(tens / trials, 16 / 52, delta=0.01)


class PurchaseListingTests(unittest.TestCase):
    UID = 700

    def setUp(self):
        STORE.files.clear()
        STORE.uploaded.clear()

    def buy(self, charge_id, amount=10):
        self.assertTrue(payments.save_purchase(
            user_id=self.UID, amount=amount, currency="XTR",
            charge_id=charge_id, payload="topup"))

    def test_new_purchase_is_found_behind_a_long_credited_history(self):
        old = [f"charge-{i:04d}" for i in range(250)]
        for charge in old:
            self.buy(charge)
        self.buy("zzz-new")  # sorts after the old files in the listing
        known = {payments._safe_part(c, "x") for c in old}
        found = payments.purchases_excluding(self.UID, known)
        self.assertEqual([r["key"] for r in found], ["zzz-new"])
        self.assertEqual(found[0]["amount"], 10)

    def test_backlog_is_credited_oldest_first_and_in_batches(self):
        for i in range(payments.SYNC_LIMIT + 5):
            self.buy(f"b{i:04d}")
        first = payments.purchases_excluding(self.UID, set())
        self.assertEqual(len(first), payments.SYNC_LIMIT)
        self.assertNotIn("b%04d" % (payments.SYNC_LIMIT + 4), [r["key"] for r in first])
        rest = payments.purchases_excluding(self.UID, {r["key"] for r in first})
        self.assertEqual(len(rest), 5)

    def test_recent_purchase_listed_even_with_a_long_history(self):
        for i in range(130):
            self.buy(f"charge-{i:04d}")
        self.buy("zzz-latest")
        listed = payments.list_purchases(self.UID)
        self.assertEqual(len(listed), payments.MAX_PURCHASES)
        self.assertEqual(listed[0]["charge_id"], "zzz-latest")

    def test_other_users_files_are_ignored(self):
        self.buy("mine")
        payments.save_purchase(user_id=701, amount=99, currency="XTR",
                               charge_id="theirs", payload="topup")
        self.assertEqual([r["key"] for r in payments.purchases_excluding(self.UID, set())], ["mine"])


class SessionSecretTests(unittest.TestCase):
    def env(self, **values):
        import os
        from unittest import mock
        base = {"SESSION_SECRET": "", "WEBHOOK_SECRET": "", "BOT_TOKEN": "", "SESSION_REJECT_LEGACY": ""}
        base.update(values)
        return mock.patch.dict(os.environ, base)

    def test_new_tokens_use_the_dedicated_secret(self):
        with self.env(SESSION_SECRET="dedicated", WEBHOOK_SECRET="hook", BOT_TOKEN="bot"):
            token = payments.create_session_token(42)
            self.assertEqual(payments.validate_session_token(token), 42)
        with self.env(WEBHOOK_SECRET="hook", BOT_TOKEN="bot"):
            self.assertIsNone(payments.validate_session_token(token))

    def test_legacy_tokens_stay_valid_after_setting_the_secret(self):
        with self.env(WEBHOOK_SECRET="hook", BOT_TOKEN="bot"):
            legacy = payments.create_session_token(7)
        with self.env(SESSION_SECRET="dedicated", WEBHOOK_SECRET="hook", BOT_TOKEN="bot"):
            self.assertEqual(payments.validate_session_token(legacy), 7)
        with self.env(SESSION_SECRET="dedicated", WEBHOOK_SECRET="hook", BOT_TOKEN="bot",
                      SESSION_REJECT_LEGACY="1"):
            self.assertIsNone(payments.validate_session_token(legacy))

    def test_legacy_rejection_needs_a_dedicated_secret(self):
        with self.env(WEBHOOK_SECRET="hook", SESSION_REJECT_LEGACY="1"):
            token = payments.create_session_token(9)
            self.assertEqual(payments.validate_session_token(token), 9)

    def test_tampered_and_malformed_tokens_are_rejected(self):
        with self.env(SESSION_SECRET="dedicated"):
            token = payments.create_session_token(5)
            body, sig = token.split(".")
            self.assertIsNone(payments.validate_session_token(body + "." + "0" * len(sig)))
            self.assertIsNone(payments.validate_session_token(body + ".\u043f\u043e\u0434\u043f\u0438\u0441\u044c"))
            self.assertIsNone(payments.validate_session_token("\u0442\u043e\u043a\u0435\u043d." + sig))
            self.assertIsNone(payments.validate_session_token(""))

    def test_no_secret_means_no_tokens(self):
        with self.env():
            with self.assertRaises(payments.PaymentStorageError):
                payments.create_session_token(1)
            self.assertIsNone(payments.validate_session_token("a.b"))


class WebhookAuthTests(unittest.TestCase):
    def setUp(self):
        import os
        os.environ.setdefault("BOT_TOKEN", "test-token")
        from api import telegram
        self.authorize = telegram.authorize

    def test_refuses_everything_without_a_secret(self):
        self.assertEqual(self.authorize("", ""), (503, "webhook_not_configured"))
        self.assertEqual(self.authorize("anything", "   "), (503, "webhook_not_configured"))

    def test_rejects_wrong_or_missing_header(self):
        self.assertEqual(self.authorize("", "s3cret"), (403, "forbidden"))
        self.assertEqual(self.authorize("nope", "s3cret"), (403, "forbidden"))

    def test_accepts_matching_secret_including_non_ascii(self):
        self.assertIsNone(self.authorize("s3cret", "s3cret"))
        self.assertIsNone(self.authorize("пароль", " пароль "))


if __name__ == "__main__":
    unittest.main()
