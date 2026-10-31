"""Retry protection, stake limit and rate limit of the KAZ engine."""

import unittest

from test_server import STORE  # installs the in-memory fake blob store

from kaz import engine, store  # noqa: E402
from kaz.store import GameError  # noqa: E402


def give(uid, amount):
    def apply(doc):
        doc["balance"] = amount
        return None, True

    store.transact(uid, apply)


class RetryProtectionTests(unittest.TestCase):
    def setUp(self):
        STORE.files.clear()

    def test_retried_request_returns_the_first_result(self):
        give(1, 1000)
        first = engine.run(1, "slots.spin", {"bet": 10, "reqId": "retry-0001"})
        again = engine.run(1, "slots.spin", {"bet": 10, "reqId": "retry-0001"})
        self.assertNotIn("replayed", first)
        self.assertTrue(again["replayed"])
        self.assertEqual(again["result"], first["result"])
        self.assertEqual(again["state"]["games"], 1)
        self.assertEqual(again["state"]["balance"], first["state"]["balance"])

    def test_new_request_id_plays_a_new_round(self):
        give(2, 1000)
        engine.run(2, "slots.spin", {"bet": 10, "reqId": "round-0001"})
        second = engine.run(2, "slots.spin", {"bet": 10, "reqId": "round-0002"})
        self.assertNotIn("replayed", second)
        self.assertEqual(second["state"]["games"], 2)

    def test_requests_without_id_or_with_bad_id_still_work(self):
        give(3, 1000)
        engine.run(3, "slots.spin", {"bet": 10})
        engine.run(3, "slots.spin", {"bet": 10, "reqId": "x"})
        engine.run(3, "slots.spin", {"bet": 10, "reqId": "x"})
        self.assertEqual(engine.run(3, "state", {})["state"]["games"], 3)

    def test_retried_withdrawal_is_reserved_once(self):
        give(4, 2000)
        first = engine.run(4, "withdraw.request", {"amount": 500, "reqId": "withdraw-1"})
        again = engine.run(4, "withdraw.request", {"amount": 500, "reqId": "withdraw-1"})
        self.assertTrue(again["replayed"])
        self.assertEqual(again["result"]["withdrawal"]["id"], first["result"]["withdrawal"]["id"])
        self.assertEqual(again["state"]["balance"], 1500)
        self.assertEqual(len(again["state"]["withdrawals"]), 1)

    def test_only_recent_results_are_kept(self):
        give(5, 100_000)
        for index in range(engine.SEEN_LIMIT + 3):
            engine.run(5, "slots.spin", {"bet": 1, "reqId": f"spin-{index:04d}"})
        doc = store.read_doc(5)
        self.assertEqual(len(doc["seen"]), engine.SEEN_LIMIT)


class LimitTests(unittest.TestCase):
    def setUp(self):
        STORE.files.clear()

    def test_stake_above_the_limit_is_refused(self):
        give(10, 5_000_000)
        with self.assertRaises(GameError) as ctx:
            engine.run(10, "slots.spin", {"bet": engine.MAX_STAKE + 1})
        self.assertEqual(ctx.exception.code, "bet_limit")
        with self.assertRaises(GameError) as ctx:
            engine.run(10, "roulette.spin", {"bets": {"red": 60_000, "black": 60_000}})
        self.assertEqual(ctx.exception.code, "bet_limit")
        self.assertEqual(engine.run(10, "state", {})["state"]["balance"], 5_000_000)

    def test_stake_at_the_limit_is_allowed(self):
        give(11, 5_000_000)
        out = engine.run(11, "slots.spin", {"bet": engine.MAX_STAKE})
        self.assertEqual(out["state"]["wagered"], engine.MAX_STAKE)

    def test_garbage_bets_are_left_to_the_game(self):
        give(12, 1000)
        for params in ({"bet": "x"}, {"bet": None}, {"bets": {"red": "x"}}, {"bets": []}):
            action = "roulette.spin" if "bets" in params else "slots.spin"
            with self.assertRaises(GameError) as ctx:
                engine.run(12, action, params)
            self.assertNotEqual(ctx.exception.code, "bet_limit")

    def test_too_many_actions_in_a_row_are_slowed_down(self):
        give(13, 1_000_000)
        for _ in range(engine.RATE_MAX_ACTIONS):
            engine.run(13, "slots.spin", {"bet": 1})
        with self.assertRaises(GameError) as ctx:
            engine.run(13, "slots.spin", {"bet": 1})
        self.assertEqual(ctx.exception.code, "rate_limited")
        self.assertEqual(ctx.exception.status, 429)
        # reading the state is never limited
        self.assertEqual(engine.run(13, "state", {})["state"]["games"], engine.RATE_MAX_ACTIONS)

    def test_the_limit_resets_after_the_window(self):
        give(14, 1_000_000)
        for _ in range(engine.RATE_MAX_ACTIONS):
            engine.run(14, "slots.spin", {"bet": 1})

        def age(doc):
            doc["rl"]["t"] -= engine.RATE_WINDOW_MS + 1
            return None, True

        store.transact(14, age)
        engine.run(14, "slots.spin", {"bet": 1})

    def test_other_players_are_not_affected(self):
        give(15, 1_000_000)
        give(16, 1000)
        for _ in range(engine.RATE_MAX_ACTIONS):
            engine.run(15, "slots.spin", {"bet": 1})
        engine.run(16, "slots.spin", {"bet": 1})


if __name__ == "__main__":
    unittest.main()
