#!/usr/bin/env python3
"""Stage a Worker version, then deploy without changing script-level settings.
Raw settings stay in memory. Default is read-only. Rollback selects the actual
captured version; no whole-script PUT, settings PATCH, credentials changes or force.
"""
import argparse, datetime, email, email.policy, hashlib, json, os, pathlib, sys
import urllib.error, urllib.request, uuid
ROOT = pathlib.Path(__file__).resolve().parents[1]
ACCOUNT = 'ce3e6fa9fccf82aeeb61119930c1c1a7'
BASE = 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/workers/scripts/evaos-v05-ask'
FILES = ['src/release.js','src/brief.js','src/brief-model.js','preserved/deployed-514bf8c7.js']
SCRIPT_KEYS = {'logpush','observability','tags','tail_consumers'}
class ReleaseError(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None

def request(path, method='GET', data=None, content_type=None):
 if os.environ.get('CLOUDFLARE_ACCOUNT_ID') != ACCOUNT:
  raise ReleaseError('Configured account does not match the existing Worker account.')
 if not os.environ.get('HTTPS_PROXY') or not os.environ.get('CLOUDFLARE_API_TOKEN'):
  raise ReleaseError('Existing HTTPS proxy and credential environment are required.')
 if method != 'GET' and (method,path) not in {('POST','/versions'),('POST','/deployments')}:
  raise ReleaseError('Only version upload and deployment selection writes are allowed.')
 headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN']}
 if content_type: headers['Content-Type']=content_type
 req=urllib.request.Request(BASE+path,data=data,headers=headers,method=method)
 try:
  with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as r: return r.read(),r.headers
 except urllib.error.HTTPError as e:
  raise ReleaseError('HTTP %s for %s %s; no retry performed.' % (e.code,method,path)) from None
 except Exception:
  raise ReleaseError('Request failed; inspect state before further writes. Sensitive exception details omitted.') from None

def result(path,method='GET',data=None,content_type=None):
 body,_=request(path,method,data,content_type)
 try:
  value=json.loads(body)
  if not value.get('success'): raise ValueError()
  return value['result']
 except (ValueError,KeyError,TypeError):
  raise ReleaseError('API operation did not return a confirmed successful result.') from None

def fingerprint(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def current_deployment():
 d=result('/deployments')['deployments'][0]
 if len(d['versions'])!=1 or d['versions'][0]['percentage']!=100:
  raise ReleaseError('Concurrent or split deployment requires review.')
 return {'id':d['id'],'versions':d['versions']}

def version_id(deployment): return deployment['versions'][0]['version_id']

def code_hash():
 body,headers=request('')
 msg=email.message_from_bytes(('Content-Type: '+headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+body,policy=email.policy.default)
 if not msg.is_multipart(): return {'worker.js':hashlib.sha256(body).hexdigest()}
 return {p.get_filename() or p.get_param('name',header='content-disposition'):hashlib.sha256(p.get_payload(decode=True)).hexdigest() for p in msg.iter_parts()}

def read_state():
 deployment=current_deployment()
 state={'deployment':deployment,'settings':result('/settings'),'script_settings':result('/script-settings'),'code_hashes':code_hash()}
 if current_deployment()!=deployment: raise ReleaseError('Deployment changed during state capture.')
 return state

def require_state(state,deployment,settings_hash,script_hash,code_hashes):
 if state['deployment']!=deployment: raise ReleaseError('Concurrent deployment detected; refusing write.')
 if fingerprint(state['settings'])!=settings_hash: raise ReleaseError('Worker settings drift detected; refusing write.')
 if fingerprint(state['script_settings'])!=script_hash: raise ReleaseError('Script-level settings drift detected; refusing write.')
 if state['code_hashes']!=code_hashes: raise ReleaseError('Production module drift detected; refusing write.')

def resources_config(version):
 r=version['resources']
 return {'bindings':sorted(r['bindings'],key=lambda b:b['name']),'runtime':r['script_runtime']}

def version_metadata(settings,original_version,original_id):
 # Version-only API: script settings are outside the mutation set.
 metadata=dict(original_version['resources']['script_runtime'])
 for key in ['compatibility_date','compatibility_flags','usage_model','placement','limits','cache_options']:
  if settings.get(key) not in (None,[],{}): metadata[key]=settings[key]
 metadata['annotations']={k:v for k,v in settings.get('annotations',{}).items() if k!='workers/triggered_by'}
 metadata['main_module']=FILES[0]
 metadata['bindings']=[{'name':b['name'],'type':'inherit','version_id':original_id} for b in settings['bindings']]
 if SCRIPT_KEYS.intersection(metadata): raise ReleaseError('Script settings must not enter version metadata.')
 return metadata

def multipart(metadata,files):
 boundary='evaos-release-'+uuid.uuid4().hex;parts=[]
 def part(name,content,ctype,filename=None):
  disp='form-data; name="'+name+'"'+('; filename="'+filename+'"' if filename else '')
  parts.append(('--'+boundary+'\r\nContent-Disposition: '+disp+'\r\nContent-Type: '+ctype+'\r\n\r\n').encode()+content+b'\r\n')
 part('metadata',json.dumps(metadata).encode(),'application/json')
 for name,content in files.items(): part(name,content,'application/javascript+module',name)
 parts.append(('--'+boundary+'--\r\n').encode())
 return b''.join(parts),'multipart/form-data; boundary='+boundary

def select_version(target):
 # Never force: provider resource/secret rollback checks remain active.
 payload={'strategy':'percentage','versions':[{'version_id':target,'percentage':100}]}
 d=result('/deployments','POST',json.dumps(payload).encode(),'application/json')
 if d.get('versions')!=payload['versions'] or not d.get('id'):
  raise ReleaseError('Deployment identity uncertain; inspect state without repeating writes.')
 return {'id':d['id'],'versions':d['versions']}

def restore_version(baseline,owned,observed):
 # Refuse unknown versions and same-version script-setting/concurrent edits.
 require_state(read_state(),owned,fingerprint(observed['settings']),baseline['script_settings_sha256'],observed['code_hashes'])
 restored=select_version(version_id(baseline['deployments'][0]))
 require_state(read_state(),restored,baseline['settings_sha256'],baseline['script_settings_sha256'],baseline['current_module_hashes'])
 return restored

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--baseline',required=True);parser.add_argument('--output',required=True)
 parser.add_argument('--publish',action='store_true');parser.add_argument('--rollback',action='store_true')
 parser.add_argument('--expected-version');parser.add_argument('--release-evidence')
 args=parser.parse_args();baseline=json.loads(pathlib.Path(args.baseline).read_text())
 safe={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'published':False,'rollback':args.rollback,'write_attempted':False}
 def save(): pathlib.Path(args.output).write_text(json.dumps(safe,indent=2)+'\n')
 try:
  original_id=version_id(baseline['deployments'][0]);state=read_state()
  if args.rollback:
   if not args.expected_version or not args.release_evidence:
    raise ReleaseError('Rollback requires exact expected version and confirmed release evidence.')
   release=json.loads(pathlib.Path(args.release_evidence).read_text());owned=release['after_deployment']
   if version_id(owned)!=args.expected_version: raise ReleaseError('Rollback version differs from release evidence.')
   require_state(state,owned,baseline['settings_sha256'],baseline['script_settings_sha256'],release['files'])
   safe.update({'before_version':args.expected_version,'restore_version':original_id})
   if args.publish:
    safe['write_attempted']=True;save()
    safe['restored_deployment']=restore_version(baseline,owned,state);safe['rollback_verified']=True
   save();print(json.dumps(safe,indent=2));return
  require_state(state,baseline['deployments'][0],baseline['settings_sha256'],baseline['script_settings_sha256'],baseline['current_module_hashes'])
  files={name:(ROOT/name).read_bytes() for name in FILES}
  hashes={name:hashlib.sha256(content).hexdigest() for name,content in files.items()}
  if list(state['code_hashes'].values())!=[hashes[FILES[-1]]]:
   raise ReleaseError('Current production differs from preserved module; reconcile before release.')
  original=result('/versions/'+original_id)
  if original.get('id')!=original_id: raise ReleaseError('Captured version identity is not confirmed.')
  metadata=version_metadata(state['settings'],original,original_id)
  safe.update({'before_version':original_id,'settings_sha256':baseline['settings_sha256'],'script_settings_sha256':baseline['script_settings_sha256'],'files':hashes,'baseline_code_verified':True,'rollback_method':'select_captured_version_without_force','script_settings_write_scope':'none'})
  if not args.publish: save();print(json.dumps(safe,indent=2));return
  data,ctype=multipart(metadata,files)
  require_state(read_state(),baseline['deployments'][0],baseline['settings_sha256'],baseline['script_settings_sha256'],baseline['current_module_hashes'])
  safe['write_attempted']=True;save()
  uploaded=result('/versions','POST',data,ctype);uploaded_id=str(uuid.UUID(uploaded['id']))
  safe['uploaded_version']=uploaded_id;save()
  confirmed=result('/versions/'+uploaded_id)
  if confirmed.get('id')!=uploaded_id or resources_config(confirmed)!=resources_config(original):
   raise ReleaseError('Staged bindings/runtime differ; version was not activated.')
  require_state(read_state(),baseline['deployments'][0],baseline['settings_sha256'],baseline['script_settings_sha256'],baseline['current_module_hashes'])
  safe['activation_attempted']=True;save();owned=select_version(uploaded_id)
  safe.update({'published':True,'after_version':uploaded_id,'after_deployment':owned});save()
  after=read_state()
  if after['deployment']!=owned: raise ReleaseError('Another deployment is active; no automatic rollback allowed.')
  if fingerprint(after['script_settings'])!=baseline['script_settings_sha256']:
   raise ReleaseError('Concurrent/unknown script-settings drift; no settings writes or automatic rollback allowed.')
  safe.update({'settings_preserved':fingerprint(after['settings'])==baseline['settings_sha256'],'script_settings_preserved':True,'code_verified':after['code_hashes']==hashes,'code_hashes':after['code_hashes'],'after_settings_sha256':fingerprint(after['settings'])})
  if not safe['settings_preserved'] or not safe['code_verified']:
   safe['restored_deployment']=restore_version(baseline,owned,after);safe['rollback_verified']=True
   raise ReleaseError('Post-deployment verification failed; captured production version restored and verified.')
  save();print(json.dumps(safe,indent=2))
 except Exception as error:
  safe['success']=False
  safe['error']=str(error) if isinstance(error,ReleaseError) else 'Unexpected local/API shape failure; inspect saved phase before further writes.'
  save();print(json.dumps(safe,indent=2));raise SystemExit(1) from None
if __name__=='__main__': main()
