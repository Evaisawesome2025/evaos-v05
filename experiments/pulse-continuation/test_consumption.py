"""Synthetic interruption regressions; not scheduler, model, or autonomy proof."""
import concurrent.futures
import hashlib
import json
import sqlite3
import unittest

from continuation import Exchange, ExchangeError, tick
from pulse.fixtures import FixturePlanner
from pulse.model import canonical
from pulse.principal import Principal
import test_continuation


class ConsumptionTests(unittest.TestCase):
    setUp = test_continuation.ContinuationTests.setUp
    cli = test_continuation.ContinuationTests.cli
    prepare = test_continuation.ContinuationTests.prepare
    reply = test_continuation.ContinuationTests.reply

    def test_rejected_responses_not_resubmitted_after_ack_loss(self):
        for kind in ('ACTION', 'COMPLETE'):
            with self.subTest(kind=kind):
                self.setUp()
                q = self.prepare()
                obj = FixturePlanner().propose(q['packet']) if kind == 'ACTION' else {
                    'kind': 'COMPLETE', 'reason': 'synthetic premature completion'}
                if kind == 'ACTION':
                    obj['expected_effects'] = 'SEND'
                self.reply(q, canonical(obj).encode())
                self.assertEqual(self.cli('tick', self.state, '--crash',
                                         'after_controller_return', success=False).returncode, 73)
                before = Principal(self.state).snapshot()
                events = Principal(self.state).store.stream()
                self.assertEqual(self.exchange.describe()[0]['status'],
                                 'CONSUMPTION_RECORDED_OUTCOME_UNKNOWN')
                for _ in range(2):
                    with self.assertRaisesRegex(ExchangeError, 'CONSUMPTION_REQUIRES_REVIEW'):
                        tick(self.state)
                self.assertEqual(Principal(self.state).snapshot(), before)
                self.assertEqual(Principal(self.state).store.stream(), events)
                self.assertEqual(before['calls']['worker'], 0)
                self.assertEqual(before['objective']['status'], 'OPEN')

    def test_claim_without_return_never_submits_response(self):
        q = self.prepare(); self.reply(q)
        self.exchange.consume(q['request_id'])
        before = Principal(self.state).snapshot()
        with self.assertRaisesRegex(ExchangeError, 'CONSUMPTION_REQUIRES_REVIEW'):
            tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(), before)
        self.assertEqual(self.reply(q), 'ALREADY_RECORDED')

    def test_concurrent_claim_has_exactly_one_winner(self):
        q = self.prepare(); self.reply(q)
        def attempt(_):
            try:
                Exchange(self.state).consume(q['request_id'])
                return 'CLAIMED'
            except ExchangeError as exc:
                return str(exc)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(attempt, range(6)))
        self.assertEqual(results.count('CLAIMED'), 1)
        self.assertEqual(results.count('CONSUMPTION_REQUIRES_REVIEW'), 5)
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'], 0)

    def test_claim_binds_exact_response_and_detects_rehashed_damage(self):
        q = self.prepare(); self.reply(q); self.exchange.consume(q['request_id'])
        before = Principal(self.state).snapshot()
        with sqlite3.connect(self.exchange.path) as db:
            db.execute('DROP TRIGGER no_record_update')
            value = json.loads(db.execute("SELECT body FROM records WHERE kind='consumption'").fetchone()[0])
            value['output_sha256'] = 'wrong'
            body = canonical(value)
            db.execute("UPDATE records SET body=?,hash=? WHERE kind='consumption'",
                       (body, hashlib.sha256(body.encode()).hexdigest()))
        with self.assertRaisesRegex(ExchangeError, 'CONSUMPTION_BINDING_DAMAGED'):
            tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_wait_ack_loss_reconciles_and_preserves_deadline(self):
        q = self.prepare()
        self.reply(q, b'{"kind":"WAIT","reason":"synthetic dependency","retry_after_seconds":60}')
        self.assertEqual(self.cli('tick', self.state, '--crash',
                                 'after_controller_return', success=False).returncode, 73)
        self.assertEqual(self.exchange.describe()[0]['outcome']['disposition'], 'WAIT')
        before = Principal(self.state).snapshot()
        result = tick(self.state)
        after = Principal(self.state).snapshot()
        self.assertEqual(result['outcome'], 'SLEEP_WAITING')
        self.assertEqual(after['objective']['next_evaluation_after'], before['objective']['next_evaluation_after'])
        self.assertEqual(after['calls'], before['calls'])
        self.assertEqual(after['calls']['worker'], 0)

    def test_concurrent_receipt_cannot_outrun_claim_snapshot(self):
        q = self.prepare(); self.reply(q)
        original = self.exchange.records
        def snapshot_then_competing_tick():
            rows = original()
            self.exchange.records = original
            self.assertEqual(tick(self.state)['outcome'], 'PASS')
            return rows
        self.exchange.records = snapshot_then_competing_tick
        self.exchange.reconcile()
        self.assertEqual(self.exchange.describe()[0]['status'], 'RESOLVED')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
