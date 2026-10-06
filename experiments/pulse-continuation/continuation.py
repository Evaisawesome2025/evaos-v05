"""Durable LOCAL planner exchange. No scheduler, provider client, or trusted seal."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

from pulse.controller import wake
from pulse.model import canonical, code_hash, digest
from pulse.principal import Principal, verified_analyses

PROTOCOL = Path(__file__).with_name('planner-protocol.txt')
MAX_OUTPUT = 131072


class ExchangeError(Exception):
    pass


class Pending(Exception):
    def __init__(self, request_id):
        self.request_id = request_id


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(raw):
    if len(raw) > MAX_OUTPUT:
        raise ExchangeError('OUTPUT_TOO_LARGE')
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError('duplicate key')
            obj[key] = value
        return obj
    try:
        obj = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        canonical(obj).encode('utf-8')
        if not isinstance(obj, dict):
            raise ValueError('object required')
        return obj
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ExchangeError('INVALID_MODEL_JSON') from exc


def model_proposal(raw):
    obj = strict_json(raw)
    kind = obj.get('kind')
    if not isinstance(kind, str):
        raise ExchangeError('INVALID_MODEL_SCHEMA')
    if kind == 'ACTION':
        required = {'kind','slot_id','action','why_now','objective_delta','authority_required','expected_effects'}
        valid = (set(obj) == required and isinstance(obj['slot_id'],str)
                 and isinstance(obj['action'],dict) and isinstance(obj['authority_required'],dict)
                 and all(isinstance(obj[k],str) and obj[k].strip()
                         for k in ['slot_id','why_now','objective_delta','expected_effects']))
    elif kind in {'WAIT','BLOCK','COMPLETE'}:
        valid = set(obj) == ({'kind','reason','retry_after_seconds'} if kind == 'WAIT' else {'kind','reason'})
        valid = valid and isinstance(obj.get('reason'),str) and bool(obj['reason'].strip())
        if kind == 'WAIT':
            delay = obj.get('retry_after_seconds')
            valid = valid and type(delay) in (int,float) and 0 < delay <= 86400
    else:
        valid = False
    if not valid:
        raise ExchangeError('INVALID_MODEL_SCHEMA')
    return obj


class Exchange:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.principal = Principal(self.directory)
        state = self.principal.snapshot()
        if state['code_hash'] != code_hash():
            raise ExchangeError('CONTROLLER_CODE_CHANGED')
        with self.principal.store.connect() as db:
            identity = db.execute('SELECT hash FROM events WHERE seq=1').fetchone()[0]
        self.binding = {'state_identity': identity, 'controller_code_hash': code_hash(),
                        'adapter_code_hash': sha(Path(__file__).read_bytes()),
                        'protocol_sha256': sha(PROTOCOL.read_bytes())}
        self.path = self.directory / 'planner-exchange.sqlite3'
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS records (
                    kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
                    hash TEXT NOT NULL, created_at REAL NOT NULL,
                    PRIMARY KEY(kind,id));
                CREATE TRIGGER IF NOT EXISTS no_record_update BEFORE UPDATE ON records
                    BEGIN SELECT RAISE(ABORT,'immutable exchange record'); END;
                CREATE TRIGGER IF NOT EXISTS no_record_delete BEFORE DELETE ON records
                    BEGIN SELECT RAISE(ABORT,'immutable exchange record'); END;
            ''')
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            if ('binding', 'binding') in rows:
                if rows['binding', 'binding'] != self.binding:
                    raise ExchangeError('EXCHANGE_BINDING_CHANGED')
            else:
                if rows:
                    raise ExchangeError('MISSING_EXCHANGE_BINDING')
                self.insert(db, 'binding', 'binding', self.binding)

    @contextlib.contextmanager
    def connect(self):
        if (sha(Path(__file__).read_bytes()) != self.binding['adapter_code_hash']
                or sha(PROTOCOL.read_bytes()) != self.binding['protocol_sha256']
                or code_hash() != self.binding['controller_code_hash']):
            raise ExchangeError('LIVE_CODE_OR_PROTOCOL_CHANGED')
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('PRAGMA synchronous=FULL')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def read_all(db):
        result = {}
        for kind, key, body, checksum in db.execute('SELECT kind,id,body,hash FROM records ORDER BY created_at,rowid'):
            if sha(body.encode()) != checksum:
                raise ExchangeError('EXCHANGE_RECORD_DAMAGED')
            try:
                value = json.loads(body)
                if canonical(value) != body:
                    raise ValueError('not canonical')
            except (ValueError, TypeError, UnicodeError) as exc:
                raise ExchangeError('EXCHANGE_RECORD_DAMAGED') from exc
            result[kind, key] = value
        return result

    @staticmethod
    def insert(db, kind, key, value):
        body = canonical(value)
        db.execute('INSERT INTO records VALUES(?,?,?,?,?)',
                   (kind, key, body, sha(body.encode()), time.time()))

    def records(self):
        with self.connect() as db:
            db.execute('BEGIN')
            return self.read_all(db)

    def ensure_request(self, packet):
        text = PROTOCOL.read_text() + canonical(packet)
        key_fields = {**self.binding, 'packet_digest': digest(packet),
                      'input_sha256': sha(text.encode())}
        rid = digest(key_fields)
        request = {**key_fields, 'request_id': rid, 'packet': packet, 'input_text': text}
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            if ('request', rid) in rows:
                if rows['request', rid] != request:
                    raise ExchangeError('REQUEST_CONFLICT')
            else:
                self.insert(db, 'request', rid, request)
        return request

    def request(self, rows, rid):
        if ('request', rid) not in rows:
            raise ExchangeError('UNKNOWN_REQUEST')
        try:
            q = rows['request', rid]
            key_fields = {**self.binding, 'packet_digest': digest(q['packet']),
                          'input_sha256': sha(q['input_text'].encode())}
            if (q['request_id'] != rid or digest(key_fields) != rid
                    or any(q[k] != v for k, v in key_fields.items())
                    or q['input_text'] != PROTOCOL.read_text() + canonical(q['packet'])):
                raise ExchangeError('REQUEST_BINDING_DAMAGED')
        except (KeyError,TypeError,AttributeError,ValueError,UnicodeError) as exc:
            raise ExchangeError('REQUEST_BINDING_DAMAGED') from exc
        return q

    @staticmethod
    def validate_launch(q, launch):
        if (not isinstance(launch,dict) or launch.get('request_id') != q['request_id']
                or launch.get('input_sha256') != q['input_sha256']
                or not isinstance(launch.get('launch_id'),str) or not launch['launch_id'].strip()):
            raise ExchangeError('LAUNCH_BINDING_DAMAGED')

    def require_current(self, q):
        state = self.principal.snapshot()
        packet = q['packet']
        if (state['objective'] != packet['objective']
                or state['catalog'] != packet['catalog']
                or verified_analyses(state) != packet['verified_analyses']):
            raise ExchangeError('STALE_REQUEST')

    def record_launch(self, rid, input_sha256, launch_id):
        if not isinstance(launch_id, str) or not launch_id.strip():
            raise ExchangeError('INVALID_LAUNCH_ID')
        launch = {'request_id': rid, 'input_sha256': input_sha256, 'launch_id': launch_id}
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            q = self.request(rows, rid)
            if q['input_sha256'] != input_sha256:
                raise ExchangeError('INPUT_BINDING_MISMATCH')
            if ('launch', rid) in rows:
                if rows['launch', rid] != launch:
                    raise ExchangeError('LAUNCH_ALREADY_RECORDED')
                return 'ALREADY_RECORDED_NO_RELAUNCH'
            self.require_current(q)
            self.insert(db, 'launch', rid, launch)
        return 'RECORDED_LOCAL_DISPATCH_INTENT'

    def deliver(self, rid, input_sha256, launch_id, raw):
        model_proposal(raw)
        value = {'request_id': rid, 'input_sha256': input_sha256, 'launch_id': launch_id,
                 'output_sha256': sha(raw), 'raw_output': raw.decode('utf-8')}
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            q = self.request(rows, rid)
            if q['input_sha256'] != input_sha256:
                raise ExchangeError('INPUT_BINDING_MISMATCH')
            launch = rows.get(('launch', rid))
            if not launch or launch['launch_id'] != launch_id:
                raise ExchangeError('LAUNCH_BINDING_MISMATCH')
            self.validate_launch(q, launch)
            if ('response', rid) in rows:
                if rows['response', rid] != value:
                    raise ExchangeError('RESPONSE_CONFLICT')
                return 'ALREADY_RECORDED'
            self.require_current(q)
            self.insert(db, 'response', rid, value)
        return 'RESPONSE_RECORDED'

    def response(self, rows, rid):
        q = self.request(rows, rid)
        if ('response', rid) not in rows:
            if ('launch',rid) in rows:
                self.validate_launch(q, rows['launch',rid])
            return None
        value = rows['response', rid]
        if not isinstance(value,dict) or not value:
            raise ExchangeError('RESPONSE_BINDING_DAMAGED')
        launch = rows.get(('launch', rid))
        self.validate_launch(q, launch)
        try:
            if (value['request_id'] != rid or value['launch_id'] != launch['launch_id']
                    or value['input_sha256'] != q['input_sha256']
                    or value['output_sha256'] != sha(value['raw_output'].encode())):
                raise ExchangeError('RESPONSE_BINDING_DAMAGED')
            return model_proposal(value['raw_output'].encode())
        except (KeyError,TypeError,AttributeError,ValueError,UnicodeError) as exc:
            raise ExchangeError('RESPONSE_BINDING_DAMAGED') from exc

    def outcome(self, rid, value):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            if ('outcome', rid) in rows:
                return rows['outcome', rid]
            self.insert(db, 'outcome', rid, value)
        return value

    def consumption_binding(self, rows, rid):
        q = self.request(rows, rid)
        if self.response(rows, rid) is None:
            raise ExchangeError('CONSUMPTION_WITHOUT_RESPONSE')
        response = rows['response', rid]
        return {**self.binding, 'request_id': rid, 'packet_digest': q['packet_digest'],
                'input_sha256': q['input_sha256'], 'launch_id': response['launch_id'],
                'output_sha256': response['output_sha256']}

    def validate_consumption(self, rows, rid):
        if ('consumption', rid) not in rows:
            return None
        expected = self.consumption_binding(rows, rid)
        if rows['consumption', rid] != expected:
            raise ExchangeError('CONSUMPTION_BINDING_DAMAGED')
        return expected

    def consume(self, rid):
        # Commit before returning a response to the controller. A missing outcome
        # is uncertainty, never permission to submit the response a second time.
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = self.read_all(db)
            q = self.request(rows, rid)
            proposal = self.response(rows, rid)
            consumed = self.validate_consumption(rows, rid)
            if ('outcome', rid) in rows:
                raise ExchangeError('RESOLVED_RESPONSE_REQUIRES_REVIEW')
            if consumed is not None:
                raise ExchangeError('CONSUMPTION_REQUIRES_REVIEW')
            if proposal is None:
                raise Pending(rid)
            self.require_current(q)
            self.insert(db, 'consumption', rid, self.consumption_binding(rows, rid))
        return proposal

    def check_unresolved_consumption(self):
        rows = self.records()
        state = self.principal.snapshot()
        for kind, rid in rows:
            if kind != 'consumption':
                continue
            self.validate_consumption(rows, rid)
            if ('outcome', rid) in rows:
                continue
            try:
                self.require_current(self.request(rows, rid))
            except ExchangeError as exc:
                if str(exc) != 'STALE_REQUEST':
                    raise
                continue  # Original recovery has invalidated this old packet.
            if not (state['lease'] or state['objective']['recovery_needed']
                    or state['objective']['active_turn']):
                raise ExchangeError('CONSUMPTION_REQUIRES_REVIEW')
            # Existing principal fencing/recovery must run before any new plan.

    def reconcile(self):
        state = self.principal.snapshot()
        with self.principal.store.connect() as db:
            decisions = [(json.loads(body), checksum) for body, checksum in
                         db.execute('SELECT body,hash FROM events')
                         if json.loads(body)['event'] == 'PLANNER_DECISION']
        # Consumption commits before any controller evidence. Read exchange rows
        # after the principal evidence so a concurrent receipt cannot outrun the
        # claim snapshot and appear falsely unbound. Rows are append-only.
        rows = self.records()
        for (kind, rid), q in rows.items():
            if kind != 'request':
                continue
            q = self.request(rows, rid)
            proposal = self.response(rows, rid)
            consumed = self.validate_consumption(rows, rid)
            for tid, turn in state['turns'].items():
                if turn['packet_digest'] != q['packet_digest'] or tid not in state['receipts']:
                    continue
                if proposal is None or consumed is None:
                    raise ExchangeError('UNBOUND_PRINCIPAL_RECEIPT')
                envelope = turn['envelope']
                for a, b in [('slot_id','slot_id'),('action','action'),('why_now','why_now'),
                             ('objective_delta','objective_delta'),('authority_required','authority'),
                             ('expected_effects','expected_effects')]:
                    if proposal.get(a) != envelope[b]:
                        raise ExchangeError('RECEIPT_PROPOSAL_MISMATCH')
                self.outcome(rid, {'disposition':state['receipts'][tid]['verdict'],
                                  'turn_id':tid, 'receipt':state['receipts'][tid]})
            for event, checksum in decisions:
                details = event['details']
                old = q['packet']['objective']
                new = details['objective']
                if (proposal is not None and consumed is not None and details['proposal'] == proposal
                        and new['objective_id'] == old['objective_id']
                        and new['version'] == old['version'] + 1
                        and new['generation'] == old['generation']
                        and new['last_verified_turn'] == old['last_verified_turn']):
                    self.outcome(rid, {'disposition':proposal['kind'],
                                      'decision_event_hash':checksum})

    def describe(self):
        self.reconcile()
        rows = self.records()
        result = []
        for kind, rid in rows:
            if kind != 'request':
                continue
            q = self.request(rows, rid)
            status = ('RESOLVED' if ('outcome',rid) in rows else
                      'CONSUMPTION_RECORDED_OUTCOME_UNKNOWN' if ('consumption',rid) in rows else
                      'RESPONSE_READY' if ('response',rid) in rows else
                      'DISPATCH_RECORDED_RESULT_UNKNOWN' if ('launch',rid) in rows else 'READY_FOR_LAUNCH')
            try:
                self.require_current(q)
            except ExchangeError:
                if status != 'RESOLVED':
                    status = 'STALE_NO_EXECUTION'
            result.append({**q,'status':status,'launch':rows.get(('launch',rid)),
                           'outcome':rows.get(('outcome',rid))})
        return result


class DurablePlanner:
    def __init__(self, exchange, crash=None):
        self.exchange, self.crash, self.last_request = exchange, crash, None

    def propose(self, packet):
        q = self.exchange.ensure_request(packet)
        rid = self.last_request = q['request_id']
        if self.crash == 'after_request':
            os._exit(71)
        proposal = self.exchange.consume(rid)
        if self.crash == 'after_response':
            os._exit(72)
        return proposal


def tick(directory, crash=None):
    exchange = Exchange(directory)  # Check binding/integrity before principal mutation.
    exchange.reconcile()
    exchange.check_unresolved_consumption()
    planner = DurablePlanner(exchange, crash)
    try:
        result = wake(directory, planner=planner, crash_after_start=crash == 'after_start')
    except Pending as exc:
        result = {'outcome':'WAITING_FOR_PLANNER', 'request_id':exc.request_id}
    if crash == 'after_controller_return':
        os._exit(73)
    exchange.reconcile()
    if planner.last_request and result['outcome'] != 'WAITING_FOR_PLANNER':
        exchange.outcome(planner.last_request, {'disposition':result['outcome']})
    export = exchange.principal.store.export()
    state = exchange.principal.snapshot()
    return {**result, 'objective':state['objective'], 'calls':state['calls'],
            'state_digest':digest(state), 'journal':export, 'pid':os.getpid(),
            'proof_status':'UNSCORED_LOCAL_DURABLE_EXCHANGE'}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('directory')
    init.add_argument('--scenario', choices=['baseline','defect_repair'],default='baseline')
    init.add_argument('--lease-seconds',type=float,default=900)
    step = sub.add_parser('tick'); step.add_argument('directory')
    step.add_argument('--crash', choices=['after_request','after_response','after_start','after_controller_return'])
    show = sub.add_parser('requests'); show.add_argument('directory')
    for name in ['record-launch','deliver']:
        p = sub.add_parser(name); p.add_argument('directory'); p.add_argument('request_id')
        p.add_argument('input_sha256'); p.add_argument('launch_id')
    args = ap.parse_args()
    try:
        if args.command == 'init':
            Principal.initialize(args.directory,args.scenario,args.lease_seconds)
            Exchange(args.directory)
            result = {'outcome':'INITIALIZED','proof_status':'UNSCORED'}
        elif args.command == 'tick': result = tick(args.directory,args.crash)
        elif args.command == 'requests': result = Exchange(args.directory).describe()
        elif args.command == 'record-launch':
            result = {'outcome':Exchange(args.directory).record_launch(args.request_id,args.input_sha256,args.launch_id)}
        else:
            result = {'outcome':Exchange(args.directory).deliver(args.request_id,args.input_sha256,args.launch_id,sys.stdin.buffer.read(MAX_OUTPUT+1))}
        print(json.dumps(result,ensure_ascii=False,allow_nan=False))
    except ExchangeError as exc:
        print(json.dumps({'outcome':'EXCHANGE_REJECTED','reason':str(exc),'proof_status':'UNSCORED'}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
