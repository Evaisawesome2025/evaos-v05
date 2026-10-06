"""Simulated time/provider and local fault tests. No scheduler or model is run."""
import concurrent.futures
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import coordinator
from coordinator import Coordinator, RunError
from continuation import Exchange, tick
from pulse.fixtures import FixturePlanner
from pulse.model import canonical
from pulse.principal import Principal

ROOT = Path(__file__).resolve().parent


class SimulatedClock:
    def __init__(self):
        self.now = time.time()
    def __call__(self):
        return self.now


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'

    def new(self, budget=10, seconds=3600, clock=None, scenario='baseline'):
        return Coordinator.initialize(self.state, budget, seconds, scenario, clock)

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(ROOT / 'coordinator.py'),
                               *map(str, args)], capture_output=True, text=True)

    def request(self):
        return Exchange(self.state).describe()[-1]

    def reply(self, obj=None):
        q = self.request(); exchange = Exchange(self.state)
        output = obj if obj is not None else FixturePlanner().propose(q['packet'])
        launch = 'SIMULATED_PROVIDER:' + q['request_id']
        exchange.record_launch(q['request_id'], q['input_sha256'], launch)
        exchange.deliver(q['request_id'], q['input_sha256'], launch, canonical(output).encode())
        return q

    def test_invalid_config_rejected_before_creating_state(self):
        for budget, duration in [(0, 10), (101, 10), (True, 10), (1, True),
                                 (1, float('nan')), (1, float('inf')), (1, 0), (1, 86401)]:
            with self.subTest(budget=budget, duration=duration), self.assertRaises(RunError):
                self.new(budget, duration)
            self.assertFalse(self.state.exists())

    def test_fixed_config_survives_restart_and_no_reinitialize(self):
        run = self.new(); before = run.snapshot()['objective']
        self.assertEqual(Coordinator(self.state).snapshot()['objective'], before)
        with self.assertRaises(FileExistsError):
            self.new()

    def test_waiting_dispatch_and_unknown_job_do_not_spend_wakes(self):
        run = self.new(); run.step(); q = self.request()
        before = Principal(self.state).snapshot()
        self.assertEqual(run.step()['status'], 'AWAITING_DISPATCH')
        Exchange(self.state).record_launch(q['request_id'], q['input_sha256'], 'SIMULATED_UNKNOWN_JOB')
        for _ in range(3):
            result = Coordinator(self.state).step()
            self.assertEqual(result['status'], 'PROVIDER_RESULT_UNKNOWN')
            self.assertEqual(result['wakes_used'], 1)
        self.assertEqual(Principal(self.state).snapshot(), before)
        raw = canonical(FixturePlanner().propose(q['packet'])).encode()
        Exchange(self.state).deliver(q['request_id'], q['input_sha256'], 'SIMULATED_UNKNOWN_JOB', raw)
        self.assertEqual(run.step()['outcome'], 'PASS')
        self.assertEqual(run.snapshot()['attempts'][-1]['before']['objective']['version'], 0)
        self.assertEqual(run.snapshot()['expected_principal']['objective']['version'], 1)

    def test_budget_persists_with_concurrent_processes(self):
        self.new(budget=1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            replies = list(pool.map(lambda _: self.cli('step', self.state), range(5)))
        self.assertTrue(all(r.returncode == 0 for r in replies), [r.stderr for r in replies])
        run = Coordinator(self.state)
        self.assertEqual(len(run.snapshot()['attempts']), 1)
        self.assertEqual(run.step()['status'], 'STOP_BUDGET')
        self.assertEqual(Principal(self.state).snapshot()['calls'], {'planner': 1, 'worker': 0, 'verifier': 0})

    def test_deadline_sticky_before_first_wake(self):
        clock = SimulatedClock(); run = self.new(clock=clock, seconds=10)
        before = Principal(self.state).snapshot()
        clock.now += 10
        self.assertEqual(run.step()['status'], 'STOP_DEADLINE')
        clock.now -= 5
        self.assertEqual(Coordinator(self.state, clock).step()['status'], 'STOP_DEADLINE')
        self.assertEqual(Principal(self.state).snapshot(), before)
        self.assertEqual(len(run.snapshot()['attempts']), 0)

    def test_deadline_after_reservation_charges_without_starting(self):
        clock = SimulatedClock(); run = self.new(clock=clock, seconds=10)
        original = run._reserve
        def delayed_admission():
            result = original(); clock.now += 10; return result
        run._reserve = delayed_admission
        self.assertEqual(run.step()['status'], 'STOP_DEADLINE')
        self.assertEqual(len(run.snapshot()['attempts']), 1)
        self.assertEqual(run.snapshot()['attempts'][0]['result']['tick']['outcome'], 'NOT_STARTED')
        self.assertEqual(Principal(self.state).snapshot()['calls']['planner'], 0)

    def test_clock_rollback_after_paused_observation_stops(self):
        clock = SimulatedClock(); run = self.new(clock=clock); run.step()
        clock.now += 20
        self.assertEqual(run.step()['status'], 'AWAITING_DISPATCH')
        clock.now -= 1
        self.assertEqual(Coordinator(self.state, clock).step()['status'], 'STOP_CLOCK_REGRESSION')
        self.assertEqual(len(run.snapshot()['attempts']), 1)

    def test_wait_deadline_uses_simulated_time_without_extra_wakes(self):
        clock = SimulatedClock(); run = self.new(clock=clock); run.step()
        self.reply({'kind': 'WAIT', 'reason': 'simulated dependency', 'retry_after_seconds': 60})
        with patch('time.time', clock):
            self.assertEqual(run.step()['outcome'], 'WAIT')
            before = Principal(self.state).snapshot()
            clock.now += 59
            self.assertEqual(run.step()['status'], 'WAIT')
            self.assertEqual(Principal(self.state).snapshot(), before)
            self.assertEqual(len(run.snapshot()['attempts']), 2)
            clock.now += 1
            self.assertEqual(run.step()['outcome'], 'WAITING_FOR_PLANNER')
        self.assertEqual(len(run.snapshot()['attempts']), 3)
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'], 0)

    def test_block_stops_and_complete_requires_verified_evidence(self):
        run = self.new(); run.step()
        self.reply({'kind': 'BLOCK', 'reason': 'simulated owner boundary'})
        self.assertEqual(run.step()['status'], 'STOP_BLOCKED')
        before = Principal(self.state).snapshot()
        self.assertEqual(Coordinator(self.state).step()['status'], 'STOP_BLOCKED')
        self.assertEqual(Principal(self.state).snapshot(), before)
        self.assertEqual(before['calls']['worker'], 0)

    def test_premature_complete_does_not_complete_or_retry(self):
        run = self.new(); run.step()
        self.reply({'kind': 'COMPLETE', 'reason': 'simulated unsupported completion'})
        self.assertEqual(run.step()['outcome'], 'REJECT_UNPROVEN_COMPLETE')
        before = Principal(self.state).snapshot()
        self.assertEqual(run.step()['status'], 'STOP_RESOLVED_RESPONSE_REQUIRES_REVIEW')
        self.assertEqual(Principal(self.state).snapshot(), before)
        self.assertEqual(before['objective']['status'], 'OPEN')
        self.assertEqual(before['calls']['worker'], 0)

    def test_verified_completion_stops_at_finite_budget(self):
        run = self.new(budget=8)
        for number in range(4):
            self.assertEqual(run.step()['outcome'], 'WAITING_FOR_PLANNER')
            self.reply(); result = run.step()
        self.assertEqual(result['status'], 'STOP_COMPLETE')
        self.assertEqual(result['wakes_used'], 8)
        before = Principal(self.state).snapshot()
        self.assertEqual(run.step()['status'], 'STOP_COMPLETE')
        self.assertEqual(Principal(self.state).snapshot(), before)
        self.assertEqual(before['calls']['worker'], 4)

    def test_crash_after_reservation_never_refunds_or_repeats(self):
        run = self.new()
        result = self.cli('step', self.state, '--crash', 'after_reservation')
        self.assertEqual(result.returncode, 81)
        before = Principal(self.state).snapshot()
        self.assertEqual(Coordinator(self.state).step()['status'], 'WAKE_OUTCOME_UNKNOWN')
        self.assertEqual(len(run.snapshot()['attempts']), 1)
        self.assertIsNone(run.snapshot()['attempts'][0]['result'])
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_crash_after_worker_receipt_never_repeats_attempt(self):
        run = self.new(); run.step(); self.reply()
        self.assertEqual(self.cli('step', self.state, '--crash', 'after_tick').returncode, 82)
        before = Principal(self.state).snapshot()
        self.assertEqual(Coordinator(self.state).step()['status'], 'WAKE_OUTCOME_UNKNOWN')
        self.assertEqual(len(run.snapshot()['attempts']), 2)
        self.assertIsNone(run.snapshot()['attempts'][-1]['result'])
        self.assertEqual(before['calls']['worker'], 1)
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_unrelated_exchange_request_stops_before_reservation(self):
        run = self.new(); run.step(); q = self.request()
        packet = copy.deepcopy(q['packet']); packet['budget']['max_actions_per_wake'] = 99
        exchange = Exchange(self.state); other = exchange.ensure_request(packet)
        exchange.record_launch(other['request_id'], other['input_sha256'], 'SIMULATED_UNRELATED')
        exchange.deliver(other['request_id'], other['input_sha256'], 'SIMULATED_UNRELATED',
                         canonical(FixturePlanner().propose(packet)).encode())
        before = Principal(self.state).snapshot()
        self.assertEqual(run.step()['status'], 'STOP_EXCHANGE_CHANGED')
        self.assertEqual(len(run.snapshot()['attempts']), 1)
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_outside_tick_drift_fails_closed(self):
        run = self.new(); tick(self.state)
        before = Principal(self.state).snapshot()
        self.assertEqual(run.step()['status'], 'STOP_PRINCIPAL_CHANGED')
        self.assertEqual(len(run.snapshot()['attempts']), 0)
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_principal_change_between_admission_and_tick_is_not_executed(self):
        run = self.new(); original = run._reserve
        def intervening_tick():
            result = original(); tick(self.state); return result
        run._reserve = intervening_tick
        self.assertEqual(run.step()['status'], 'STOP_EVIDENCE_CHANGED_BEFORE_TICK')
        self.assertEqual(Principal(self.state).snapshot()['calls']['planner'], 1)
        self.assertEqual(run.snapshot()['attempts'][0]['result']['tick']['outcome'], 'NOT_STARTED')

    def test_outside_tick_inside_unsupported_boundary_stops_after_detection(self):
        run = self.new(); original = coordinator.tick
        def bypass_then_tick(directory):
            original(directory)
            return original(directory)
        with patch('coordinator.tick', bypass_then_tick):
            self.assertEqual(run.step()['status'], 'STOP_PRINCIPAL_CHANGED_DURING_TICK')
        self.assertEqual(len(run.snapshot()['attempts']), 1)
        self.assertEqual(Principal(self.state).snapshot()['calls']['planner'], 2)

    def test_config_and_result_damage_fail_closed(self):
        run = self.new(); run.step()
        def damage(state, emit):
            state['attempts'][0]['result']['reservation_id'] = 'unrelated'
            emit('SIMULATED_RECORD_FAULT')
        run.store.mutate(damage)
        before = Principal(self.state).snapshot()
        with self.assertRaisesRegex(RunError, 'RUN_RECORD_DAMAGED'):
            Coordinator(self.state).step()
        self.assertEqual(Principal(self.state).snapshot(), before)

    def test_configuration_anchor_and_code_binding_reject_changes(self):
        run = self.new()
        with patch('coordinator.coordinator_hash', return_value='changed-code'):
            with self.assertRaisesRegex(RunError, 'RUN_BINDING_CHANGED'):
                Coordinator(self.state)
        def change_budget(state, emit):
            state['objective']['max_wakes'] = 99
            emit('SIMULATED_CONFIG_FAULT')
        run.store.mutate(change_budget)
        with self.assertRaisesRegex(RunError, 'RUN_RECORD_DAMAGED'):
            Coordinator(self.state)

    def test_rebound_checkpoint_cannot_authorize_unrelated_exchange(self):
        run = self.new(); run.step(); q = self.request()
        packet = copy.deepcopy(q['packet']); packet['budget']['max_actions_per_wake'] = 99
        exchange = Exchange(self.state); other = exchange.ensure_request(packet)
        exchange.record_launch(other['request_id'], other['input_sha256'], 'SIMULATED_CHECKPOINT_FAULT')
        exchange.deliver(other['request_id'], other['input_sha256'], 'SIMULATED_CHECKPOINT_FAULT',
                         canonical(FixturePlanner().propose(packet)).encode())
        def damage(state, emit):
            state['exchange_checkpoint'] = run.exchange_view()
            emit('SIMULATED_REHASHED_CHECKPOINT_FAULT')
        run.store.mutate(damage)
        before = Principal(self.state).snapshot()
        with self.assertRaisesRegex(RunError, 'RUN_RECORD_DAMAGED'):
            Coordinator(self.state).step()
        self.assertEqual(Principal(self.state).snapshot(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
