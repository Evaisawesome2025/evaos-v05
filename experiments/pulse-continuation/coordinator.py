"""Manually stepped, finite UNSCORED sandbox run. No scheduler or provider client."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import time
import uuid

from continuation import Exchange, ExchangeError, tick
from pulse.model import Corrupt, digest
from pulse.principal import Principal, validate_state
from pulse.store import Store

LABEL = 'UNSCORED_LOCAL_FINITE_RUN'


class RunError(Exception):
    pass


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def coordinator_hash():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


class Coordinator:
    def __init__(self, directory, clock=None):
        self.directory = Path(directory).resolve()
        self.clock = clock or time.time
        self.exchange = Exchange(self.directory)
        self.store = Store(self.directory / 'finite-run')
        with self.store.connect() as db:
            db.execute('BEGIN')
            state = self.store._read(db)
            self.anchor = json.loads(db.execute('SELECT body FROM events WHERE seq=1').fetchone()[0])['details']['objective']
        self.binding = {**self.exchange.binding, 'coordinator_sha256': coordinator_hash()}
        self._validate(state)

    @classmethod
    def initialize(cls, directory, max_wakes, duration_seconds, scenario='baseline', clock=None):
        clock = clock or time.time
        now = clock()
        if (type(max_wakes) is not int or not 1 <= max_wakes <= 100
                or not finite(duration_seconds) or not 0 < duration_seconds <= 86400
                or not finite(now) or now <= 0 or not finite(now + duration_seconds)
                or now + duration_seconds <= now):
            raise RunError('INVALID_FINITE_RUN_CONFIG')
        Principal.initialize(directory, scenario=scenario)
        exchange = Exchange(directory)
        binding = {**exchange.binding, 'coordinator_sha256': coordinator_hash()}
        view = cls.principal_view(exchange.principal)
        anchor = {'run_id': uuid.uuid4().hex, 'max_wakes': max_wakes,
                  'created_at': now, 'deadline': now + duration_seconds,
                  'binding': binding, 'initial_principal': view,
                  'initial_exchange': cls.describe_exchange(exchange)}
        Store.create(Path(directory) / 'finite-run', {
            'objective': anchor, 'observed_time': now, 'expected_principal': view,
            'exchange_checkpoint': anchor['initial_exchange'],
            'attempts': [], 'stop': None, 'proof_status': LABEL})
        return cls(directory, clock=clock)

    @staticmethod
    def principal_view(principal):
        # State and its journal anchor come from one SQLite read transaction.
        with principal.store.connect() as db:
            db.execute('BEGIN')
            state = principal.store._read(db)
            validate_state(state)
            seq, checksum = db.execute('SELECT seq,hash FROM events ORDER BY seq DESC LIMIT 1').fetchone()
        return {'objective': state['objective'], 'state_digest': digest(state),
                'journal_seq': seq, 'journal_hash': checksum}

    def _now(self):
        now = self.clock()
        if not finite(now) or now <= 0:
            raise RunError('INVALID_CLOCK')
        return now

    def _validate(self, state):
        if (coordinator_hash() != self.binding['coordinator_sha256']
                or self.anchor.get('binding') != self.binding):
            raise RunError('RUN_BINDING_CHANGED')
        try:
            if (state['objective'] != self.anchor or state['proof_status'] != LABEL
                    or state['code_hash'] != self.binding['controller_code_hash']):
                raise ValueError('configuration changed')
            config = self.anchor
            if (type(config['max_wakes']) is not int or not 1 <= config['max_wakes'] <= 100
                    or not finite(config['created_at']) or not finite(config['deadline'])
                    or not config['created_at'] < config['deadline'] <= config['created_at'] + 86400
                    or not finite(state['observed_time']) or state['observed_time'] < config['created_at']):
                raise ValueError('invalid configuration or clock')
            expected = config['initial_principal']
            expected_exchange = config['initial_exchange']
            attempts = state['attempts']
            if not isinstance(attempts, list) or len(attempts) > config['max_wakes']:
                raise ValueError('budget')
            for number, attempt in enumerate(attempts, 1):
                fields = {k: attempt[k] for k in ('run_id', 'number', 'at', 'before', 'exchange')}
                if (attempt['number'] != number or attempt['run_id'] != config['run_id']
                        or attempt['before'] != expected or attempt['reservation_id'] != digest(fields)
                        or not self.permitted_delivery(expected_exchange, attempt['exchange'])
                        or not finite(attempt['at']) or not config['created_at'] <= attempt['at'] < config['deadline']):
                    raise ValueError('attempt binding')
                result = attempt['result']
                expected_exchange = attempt['exchange']
                if result is None:
                    if number != len(attempts):
                        raise ValueError('unresolved predecessor')
                else:
                    if (result['reservation_id'] != attempt['reservation_id']
                            or result['result_digest'] != digest({k: v for k, v in result.items() if k != 'result_digest'})):
                        raise ValueError('result binding')
                    expected = result['after']
                    expected_exchange = result['exchange']
            if state['expected_principal'] != expected:
                raise ValueError('principal checkpoint')
            checkpoint = state['exchange_checkpoint']
            if (checkpoint['digest'] != digest(checkpoint['records'])
                    or not self.permitted_delivery(expected_exchange, checkpoint)):
                raise ValueError('exchange checkpoint')
            if state['stop'] is not None and (not isinstance(state['stop'], dict)
                                             or not isinstance(state['stop'].get('reason'), str)):
                raise ValueError('stop')
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise RunError('RUN_RECORD_DAMAGED') from exc

    def _mutate(self, operation):
        def guarded(state, emit):
            self._validate(state)
            result = operation(state, emit)
            self._validate(state)
            return result
        return self.store.mutate(guarded)

    def snapshot(self):
        state = self.store.read()
        self._validate(state)
        return state

    @staticmethod
    def summary(state, status, **details):
        return {'status': status, 'run_id': state['objective']['run_id'],
                'wakes_used': len(state['attempts']),
                'wakes_remaining': state['objective']['max_wakes'] - len(state['attempts']),
                'deadline': state['objective']['deadline'], 'stop': state['stop'],
                'proof_status': LABEL, **details}

    def _stop(self, state, emit, reason, **details):
        state['stop'] = {'reason': reason, **details}
        emit('RUN_STOPPED', stop=state['stop'])
        return self.summary(state, 'STOP_' + reason)

    @staticmethod
    def describe_exchange(exchange):
        exchange.reconcile()
        rows = exchange.records()
        requests, unknown_jobs, unknown_consumption, current = [], [], [], []
        for kind, rid in rows:
            if kind != 'request':
                continue
            q = exchange.request(rows, rid)
            response = exchange.response(rows, rid)
            consumed = exchange.validate_consumption(rows, rid)
            launch = rows.get(('launch', rid))
            ref = {'request_id': rid, 'packet_digest': q['packet_digest'],
                   'input_sha256': q['input_sha256'],
                   'launch_id': launch['launch_id'] if launch else None,
                   'output_sha256': rows['response', rid]['output_sha256'] if response is not None else None}
            requests.append(ref)
            if launch and response is None:
                unknown_jobs.append(ref)  # Includes stale requests: a job may still exist.
            if consumed is not None and ('outcome', rid) not in rows:
                unknown_consumption.append(ref)
            try:
                exchange.require_current(q)
            except ExchangeError as exc:
                if str(exc) != 'STALE_REQUEST':
                    raise
                continue
            current.append({**ref, 'resolved': ('outcome', rid) in rows,
                            'has_response': response is not None})
        records = [{'kind': k, 'id': i, 'digest': digest(v)} for (k, i), v in sorted(rows.items())]
        return {'digest': digest(records), 'records': records, 'requests': requests, 'unknown_jobs': unknown_jobs,
                'unknown_consumption': unknown_consumption, 'current': current}

    def exchange_view(self):
        return self.describe_exchange(self.exchange)

    @staticmethod
    def permitted_delivery(before, after):
        old = {(r['kind'], r['id']): r['digest'] for r in before['records']}
        new = {(r['kind'], r['id']): r['digest'] for r in after['records']}
        eligible = {q['request_id'] for q in before['current']
                    if not q['resolved'] and q['output_sha256'] is None}
        return (all(new.get(key) == value for key, value in old.items())
                and all(kind in {'launch', 'response'} and rid in eligible
                        for kind, rid in new.keys() - old.keys()))

    def _reserve(self):
        def op(state, emit):
            if state['stop'] is not None:
                return self.summary(state, 'STOP_' + state['stop']['reason'])
            now = self._now()
            if now < state['observed_time']:
                return self._stop(state, emit, 'CLOCK_REGRESSION')
            state['observed_time'] = now
            if state['attempts'] and state['attempts'][-1]['result'] is None:
                emit('RUN_PAUSED', reason='WAKE_OUTCOME_UNKNOWN')
                return self.summary(state, 'WAKE_OUTCOME_UNKNOWN')
            if now >= state['objective']['deadline']:
                return self._stop(state, emit, 'DEADLINE')
            if len(state['attempts']) >= state['objective']['max_wakes']:
                return self._stop(state, emit, 'BUDGET')
            before = self.principal_view(self.exchange.principal)
            if before != state['expected_principal']:
                return self._stop(state, emit, 'PRINCIPAL_CHANGED', observed=before)
            head = before['objective']
            if head['status'] in {'COMPLETE', 'BLOCKED', 'CORRUPT'}:
                return self._stop(state, emit, head['status'])
            principal = self.exchange.principal.snapshot()
            if principal['lease'] or head['active_turn'] or head['recovery_needed']:
                return self._stop(state, emit, 'PRINCIPAL_RECOVERY_REQUIRED')
            exchange = self.exchange_view()
            if not self.permitted_delivery(state['exchange_checkpoint'], exchange):
                return self._stop(state, emit, 'EXCHANGE_CHANGED', observed_digest=exchange['digest'])
            state['exchange_checkpoint'] = exchange
            if exchange['unknown_jobs']:
                emit('RUN_PAUSED', reason='PROVIDER_RESULT_UNKNOWN', jobs=exchange['unknown_jobs'])
                return self.summary(state, 'PROVIDER_RESULT_UNKNOWN', jobs=exchange['unknown_jobs'])
            if exchange['unknown_consumption']:
                return self._stop(state, emit, 'CONSUMPTION_REQUIRES_REVIEW')
            if head['status'] == 'WAITING' and head['next_evaluation_after'] > now:
                emit('RUN_PAUSED', reason='WAIT', retry_at=head['next_evaluation_after'])
                return self.summary(state, 'WAIT', retry_at=head['next_evaluation_after'])
            if any(q['resolved'] for q in exchange['current']):
                return self._stop(state, emit, 'RESOLVED_RESPONSE_REQUIRES_REVIEW')
            if exchange['current'] and not any(q['has_response'] for q in exchange['current']):
                emit('RUN_PAUSED', reason='AWAITING_DISPATCH', requests=exchange['current'])
                return self.summary(state, 'AWAITING_DISPATCH', requests=exchange['current'])
            fields = {'run_id': state['objective']['run_id'], 'number': len(state['attempts']) + 1,
                      'at': now, 'before': before, 'exchange': exchange}
            attempt = {**fields, 'reservation_id': digest(fields), 'result': None}
            state['attempts'].append(attempt)
            emit('WAKE_RESERVED', reservation=fields, reservation_id=attempt['reservation_id'])
            return self.summary(state, 'RESERVED', attempt=attempt)
        return self._mutate(op)

    def _finish(self, attempt, outcome, forced_stop=None):
        after = self.principal_view(self.exchange.principal)
        exchange = self.exchange_view()
        def op(state, emit):
            now = self._now()  # Observe under the run lock, after competing observers.
            last = state['attempts'][-1]
            if last['reservation_id'] != attempt['reservation_id'] or last['result'] is not None:
                raise RunError('ACKNOWLEDGMENT_CONFLICT')
            result = {'reservation_id': attempt['reservation_id'], 'after': after,
                      'exchange': exchange, 'at': now, 'tick': outcome}
            result['result_digest'] = digest(result)
            last['result'] = result
            state['expected_principal'] = after
            state['exchange_checkpoint'] = exchange
            emit('WAKE_RESULT_RECORDED', result=result)
            forced_stop = ('CLOCK_REGRESSION' if now < state['observed_time'] else stop_reason)
            state['observed_time'] = max(now, state['observed_time'])
            if state['stop'] is not None:
                return self.summary(state, 'STOP_' + state['stop']['reason'])
            if forced_stop:
                return self._stop(state, emit, forced_stop)
            if after['objective']['status'] in {'COMPLETE', 'BLOCKED', 'CORRUPT'}:
                return self._stop(state, emit, after['objective']['status'])
            if now >= state['objective']['deadline']:
                return self._stop(state, emit, 'DEADLINE')
            if len(state['attempts']) >= state['objective']['max_wakes']:
                return self._stop(state, emit, 'BUDGET')
            return self.summary(state, 'TICK_RECORDED', outcome=outcome['outcome'])
        stop_reason = forced_stop
        if outcome.get('state_digest', after['state_digest']) != after['state_digest']:
            stop_reason = 'PRINCIPAL_CHANGED_DURING_TICK'
        if 'state_digest' in outcome:
            with self.exchange.principal.store.connect() as db:
                events = [json.loads(body) for (body,) in db.execute(
                    'SELECT body FROM events WHERE seq>? AND seq<=? ORDER BY seq',
                    (attempt['before']['journal_seq'], after['journal_seq']))]
            wakes = [event for event in events if event['event'] == 'WAKE_SEEN']
            if len(wakes) != 1 or wakes[0]['details']['pid'] != os.getpid():
                stop_reason = 'PRINCIPAL_CHANGED_DURING_TICK'
        return self._mutate(op)

    def _preflight(self, attempt):
        def op(state, emit):
            if state['stop'] is not None:
                return state['stop']['reason']
            now = self._now()
            changed = self.principal_view(self.exchange.principal) != attempt['before']
            changed = changed or self.exchange_view() != attempt['exchange']
            reason = ('CLOCK_REGRESSION' if now < state['observed_time'] else
                      'DEADLINE' if now >= self.anchor['deadline'] else
                      'EVIDENCE_CHANGED_BEFORE_TICK' if changed else None)
            state['observed_time'] = max(now, state['observed_time'])
            emit('WAKE_CHECKED', reservation_id=attempt['reservation_id'], reason=reason)
            return reason
        return self._mutate(op)

    def step(self, crash=None):
        reserved = self._reserve()
        if reserved['status'] != 'RESERVED':
            return reserved
        attempt = reserved['attempt']
        if crash == 'after_reservation':
            os._exit(81)
        # Recheck after the durable commit: queued work can miss its deadline.
        reason = self._preflight(attempt)
        if reason:
            return self._finish(attempt, {'outcome': 'NOT_STARTED'}, forced_stop=reason)
        try:
            result = tick(self.directory)
        except Exception as exc:
            return self._finish(attempt, {'outcome': 'TICK_ERROR', 'error_type': type(exc).__name__},
                                forced_stop='TICK_REQUIRES_REVIEW')
        if crash == 'after_tick':
            os._exit(82)
        return self._finish(attempt, {k: result[k] for k in ('outcome', 'state_digest', 'calls')})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('directory')
    init.add_argument('--max-wakes', type=int, required=True)
    init.add_argument('--duration-seconds', type=float, required=True)
    init.add_argument('--scenario', choices=['baseline', 'defect_repair'], default='baseline')
    step = sub.add_parser('step'); step.add_argument('directory')
    step.add_argument('--crash', choices=['after_reservation', 'after_tick'])
    show = sub.add_parser('show'); show.add_argument('directory')
    args = parser.parse_args()
    try:
        if args.command == 'init':
            run = Coordinator.initialize(args.directory, args.max_wakes, args.duration_seconds, args.scenario)
            result = run.summary(run.snapshot(), 'INITIALIZED')
        else:
            run = Coordinator(args.directory)
            result = run.step(args.crash) if args.command == 'step' else run.snapshot()
        print(json.dumps(result, allow_nan=False))
    except (RunError, ExchangeError, Corrupt) as exc:
        print(json.dumps({'status': 'RUN_REJECTED', 'reason': str(exc), 'proof_status': LABEL}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
