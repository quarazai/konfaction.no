#!/usr/bin/env python3
"""KonfAction: local/reverse-proxied HTTP app, SQLite storage, server-side admin sessions."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from http.cookies import SimpleCookie
import argparse, hashlib, hmac, json, mimetypes, os, secrets, sqlite3, threading, time
ROOT=Path(__file__).resolve().parent
DATA=Path(os.environ.get('KONFACTION_DATA',ROOT/'private')); DATA.mkdir(parents=True,exist_ok=True)
CONFIG=json.loads((ROOT/'config/tournament.json').read_text())
LOCK=threading.RLock(); SESSIONS={}; ATTEMPTS={}
DB=DATA/'scores.sqlite3'
def connection():
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;return c
def initialize():
 with connection() as c:
  c.execute('CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, hs INTEGER, aws INTEGER, status TEXT NOT NULL DEFAULT "auto", winner TEXT, version INTEGER NOT NULL DEFAULT 0)')
  c.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  for m in CONFIG['matches']:c.execute('INSERT OR IGNORE INTO scores(id) VALUES (?)',(m['id'],))
def effective(m,now):
 start=datetime.fromisoformat(CONFIG['date']+'T'+m['start']).replace(tzinfo=ZoneInfo(CONFIG['timezone']))
 end=datetime.fromisoformat(CONFIG['date']+'T'+m['end']).replace(tzinfo=ZoneInfo(CONFIG['timezone']))
 # End time always ends a live match, even with manual live override.
 if now>=end:return 'finished'
 if m['status']!='auto':return m['status']
 return 'live' if now>=start else 'upcoming'
def standings(matches):
 rows={n:dict(name=n,index=i,p=0,w=0,d=0,l=0,gf=0,ga=0,gd=0,pts=0) for i,n in enumerate(CONFIG['teams'])}
 for m in matches:
  if m['kind']!='league' or m['status']=='upcoming' or m['hs'] is None or m['aws'] is None:continue
  a,b=rows[m['home']],rows[m['away']]
  for r,gf,ga in [(a,m['hs'],m['aws']),(b,m['aws'],m['hs'])]:
   r['p']+=1;r['gf']+=gf;r['ga']+=ga;r['gd']=r['gf']-r['ga'];r['w']+=gf>ga;r['d']+=gf==ga;r['l']+=gf<ga;r['pts']+=3 if gf>ga else 1 if gf==ga else 0
 return sorted(rows.values(),key=lambda r:(-r['pts'],-r['gd'],r['index']))
def state(now=None):
 now=now or datetime.now(ZoneInfo(CONFIG['timezone']))
 with LOCK,connection() as c:
  scores={r['id']:dict(r) for r in c.execute('SELECT * FROM scores')};ms=[]
  for base in CONFIG['matches']:
   m={**base,**scores[base['id']]};m['mode']=m['status'];m['status']=effective(m,now);ms.append(m)
  table=standings(ms);frozen=c.execute('SELECT value FROM meta WHERE key="seeding"').fetchone()
  if not frozen and all(m['status']=='finished' and m['hs'] is not None and m['aws'] is not None for m in ms if m['kind']=='league'):
   seed=[r['name'] for r in table];c.execute('INSERT INTO meta VALUES("seeding",?)',(json.dumps(seed),));frozen={'value':json.dumps(seed)}
  seed=json.loads(frozen['value']) if frozen else [r['name'] for r in table]
  for m in ms:
   if m['kind']=='playoff':
    m['home'],m['away']=[seed[r-1] for r in m['ranks']];m['provisional']=not bool(frozen)
    if m['provisional']:m['status']='upcoming'
  return dict(config={k:v for k,v in CONFIG.items() if k!='matches'},matches=ms,table=table,seeded=bool(frozen),serverTime=now.isoformat())
def auth_config():
 try:return json.loads((DATA/'admin.json').read_text())
 except FileNotFoundError:return None
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,data,cookie=None):
  raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.headers_common();self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store')
  if cookie:self.send_header('Set-Cookie',cookie)
  self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def headers_common(self):
  self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','same-origin');self.send_header('X-Frame-Options','DENY');self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
 def session(self):
  jar=SimpleCookie()
  try:jar.load(self.headers.get('Cookie',''));token=jar['session'].value
  except (KeyError,ValueError):return None
  with LOCK:
   entry=SESSIONS.get(token)
   if entry and entry['expires']>time.time():return entry
  return None
 def cookie(self,token,age=28800):
  return f'session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}'+('; Secure' if os.environ.get('COOKIE_SECURE')=='1' else '')
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/api/state':return self.reply(200,state())
  if path=='/api/session':
   s=self.session();return self.reply(200,dict(admin=bool(s),csrf=s['csrf'] if s else None))
  files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/crests.js':'crests.js','/style.css':'style.css','/krik_logo.svg':'krik_logo.svg','/krik_favicon.svg':'krik_favicon.svg','/exo.woff2':'exo.woff2'}
  if path not in files:return self.reply(404,{'error':'Fant ikke siden.'})
  p=ROOT/'dist'/files[path]
  if not p.is_file():return self.reply(404,{'error':'Fant ikke filen.'})
  raw=p.read_bytes();self.send_response(200);self.headers_common();self.send_header('Content-Type',mimetypes.guess_type(p)[0] or 'application/octet-stream');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_POST(self):
  origin=self.headers.get('Origin');expected=os.environ.get('PUBLIC_ORIGIN') or 'http://'+self.headers.get('Host','')
  if origin and origin!=expected:return self.reply(403,{'error':'Ugyldig forespørselskilde.'})
  if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply(415,{'error':'JSON er påkrevd.'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size<1 or size>4096:raise ValueError()
   data=json.loads(self.rfile.read(size))
   if not isinstance(data,dict):raise ValueError()
  except (ValueError,TypeError):return self.reply(400,{'error':'Ugyldig forespørsel.'})
  if self.path=='/api/login':
   ip=self.client_address[0]
   with LOCK:
    ATTEMPTS[ip]=[t for t in ATTEMPTS.get(ip,[]) if t>time.time()-300]
    if len(ATTEMPTS[ip])>=8:return self.reply(429,{'error':'For mange forsøk. Vent fem minutter.'})
    ATTEMPTS[ip].append(time.time())
   cfg=auth_config()
   if not cfg:return self.reply(503,{'error':'Administrator må konfigureres på serveren.'})
   password=data.get('password','');username=data.get('username','')
   if not isinstance(password,str) or not isinstance(username,str):return self.reply(400,{'error':'Ugyldig innlogging.'})
   digest=hashlib.scrypt(password.encode(),salt=bytes.fromhex(cfg['salt']),n=16384,r=8,p=1).hex()
   if not (hmac.compare_digest(username,cfg['username']) and hmac.compare_digest(digest,cfg['hash'])):return self.reply(401,{'error':'Feil brukernavn eller passord.'})
   token=secrets.token_urlsafe(32);s=dict(csrf=secrets.token_urlsafe(32),expires=time.time()+28800)
   with LOCK:
    for old in list(SESSIONS):
     if SESSIONS[old]['expires']<time.time():del SESSIONS[old]
    SESSIONS[token]=s
   return self.reply(200,dict(admin=True,csrf=s['csrf']),self.cookie(token))
  s=self.session()
  if not s:return self.reply(401,{'error':'Logg inn for å endre resultater.'})
  if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'error':'Ugyldig økt. Last siden på nytt.'})
  if self.path=='/api/logout':
   with LOCK:
    for key in list(SESSIONS):
     if SESSIONS[key] is s:del SESSIONS[key]
   return self.reply(200,{'ok':True},self.cookie('',0))
  if self.path!='/api/score':return self.reply(404,{'error':'Ukjent handling.'})
  with LOCK:
   current=state();m=next((m for m in current['matches'] if m['id']==data.get('id')),None)
   if not m:return self.reply(404,{'error':'Ukjent kamp.'})
   if m.get('provisional'):return self.reply(409,{'error':'Sluttspillet er ikke klart. Fullfør alle seriekampene først.'})
   hs,aws=data.get('hs'),data.get('aws');mode=data.get('mode');winner=data.get('winner')
   if any(v is not None and (type(v)!=int or not 0<=v<=99) for v in [hs,aws]) or mode not in ['auto','upcoming','live','finished']:return self.reply(400,{'error':'Bruk hele mål mellom 0 og 99 og en gyldig status.'})
   if winner not in [None,m['home'],m['away']] or (winner and (m['kind']!='playoff' or hs is None or hs!=aws)):return self.reply(400,{'error':'Vinner ved uavgjort må være et av lagene i kampen.'})
   with connection() as c:
    result=c.execute('UPDATE scores SET hs=?,aws=?,status=?,winner=?,version=version+1 WHERE id=? AND version=?',(hs,aws,mode,winner,m['id'],data.get('version')))
    if result.rowcount!=1:return self.reply(409,{'error':'En annen administrator endret kampen. Last inn siste resultat før du lagrer.'})
   return self.reply(200,state())
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8767);parser.add_argument('--host',default='127.0.0.1');args=parser.parse_args();initialize();print(f'KonfAction: http://{args.host}:{args.port}',flush=True);ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
if __name__=='__main__':main()
