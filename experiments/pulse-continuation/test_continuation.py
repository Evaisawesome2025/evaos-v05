"""Synthetic adapter mechanics. Fixture proposals are never model/autonomy evidence."""
import concurrent.futures
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from continuation import Exchange, ExchangeError, tick, strict_json
from pulse.fixtures import FixturePlanner
from pulse.model import canonical, digest
from pulse.principal import Principal

ROOT = Path(__file__).resolve().parent


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)/'state'
        Principal.initialize(self.state,scenario='defect_repair',lease_seconds=0.25)
        self.exchange = Exchange(self.state)

    def cli(self,*args,success=True):
        r=subprocess.run([sys.executable,'-B',str(ROOT/'continuation.py'),*map(str,args)],capture_output=True,text=True)
        if success:self.assertEqual(r.returncode,0,r.stderr+r.stdout)
        return r

    def prepare(self):
        result=tick(self.state)
        self.assertEqual(result['outcome'],'WAITING_FOR_PLANNER')
        return self.exchange.describe()[-1]

    def reply(self,q,raw=None):
        raw=raw or canonical(FixturePlanner().propose(q['packet'])).encode()
        self.exchange.record_launch(q['request_id'],q['input_sha256'],'TEST_FIXTURE:'+q['request_id'])
        return self.exchange.deliver(q['request_id'],q['input_sha256'],'TEST_FIXTURE:'+q['request_id'],raw)

    def test_wait_survives_restart_without_lease_or_turn(self):
        q=self.prepare();s=Principal(self.state).snapshot()
        self.assertIsNone(s['lease']);self.assertEqual(s['turns'],{})
        result=json.loads(self.cli('tick',self.state).stdout)
        self.assertEqual(result['request_id'],q['request_id'])
        self.assertEqual(len(Exchange(self.state).describe()),1)
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)

    def test_response_survives_restart_and_drives_unchanged_controller(self):
        q=self.prepare();self.reply(q)
        r=json.loads(self.cli('tick',self.state).stdout)
        self.assertEqual(r['outcome'],'PASS');self.assertEqual(r['objective']['generation'],1)
        self.assertEqual(Exchange(self.state).describe()[0]['status'],'RESOLVED')

    def test_duplicate_delivery_idempotent_conflict_rejected(self):
        q=self.prepare();self.reply(q)
        self.assertEqual(self.reply(q),'ALREADY_RECORDED')
        bad=FixturePlanner().propose(q['packet']);bad['why_now']='changed bytes'
        with self.assertRaisesRegex(ExchangeError,'RESPONSE_CONFLICT'):self.reply(q,canonical(bad).encode())
        self.assertEqual(tick(self.state)['outcome'],'PASS')
        self.assertEqual(self.reply(q),'ALREADY_RECORDED')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],1)

    def test_launch_unknown_never_automatically_reissued(self):
        q=self.prepare()
        self.exchange.record_launch(q['request_id'],q['input_sha256'],'fixture-launch')
        for _ in range(2):self.cli('tick',self.state)
        self.assertEqual(self.exchange.describe()[0]['status'],'DISPATCH_RECORDED_RESULT_UNKNOWN')
        with self.assertRaisesRegex(ExchangeError,'LAUNCH_ALREADY_RECORDED'):
            self.exchange.record_launch(q['request_id'],q['input_sha256'],'second-launch')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)

    def test_wrong_request_input_and_launch_binding_rejected(self):
        q=self.prepare();self.exchange.record_launch(q['request_id'],q['input_sha256'],'fixture')
        raw=canonical(FixturePlanner().propose(q['packet'])).encode()
        for rid,sha,launch,reason in [('missing',q['input_sha256'],'fixture','UNKNOWN_REQUEST'),
                (q['request_id'],'bad','fixture','INPUT_BINDING_MISMATCH'),
                (q['request_id'],q['input_sha256'],'wrong','LAUNCH_BINDING_MISMATCH')]:
            with self.assertRaisesRegex(ExchangeError,reason):self.exchange.deliver(rid,sha,launch,raw)
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)

    def test_strict_json_rejects_ambiguous_and_noncanonical_values(self):
        for raw in [b'{"kind":"ACTION","kind":"BLOCK"}',b'{"x":NaN}',b'{"x":Infinity}',
                    b'{"x":"\xff"}',b'[]',b'{',b'{"x":"\\ud800"}',b'x'*131073]:
            with self.subTest(raw=raw[:40]),self.assertRaises(ExchangeError):strict_json(raw)

    def test_malformed_model_schema_rejected_without_tick_or_worker(self):
        q=self.prepare();self.exchange.record_launch(q['request_id'],q['input_sha256'],'fixture')
        before=Principal(self.state).snapshot()
        examples=[{'kind':[]},{'kind':'ACTION','slot_id':[]},
                  {'kind':'WAIT','reason':'x','retry_after_seconds':True},
                  {'kind':'BLOCK','reason':'x','surprise':'extra'}]
        for obj in examples:
            with self.subTest(obj=obj),self.assertRaisesRegex(ExchangeError,'INVALID_MODEL_SCHEMA'):
                self.exchange.deliver(q['request_id'],q['input_sha256'],'fixture',canonical(obj).encode())
        self.assertEqual(Principal(self.state).snapshot(),before)

    def test_checksummed_wrong_inner_request_id_detected_before_mutation(self):
        q=self.prepare();self.reply(q);before=Principal(self.state).snapshot()
        with sqlite3.connect(self.exchange.path) as db:
            db.execute('DROP TRIGGER no_record_update')
            obj=json.loads(db.execute("SELECT body FROM records WHERE kind='response'").fetchone()[0])
            obj['request_id']='other-request';body=canonical(obj)
            import hashlib
            db.execute("UPDATE records SET body=?,hash=? WHERE kind='response'",(body,hashlib.sha256(body.encode()).hexdigest()))
        with self.assertRaisesRegex(ExchangeError,'RESPONSE_BINDING_DAMAGED'):tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(),before)

    def test_stale_response_rejected_after_authoritative_control_change(self):
        q=self.prepare();self.exchange.record_launch(q['request_id'],q['input_sha256'],'fixture')
        p=Principal(self.state);token=p.acquire(p.get_head()['version'])['token']
        bundle=p.build_planning_packet(token)
        p.decision(token,bundle['packet_digest'],{'kind':'BLOCK','reason':'synthetic owner-review stop'})
        p.release(token)
        with self.assertRaisesRegex(ExchangeError,'STALE_REQUEST'):
            self.exchange.deliver(q['request_id'],q['input_sha256'],'fixture',b'{"kind":"COMPLETE","reason":"old"}')
        self.assertEqual(tick(self.state)['outcome'],'SLEEP_BLOCKED')

    def test_concurrent_duplicate_ticks_and_deliveries_do_not_duplicate_work(self):
        q=self.prepare();self.reply(q)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            replies=list(pool.map(lambda _:self.reply(q),range(2)))
        self.assertEqual(replies,['ALREADY_RECORDED','ALREADY_RECORDED'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(lambda _:json.loads(self.cli('tick',self.state).stdout)['outcome'],range(2)))
        self.assertIn('PASS',outcomes)
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],1)

    def test_crash_after_request_expires_then_recovers_without_work(self):
        r=self.cli('tick',self.state,'--crash','after_request',success=False);self.assertEqual(r.returncode,71)
        self.assertEqual(len(self.exchange.describe()),1)
        time.sleep(0.3)
        self.assertEqual(tick(self.state)['outcome'],'RECOVERY_REQUIRED')
        self.assertEqual(tick(self.state)['outcome'],'RECOVERED')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)
        self.assertEqual(self.exchange.describe()[0]['status'],'STALE_NO_EXECUTION')

    def test_crash_after_response_read_never_reuses_stale_response(self):
        q=self.prepare();self.reply(q)
        r=self.cli('tick',self.state,'--crash','after_response',success=False);self.assertEqual(r.returncode,72)
        time.sleep(0.3)
        self.assertEqual(tick(self.state)['outcome'],'RECOVERY_REQUIRED')
        self.assertEqual(tick(self.state)['outcome'],'RECOVERED')
        new=self.prepare();self.assertNotEqual(new['request_id'],q['request_id'])
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)

    def test_crash_after_start_blocks_without_replaying_worker(self):
        q=self.prepare();self.reply(q)
        r=self.cli('tick',self.state,'--crash','after_start',success=False);self.assertEqual(r.returncode,70)
        time.sleep(0.3)
        self.assertEqual(tick(self.state)['outcome'],'RECOVERY_REQUIRED')
        self.assertEqual(tick(self.state)['outcome'],'RECOVERED_BLOCKED')
        self.assertEqual(tick(self.state)['outcome'],'SLEEP_BLOCKED')
        s=Principal(self.state).snapshot()
        self.assertEqual(s['calls']['worker'],1);self.assertEqual(s['objective']['generation'],0)
        self.assertEqual(next(iter(s['receipts'].values()))['verdict'],'FAIL')

    def test_crash_after_verification_reconciles_receipt_without_replay(self):
        q=self.prepare();self.reply(q)
        r=self.cli('tick',self.state,'--crash','after_controller_return',success=False);self.assertEqual(r.returncode,73)
        self.assertEqual(Principal(self.state).snapshot()['objective']['generation'],1)
        self.assertEqual(self.exchange.describe()[0]['status'],'RESOLVED')
        self.assertEqual(tick(self.state)['outcome'],'WAITING_FOR_PLANNER')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],1)

    def test_damaged_response_detected_before_principal_mutation(self):
        q=self.prepare();self.reply(q);before=Principal(self.state).snapshot()
        with sqlite3.connect(self.exchange.path) as db:
            db.execute('DROP TRIGGER no_record_update')
            db.execute("UPDATE records SET body='{}' WHERE kind='response'")
        with self.assertRaisesRegex(ExchangeError,'EXCHANGE_RECORD_DAMAGED'):tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(),before)

    def test_empty_rehashed_response_is_damage_not_missing(self):
        q=self.prepare();self.reply(q);before=Principal(self.state).snapshot()
        with sqlite3.connect(self.exchange.path) as db:
            db.execute('DROP TRIGGER no_record_update')
            import hashlib
            db.execute("UPDATE records SET body='{}',hash=? WHERE kind='response'",(hashlib.sha256(b'{}').hexdigest(),))
        with self.assertRaisesRegex(ExchangeError,'RESPONSE_BINDING_DAMAGED'):tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(),before)

    def test_modified_adapter_binding_rejected_before_principal_mutation(self):
        self.prepare();before=Principal(self.state).snapshot()
        with sqlite3.connect(self.exchange.path) as db:
            db.execute('DROP TRIGGER no_record_update')
            body=json.loads(db.execute("SELECT body FROM records WHERE kind='binding'").fetchone()[0])
            body['adapter_code_hash']='different'
            text=canonical(body)
            import hashlib
            db.execute("UPDATE records SET body=?,hash=? WHERE kind='binding'",(text,hashlib.sha256(text.encode()).hexdigest()))
        with self.assertRaisesRegex(ExchangeError,'EXCHANGE_BINDING_CHANGED'):tick(self.state)
        self.assertEqual(Principal(self.state).snapshot(),before)

    def test_bad_admission_result_latched_without_repeated_turns(self):
        q=self.prepare();bad=FixturePlanner().propose(q['packet']);bad['expected_effects']='SEND'
        self.reply(q,canonical(bad).encode())
        self.assertEqual(tick(self.state)['outcome'],'REJECT_AUTHORITY_OR_ACTION')
        with self.assertRaisesRegex(ExchangeError,'RESOLVED_RESPONSE_REQUIRES_REVIEW'):tick(self.state)
        self.assertEqual(Principal(self.state).snapshot()['turns'],{})

    def test_control_commit_reconciles_after_ack_crash(self):
        q=self.prepare();self.reply(q,b'{"kind":"BLOCK","reason":"synthetic boundary"}')
        r=self.cli('tick',self.state,'--crash','after_controller_return',success=False)
        self.assertEqual(r.returncode,73)
        first=self.exchange.describe()[0]
        self.assertEqual(first['status'],'RESOLVED')
        self.assertEqual(first['outcome']['disposition'],'BLOCK')
        self.assertEqual(tick(self.state)['outcome'],'SLEEP_BLOCKED')
        self.assertEqual(Principal(self.state).snapshot()['calls']['worker'],0)

    def test_amended_repair_stages_with_explicit_extra_waiting_ticks(self):
        outcomes=[];waiting=0
        for _ in range(5):
            q=self.prepare();waiting+=1;self.reply(q)
            outcomes.append(tick(self.state)['outcome'])
        outcomes.append(tick(self.state)['outcome'])
        self.assertEqual(outcomes,['PASS','PASS','FAIL','PASS','PASS','SLEEP_COMPLETE'])
        s=Principal(self.state).snapshot()
        self.assertEqual(s['objective']['generation'],4);self.assertEqual(s['objective']['version'],5)
        self.assertEqual(s['calls'],{'planner':10,'worker':5,'verifier':5})
        self.assertEqual(waiting,5) # Eleven actual ticks; not a six-scheduled-wake proof.


if __name__=='__main__':unittest.main(verbosity=2)
