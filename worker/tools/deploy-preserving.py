#!/usr/bin/env python3
"""Publish existing Worker only, preserving all live settings/bindings in memory.
Requires the existing secure HTTPS proxy and unchanged injected credential value.
Does not print/save credentials, raw settings, or response bodies. See RELEASE.md.
"""
import argparse, datetime, email, email.policy, hashlib, json, os, pathlib, sys, urllib.request, urllib.error, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CLOUDFLARE_ACCOUNT_ID']+'/workers/scripts/evaos-v05-ask'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None

def request(path, method='GET', data=None, content_type=None):
 if not os.environ.get('HTTPS_PROXY') or not os.environ.get('CLOUDFLARE_API_TOKEN'): raise SystemExit('Existing HTTPS proxy and credential environment are required.')
 headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN']}
 if content_type: headers['Content-Type']=content_type
 req=urllib.request.Request(BASE+path,data=data,headers=headers,method=method)
 try:
  with urllib.request.build_opener(NoRedirect).open(req,timeout=60) as r: return r.read(),r.headers
 except urllib.error.HTTPError as e:
  print(json.dumps({'action':method,'path':path,'http':e.code,'success':False}));sys.exit(1)
 except Exception:
  raise SystemExit('Request failed; no sensitive response or exception details emitted.')

def result(path):
 body,_=request(path); value=json.loads(body)
 if not value.get('success'): raise SystemExit('Cloudflare operation did not succeed.')
 return value['result']

def fingerprint(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def current_version():
 d=result('/deployments')['deployments'][0]
 if len(d['versions']) != 1 or d['versions'][0]['percentage'] != 100: raise SystemExit('Stop: concurrent or split deployment needs review.')
 return d['versions'][0]['version_id']

def code_hash():
 body,headers=request('')
 msg=email.message_from_bytes(('Content-Type: '+headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+body,policy=email.policy.default)
 if not msg.is_multipart(): return hashlib.sha256(body).hexdigest()
 return {p.get_filename() or p.get_param('name',header='content-disposition'):hashlib.sha256(p.get_payload(decode=True)).hexdigest() for p in msg.iter_parts()}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);parser.add_argument('--output',required=True);parser.add_argument('--publish',action='store_true');parser.add_argument('--rollback',action='store_true');parser.add_argument('--expected-version')
 args=parser.parse_args(); baseline=json.loads(pathlib.Path(args.baseline).read_text())
 version=current_version(); expected=args.expected_version or baseline['deployments'][0]['versions'][0]['version_id']
 if version!=expected: raise SystemExit('Stop: Worker version changed; inspect concurrent deployment first.')
 settings=result('/settings')
 if fingerprint(settings)!=baseline['settings_sha256']: raise SystemExit('Stop: Worker settings changed; inspect concurrent changes first.')
 names=['src/release.js','src/brief.js','src/brief-model.js','preserved/deployed-514bf8c7.js'] if not args.rollback else ['preserved/deployed-514bf8c7.js']
 files={name:(ROOT/name).read_bytes() for name in names}
 safe={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'before_version':version,'settings_sha256':fingerprint(settings),'bindings':[{'name':b['name'],'type':b['type']} for b in settings['bindings']],'files':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()},'published':False,'rollback':args.rollback}
 if args.publish:
  # Every binding type is retained by Cloudflare; no binding values leave memory.
  metadata={k:v for k,v in settings.items() if k!='bindings'}
  metadata.update({'main_module':names[0],'keep_bindings':sorted({b['type'] for b in settings['bindings']})})
  boundary='evaos-release-'+uuid.uuid4().hex;parts=[]
  def part(name,content,ctype,filename=None):
   disposition='form-data; name="'+name+'"'+('; filename="'+filename+'"' if filename else '')
   parts.append(('--'+boundary+'\r\nContent-Disposition: '+disposition+'\r\nContent-Type: '+ctype+'\r\n\r\n').encode()+content+b'\r\n')
  part('metadata',json.dumps(metadata).encode(),'application/json')
  for name,content in files.items():part(name,content,'application/javascript+module',name)
  parts.append(('--'+boundary+'--\r\n').encode())
  # Narrow the read/check/write window; the provider API has no atomic compare-and-swap.
  if current_version()!=expected or fingerprint(result('/settings'))!=baseline['settings_sha256']:
   raise SystemExit('Stop: concurrent Worker change detected immediately before upload.')
  response,_=request('',method='PUT',data=b''.join(parts),content_type='multipart/form-data; boundary='+boundary)
  body=json.loads(response)
  if not body.get('success'): raise SystemExit('Upload unsuccessful; inspect safe Cloudflare error codes before retry.')
  after=result('/settings');safe.update({'published':True,'after_version':current_version(),'settings_preserved':after==settings,'after_settings_sha256':fingerprint(after),'code_hashes':code_hash()})
  safe['deployment_id']=result('/deployments')['deployments'][0]['id']
  uploaded=safe['code_hashes']
  safe['code_verified']=(uploaded==safe['files']) if isinstance(uploaded,dict) else (len(files)==1 and uploaded==next(iter(safe['files'].values())))
  if after!=settings:safe['changed_setting_keys']=[k for k in sorted(set(settings)|set(after)) if settings.get(k)!=after.get(k)]
 pathlib.Path(args.output).write_text(json.dumps(safe,indent=2)+'\n');print(json.dumps(safe,indent=2))
 if safe.get('code_verified') is False:raise SystemExit('STOP: downloaded deployed code does not match the uploaded files.')
 if safe.get('settings_preserved') is False:raise SystemExit('STOP: a setting differs after upload; investigate safely and restore within scope.')
if __name__=='__main__': main()
