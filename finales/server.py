#!/usr/bin/env python3
"""KonfAction: local/reverse-proxied HTTP app, SQLite storage, server-side admin sessions."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from http.cookies import SimpleCookie
from urllib.parse import urlparse, parse_qs
import argparse, hashlib, hmac, io, json, mimetypes, os, re, secrets, sqlite3, threading, time
ROOT=Path(__file__).resolve().parent
DATA=Path(os.environ.get('KONFACTION_DATA',ROOT/'private')); DATA.mkdir(parents=True,exist_ok=True)
CONFIG=json.loads((ROOT/'config/tournament.json').read_text())
LOCK=threading.RLock(); SESSIONS={}; ATTEMPTS={}
DB=DATA/'scores.sqlite3'
GATE_QUESTIONS=[
 ('Hva er hovedtemaet i 1. Korinterbrev 13?',{'kjærlighet','kjærligheten'}),
 ('Nevn en av hovedpersonene i 1. Samuelsbok 16.',{'david','samuel','isai','saul','goliat'}),
 ('Hvem er hovedpersonen i 1. Mosebok 6?',{'noa','noah'}),
 ('Hva heter dronningen i Esters bok 1?',{'vasti'}),
 ('Nevn en profet i Dommerne 4.',{'deborah','debora'})]
def connection():
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;return c
def initialize():
 with connection() as c:
  c.execute('CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, hs INTEGER, aws INTEGER, status TEXT NOT NULL DEFAULT "auto", winner TEXT, version INTEGER NOT NULL DEFAULT 0)')
  c.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  cols={r[1] for r in c.execute('PRAGMA table_info(scores)')}
  for col,kind in [('updated_by','TEXT'),('updated_at','TEXT'),('started_at','INTEGER')]:
   if col not in cols:c.execute(f'ALTER TABLE scores ADD COLUMN {col} {kind}')
  c.execute('CREATE TABLE IF NOT EXISTS nominations (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL, award TEXT NOT NULL, team TEXT NOT NULL, player TEXT NOT NULL DEFAULT "", reason TEXT NOT NULL, author TEXT NOT NULL, created INTEGER NOT NULL)')
  c.execute("INSERT OR IGNORE INTO meta VALUES('rev','0')")
  for m in CONFIG['matches']:c.execute('INSERT OR IGNORE INTO scores(id) VALUES (?)',(m['id'],))
# Priser dommerne kan nominere til. True betyr at spillernavn er påkrevd.
AWARDS={'puskas':True,'celebration':False,'glove':True}
def nominations():
 with connection() as c:return [dict(r) for r in c.execute('SELECT id,match_id AS matchId,award,team,player,reason,author,created FROM nominations ORDER BY created DESC, id DESC')]
def check_nomination(data,m):
 award,team,player,reason=data.get('award'),data.get('team'),data.get('player',''),data.get('reason','')
 if player is None:player=''
 if award not in AWARDS:return 'Velg en pris.'
 # Kampen er valgfri: nominasjoner kan legges til i etterkant fra «Nominert» uten å huske kampen.
 if data.get('matchId') is not None:
  if not m or m.get('provisional'):return 'Ukjent kamp.'
  if team not in (m['home'],m['away']):return 'Velg et av lagene i kampen.'
 elif team not in CONFIG['teams']:return 'Velg et lag.'
 if not isinstance(player,str) or not isinstance(reason,str):return 'Ugyldig nominasjon.'
 if AWARDS[award] and not player.strip():return 'Skriv navnet på spilleren.'
 if len(player.strip())>60:return 'Spillernavnet kan ha maks 60 tegn.'
 if not 3<=len(reason.strip())<=600:return 'Skriv en kort begrunnelse (3 til 600 tegn).'
 return None
# Klokka styrer ikke status: bare Start og Avslutt i appen gjør det (samme som worker.js).
def effective(m):return m['status'] if m['status'] in ('live','finished') else 'upcoming'
def duration(m):
 (sh,sm),(eh,em)=[map(int,t.split(':')) for t in (m['start'],m['end'])];return (eh*60+em-sh*60-sm)*60
# Myntkast (samme regler som worker.js): lag som er helt like etter alle reglene, også innbyrdes
# oppgjør, og som står i hvert sitt sluttspillpar (grense 2|3, 4|5, 6|7, 8|9). Like lag i samme par
# løses stille med fast rekkefølge. decisions: lagrede avgjørelser, bare med når serien er ferdig.
# h2h per gruppe: 'never' ingen har møtt hverandre, 'partial' noen men ikke alle (innbyrdes teller da
# ikke), 'level' alle har møtt hverandre og innbyrdes skiller dem ikke.
def tie_key(names):return '|'.join(sorted(names))
def valid_decision(dec,names):
 return isinstance(dec,dict) and dec.get('status') in ('proposed','approved') and isinstance(dec.get('order'),list) and len(dec['order'])==len(names) and all(n in dec['order'] for n in names)
def standings(matches,decisions=None):
 rows={n:dict(name=n,index=i,p=0,w=0,d=0,l=0,gf=0,ga=0,gd=0,pts=0) for i,n in enumerate(CONFIG['teams'])}
 played=[]
 for m in matches:
  if m['kind']!='league' or m['status']=='upcoming' or m['hs'] is None or m['aws'] is None:continue
  played.append((m['home'],m['away'],m['hs'],m['aws']))
  a,b=rows[m['home']],rows[m['away']]
  for r,gf,ga in [(a,m['hs'],m['aws']),(b,m['aws'],m['hs'])]:
   r['p']+=1;r['gf']+=gf;r['ga']+=ga;r['gd']=r['gf']-r['ga'];r['w']+=gf>ga;r['d']+=gf==ga;r['l']+=gf<ga;r['pts']+=2 if gf>ga else 1 if gf==ga else 0
 # Tiebreak order: poeng, målforskjell, scorede mål, innbyrdes oppgjør (mini-tabell
 # mellom kun de tabell-like lagene). Fortsatt like: myntkast eller stabil rekkefølge (opprinnelig indeks).
 ordered=sorted(rows.values(),key=lambda r:(-r['pts'],-r['gd'],-r['gf'],r['index']))
 met={(h,a) for h,a,_,_ in played}|{(a,h) for h,a,_,_ in played}
 # Innbyrdes oppgjør teller bare når alle de like lagene har møtt hverandre (samme som worker.js).
 # Skiller minitabellen noen av dem, brukes regelen på nytt blant lagene som fortsatt er like.
 def resolve(run):
  if len(run)<2:return [(run,None)]
  pairs=sum(1 for x in range(len(run)) for y in range(x+1,len(run)) if (run[x]['name'],run[y]['name']) in met)
  if pairs<len(run)*(len(run)-1)//2:return [(run,'partial' if pairs else 'never')]
  names={r['name'] for r in run}
  mini={r['name']:dict(pts=0,gd=0,gf=0) for r in run}
  for home,away,hs,aws in played:
   if home in names and away in names:
    for n,gf,ga in [(home,hs,aws),(away,aws,hs)]:
     mini[n]['gf']+=gf;mini[n]['gd']+=gf-ga;mini[n]['pts']+=2 if gf>ga else 1 if gf==ga else 0
  h2h=lambda r:(-mini[r['name']]['pts'],-mini[r['name']]['gd'],-mini[r['name']]['gf'])
  srt=sorted(run,key=lambda r:(h2h(r),r['index']))
  parts=[];a=0
  while a<len(srt):
   b=a
   while b+1<len(srt) and h2h(srt[b+1])==h2h(srt[a]):b+=1
   parts.append(srt[a:b+1]);a=b+1
  if len(parts)==1:return [(srt,'level')]
  return [x for p in parts for x in resolve(p)]
 result=[];groups=[];i=0
 while i<len(ordered):
  j=i
  while j+1<len(ordered) and (ordered[j+1]['pts'],ordered[j+1]['gd'],ordered[j+1]['gf'])==(ordered[i]['pts'],ordered[i]['gd'],ordered[i]['gf']):j+=1
  for run,how in resolve(ordered[i:j+1]):
   start,end=len(result),len(result)+len(run)-1
   if len(run)>1 and start//2!=end//2:
    teams=[r['name'] for r in run];key=tie_key(teams)
    dec=decisions.get(key) if decisions else None
    if not valid_decision(dec,teams):dec=None
    groups.append(dict(key=key,teams=teams,positions=[start+k+1 for k in range(len(run))],decision=dec,h2h=how))
    if dec:run=[next(r for r in run if r['name']==n) for n in dec['order']]
   result.extend(run)
  i=j+1
 return result,groups
def league_finished(ms):return all(m['status']=='finished' and m['hs'] is not None and m['aws'] is not None for m in ms if m['kind']=='league')
def tie_view(key,teams,positions,dec,h2h,after_freeze):
 g=lambda f:dec.get(f) if dec else None
 return dict(key=key,teams=teams,positions=positions,h2h=h2h,afterFreeze=after_freeze,kind=g('kind'),status=dec['status'] if dec else 'pending',order=g('order'),by=g('by'),at=g('at'),approvedBy=g('approvedBy'),approvedAt=g('approvedAt'))
# Alle grupper i dagens tabell som betyr noe. Uten avgjørelse etter låsing: afterFreeze=True
# (stopper ingenting; «Sett opp på nytt fra tabellen» gjør den klar for myntkast). Samme som worker.js.
def tie_list(groups,frozen):
 return [tie_view(g['key'],g['teams'],g['positions'],g['decision'],g['h2h'],bool(frozen) and not g['decision']) for g in groups]
def decided(m):
 if not m or m['status']!='finished' or m['hs'] is None or m['aws'] is None:return None
 if m['hs']!=m['aws']:return (m['home'],m['away']) if m['hs']>m['aws'] else (m['away'],m['home'])
 if m.get('winner'):return (m['winner'],m['away'] if m['winner']==m['home'] else m['home'])
 return None
def podium(ms):
 final=next((m for m in ms if m['kind']=='playoff' and m['ranks'][1]==1),None)
 bronze=next((m for m in ms if m['kind']=='playoff' and m['ranks'][1]==3),None)
 f=decided(final) if final and not final.get('provisional') else None
 if not f:return None
 b=decided(bronze) if bronze and not bronze.get('provisional') else None
 return dict(first=f[0],second=f[1],third=b[0] if b else None)
def now_local():return datetime.now(ZoneInfo(CONFIG['timezone']))
def rev():
 with connection() as c:
  r=c.execute("SELECT value FROM meta WHERE key='rev'").fetchone();return int(r['value']) if r else 0
def state_key(now=None):return str(rev())
def bump(c):c.execute("INSERT INTO meta VALUES('rev','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1")
# Myntkast-avgjørelser lagres i meta som «tie:Delta|Echo» (samme som worker.js). Intervallet
# bruker primærnøkkelen (';' kommer rett etter ':'); LIKE ville lest hele meta-tabellen.
def read_ties(c):
 ties={}
 for r in c.execute("SELECT key,value FROM meta WHERE key>='tie:' AND key<'tie;'"):
  try:ties[r['key'][4:]]=json.loads(r['value'])
  except ValueError:pass
 return ties
def state(now=None):
 now=now or datetime.now(ZoneInfo(CONFIG['timezone']))
 with LOCK,connection() as c:
  scores={r['id']:dict(r) for r in c.execute('SELECT * FROM scores')};ms=[]
  for base in CONFIG['matches']:
   m={**base,**scores[base['id']]};m['status']=effective(m);m['duration']=duration(m);ms.append(m)
  done=league_finished(ms);decisions=read_ties(c)
  table,groups=standings(ms,decisions if done else None);frozen=c.execute('SELECT value FROM meta WHERE key="seeding"').fetchone()
  # Ikke godkjent myntkast som avgjør et sluttspillpar: oppsettet fryses ikke ennå.
  pending=done and not frozen and any(not g['decision'] or g['decision']['status']!='approved' for g in groups)
  if not frozen and done and not pending:
   seed=[r['name'] for r in table];c.execute('INSERT INTO meta VALUES("seeding",?)',(json.dumps(seed),));frozen={'value':json.dumps(seed)}
  seed=json.loads(frozen['value']) if frozen else [r['name'] for r in table]
  for m in ms:
   if m['kind']=='playoff':
    m['home'],m['away']=[seed[r-1] for r in m['ranks']];m['provisional']=not bool(frozen)
    if m['provisional']:m['status']='upcoming'
  ties=tie_list(groups,bool(frozen)) if done else []
  return dict(config={k:v for k,v in CONFIG.items() if k!='matches'},matches=ms,table=table,seeded=bool(frozen),ties=ties,tiePending=bool(pending),podium=podium(ms),key=state_key(now),serverTime=now.isoformat())
TIE_MSG=dict(pending='Myntkast må godkjennes først.',phase='Myntkast kan bare brukes når seriespillet er ferdig og sluttspillet ikke er låst.',unknown='Ingen myntkast trengs for disse lagene.',notFlipped='Kast myntet først.',flipped='Myntkastet er allerede kastet.')
# Samme som tieVerdict i worker.js: 'done' (svar 200), en feilmelding (409) eller gruppen som kan behandles.
def tie_verdict(st,action,key):
 g=next((t for t in st['ties'] if t['key']==key),None)
 if g:
  if action=='flip' and g['status']!='pending':return 'done',None
  if action=='approve' and g['status']=='approved':return 'done',None
  if action=='fallback' and g['status']=='approved' and g['kind']=='fixed':return 'done',None
  if action=='fallback' and g['status']!='pending':return TIE_MSG['flipped'],None
 if not league_finished(st['matches']) or st['seeded']:return TIE_MSG['phase'],None
 if not g:return TIE_MSG['unknown'],None
 if action=='approve' and g['status']=='pending':return TIE_MSG['notFlipped'],None
 return None,g
def auth_users():
 try:cfg=json.loads((DATA/'admin.json').read_text())
 except FileNotFoundError:return None
 return cfg['users'] if 'users' in cfg else [cfg]
def normalize(value):
 return ''.join(c for c in value.casefold().strip() if c.isalnum() or c in 'æøå')
# Tilgang: passord frem til bibelgåten starter, bibelgåte til kampdagen kl. 08.30, deretter åpent for alle.
ENTRY_PASSWORD='siuuuuuuu'
GATE_OPEN=datetime(2026,10,9,0,0)
GATE_CLOSE=datetime(2026,10,10,8,30)
def gate_phase(now=None):
 tz=ZoneInfo(CONFIG['timezone']);now=now or datetime.now(tz)
 if now<GATE_OPEN.replace(tzinfo=tz):return 'password'
 if now<GATE_CLOSE.replace(tzinfo=tz):return 'bible'
 return None
# Samme meldinger som worker.js gir når en kamphandling ikke kan utføres (bygget på kampens status nå).
def conflict_message(action,status,problem):
 if status=='finished' and action!='reopen':return 'Kampen er allerede avsluttet.'
 if status=='live' and action=='start':return 'Kampen er allerede i gang.'
 if status=='upcoming' and action=='finish':return 'Kampen er ikke startet.'
 if status=='live' and action=='finish':return 'Stillingen ble endret samtidig. Sjekk resultatet og prøv igjen.'
 if status=='live' and action=='reopen':return 'Kampen er allerede åpnet igjen.'
 if status=='upcoming' and action=='unstart':return 'Kampen står allerede som «Ikke startet».'
 if status=='upcoming' and action=='start':return 'Lås sluttspilloppsettet før kampen startes.'
 return problem or 'Kampen er allerede i gang.'
def gate_day(now=None):return gate_phase(now) is not None
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,data,cookie=None):
  raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.headers_common();self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store')
  if cookie:self.send_header('Set-Cookie',cookie)
  self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def json_body(self):
  # Samme regler som readJsonBody i worker.js: bare application/json, 1–4096 byte, et JSON-objekt. Ellers None.
  try:size=int(self.headers.get('Content-Length','0'))
  except ValueError:size=0
  raw=self.rfile.read(size) if 0<size<=4096 else b''
  if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json' or not raw:return None
  try:data=json.loads(raw)
  except ValueError:return None
  return data if isinstance(data,dict) else None
 def method_not_allowed(self):
  # Som worker.js: andre metoder mot /api/ krever admin og gir så «Ukjent handling.» (JSON, aldri HTML-feilside).
  if self.path.startswith('/api/'):
   s=self.session()
   if not s or not s.get('admin'):return self.reply(401,{'error':'Logg inn for å endre resultater.'})
   if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'error':'Ugyldig økt. Last siden på nytt.'})
   return self.reply(404,{'error':'Ukjent handling.'})
  self.send_error(405)
 do_PUT=do_DELETE=do_PATCH=do_OPTIONS=method_not_allowed
 def do_HEAD(self):
  if self.path.startswith('/api/'):return self.method_not_allowed()
  # Som GET, men uten innhold: alt etter hodene skrives til en buffer som kastes.
  self._head=True;self.do_GET()
 def end_headers(self):
  super().end_headers()
  if getattr(self,'_head',False):self._real_wfile,self.wfile=self.wfile,io.BytesIO()
 def finish(self):
  if getattr(self,'_real_wfile',None):self.wfile=self._real_wfile
  super().finish()
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
 def allowed(self):
  s=self.session()
  phase=gate_phase()
  return phase is None or bool(s and (s.get('admin') or s.get('passed')==phase))
 def cookie(self,token,age=28800):
  return f'session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}'+('; Secure' if os.environ.get('COOKIE_SECURE')=='1' else '')
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/api/state':
   if not self.allowed():return self.reply(401,{'error':'Svar på inngangsspørsmålet for å se turneringen.'})
   since=parse_qs(urlparse(self.path).query).get('since',[None])[0]
   if since and since==state_key():return self.reply(200,dict(same=True,key=since,serverTime=now_local().isoformat()))
   return self.reply(200,state())
  if path=='/api/gate':
   s=self.session();phase=gate_phase()
   if phase is None or (s and (s.get('admin') or s.get('passed')==phase)):return self.reply(200,{'required':False})
   if phase=='password':return self.reply(200,{'required':True,'mode':'password','question':'Passord'})
   if not s:
    token=secrets.token_urlsafe(32);s={'csrf':secrets.token_urlsafe(32),'expires':time.time()+86400,'question':secrets.randbelow(len(GATE_QUESTIONS))}
    with LOCK:SESSIONS[token]=s
    return self.reply(200,{'required':True,'mode':'bible','question':GATE_QUESTIONS[s['question']][0]},self.cookie(token,86400))
   if 'question' not in s:s['question']=secrets.randbelow(len(GATE_QUESTIONS))
   return self.reply(200,{'required':True,'mode':'bible','question':GATE_QUESTIONS[s['question']][0]})
  if path=='/api/export.csv':
   # Regneark med alle kamper for admin (samme innhold som worker.js).
   s=self.session()
   if not s or not s.get('admin'):return self.reply(401,{'error':'Logg inn som admin for å laste ned resultatene.'})
   st=state();names={'upcoming':'Ikke startet','live':'Pågår','finished':'Avsluttet'}
   def cell(v):
    # Tekst som begynner med = + - @ kan tolkes som formel i Excel (samme som worker.js). Tall røres ikke.
    t='' if v is None else str(v)
    if isinstance(v,str) and t[:1] in ('=','+','-','@','\t','\r'):t="'"+t
    return '"'+t.replace('"','""')+'"' if any(c in t for c in ';"\r\n') else t
   rows=[['Runde','Kamp','Type','Start','Slutt','Bane','Hjemme','Borte','Mål hjemme','Mål borte','Status','Vinner','Vunnet på straffer','Sist endret av','Sist endret']]
   for m in st['matches']:
    d=decided(m);po=m['kind']=='playoff'
    rows.append(['Sluttspill' if po else m['round'],m['id'],f"Plass {m['ranks'][1]}–{m['ranks'][0]}" if po else 'Serie',m['start'],m['end'],m['pitch'],m['home'],m['away'],m['hs'],m['aws'],names[m['status']],d[0] if d else '','Ja' if d and m['hs']==m['aws'] else '',m.get('updated_by'),(m.get('updated_at') or '').replace('T',' ')])
   rows.append([]);rows.append(['Plass','Lag','Kamper','Seier','Uavgjort','Tap','Mål for','Mål mot','Målforskjell','Poeng'])
   for i,r in enumerate(st['table']):rows.append([i+1,r['name'],r['p'],r['w'],r['d'],r['l'],r['gf'],r['ga'],r['gd'],r['pts']])
   raw=('\ufeff'+'\r\n'.join(';'.join(cell(v) for v in r) for r in rows)+'\r\n').encode()
   self.send_response(200);self.headers_common();self.send_header('Content-Type','text/csv; charset=utf-8');self.send_header('Content-Disposition',f'attachment; filename="konfaction-resultater-{now_local().strftime("%Y%m%d-%H%M")}.csv"');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
  if path=='/api/nominations':
   s=self.session()
   if not s or not s.get('admin'):return self.reply(401,{'error':'Logg inn for å endre resultater.'})
   if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'error':'Ugyldig økt. Last siden på nytt.'})
   return self.reply(200,{'nominations':nominations()})
  if path=='/api/session':
   s=self.session();return self.reply(200,dict(admin=bool(s and s.get('admin')),user=s.get('user') if s and s.get('admin') else None,csrf=s['csrf'] if s else None,gateRequired=gate_day(),local=True,tournamentDay=datetime.now(ZoneInfo(CONFIG['timezone'])).date().isoformat()==CONFIG['date']))
  if path.startswith('/api/'):
   s=self.session()
   if not s or not s.get('admin'):return self.reply(401,{'error':'Logg inn for å endre resultater.'})
   if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'error':'Ugyldig økt. Last siden på nytt.'})
   return self.reply(404,{'error':'Ukjent handling.'})
  if path in ['/','/index.html'] and not self.allowed():path='/gate.html'
  files={'/':'index.html','/index.html':'index.html','/gate.html':'gate.html','/app.js':'app.js','/gate.js':'gate.js','/crests.js':'crests.js','/style.css':'style.css','/krik_logo.svg':'krik_logo.svg','/krik_favicon.svg':'krik_favicon.svg','/exo.woff2':'exo.woff2'}
  if path.startswith(('/pixel/','/px/')):
   p=(ROOT/'dist'/path[1:]).resolve()
   if (ROOT/'dist').resolve() not in p.parents or not p.is_file():return self.reply(404,{'error':'Fant ikke filen.'})
   raw=p.read_bytes();self.send_response(200);self.headers_common();self.send_header('Content-Type',mimetypes.guess_type(p)[0] or 'application/octet-stream');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
  if path not in files:return self.reply(404,{'error':'Fant ikke siden.'})
  p=ROOT/'dist'/files[path]
  if not p.is_file():return self.reply(404,{'error':'Fant ikke filen.'})
  raw=p.read_bytes();self.send_response(200);self.headers_common();self.send_header('Content-Type',mimetypes.guess_type(p)[0] or 'application/octet-stream');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_POST(self):
  origin=self.headers.get('Origin');expected=os.environ.get('PUBLIC_ORIGIN') or 'http://'+self.headers.get('Host','')
  if origin and origin!=expected:return self.reply(403,{'error':'Ugyldig forespørselskilde.'})
  # Samme som worker.js: ugyldig kropp gir None, og hvert endepunkt svarer med sin egen melding
  # (etter innloggings- og CSRF-sjekken for admin-endepunktene).
  data=self.json_body()
  self.path=urlparse(self.path).path
  if self.path=='/api/login':
   ip=self.client_address[0]
   with LOCK:
    ATTEMPTS[ip]=[t for t in ATTEMPTS.get(ip,[]) if t>time.time()-300]
    if len(ATTEMPTS[ip])>=8:return self.reply(429,{'error':'For mange forsøk. Vent fem minutter.'})
   users=auth_users()
   if not users:return self.reply(503,{'error':'Administrator må konfigureres på serveren.'})
   if data is None or not isinstance(data.get('password'),str) or not isinstance(data.get('username'),str):return self.reply(400,{'error':'Ugyldig innlogging.'})
   password=data['password'];username=data['username']
   uname=username.strip().casefold()
   cfg=next((u for u in users if u['username'].casefold()==uname),users[0])
   found=cfg['username'].casefold()==uname
   digest=hashlib.scrypt(password.encode(),salt=bytes.fromhex(cfg['salt']),n=16384,r=8,p=1).hex()
   if not (found and hmac.compare_digest(digest,cfg['hash'])):
    with LOCK:ATTEMPTS.setdefault(ip,[]).append(time.time())
    return self.reply(401,{'error':'Feil brukernavn eller passord.'})
   token=secrets.token_urlsafe(32);s=dict(csrf=secrets.token_urlsafe(32),expires=time.time()+28800,admin=True,public=True,user=cfg['username'])
   with LOCK:
    for old in list(SESSIONS):
     if SESSIONS[old]['expires']<time.time():del SESSIONS[old]
    SESSIONS[token]=s
   return self.reply(200,dict(admin=True,user=cfg['username'],csrf=s['csrf']),self.cookie(token))
  if self.path=='/api/gate':
   s=self.session();phase=gate_phase()
   if phase is None or (s and s.get('admin')):return self.reply(200,{'ok':True})
   answer=data.get('answer') if data is not None else None
   if not isinstance(answer,str):return self.reply(400,{'error':'Ugyldig svar.'})
   if phase=='password':
    if normalize(answer)!=ENTRY_PASSWORD:return self.reply(401,{'error':'Feil passord. Prøv igjen.'})
    if s:s['passed']='password';return self.reply(200,{'ok':True})
    token=secrets.token_urlsafe(32);s={'csrf':secrets.token_urlsafe(32),'expires':time.time()+86400,'passed':'password'}
    with LOCK:SESSIONS[token]=s
    return self.reply(200,{'ok':True},self.cookie(token,86400))
   if not s or 'question' not in s:return self.reply(401,{'error':'Last siden på nytt og prøv igjen.'})
   if normalize(answer) not in GATE_QUESTIONS[s['question']][1]:return self.reply(401,{'error':'Ikke helt. Se i bibelteksten og prøv igjen.'})
   s['passed']='bible'
   return self.reply(200,{'ok':True})
  s=self.session()
  if not s or not s.get('admin'):return self.reply(401,{'error':'Logg inn for å endre resultater.'})
  if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'error':'Ugyldig økt. Last siden på nytt.'})
  if self.path=='/api/logout':
   with LOCK:
    for key in list(SESSIONS):
     if SESSIONS[key] is s:del SESSIONS[key]
   return self.reply(200,{'ok':True},self.cookie('',0))
  if self.path not in ('/api/nominate','/api/nomination/delete','/api/goal','/api/match','/api/seeding','/api/score','/api/tiebreak'):return self.reply(404,{'error':'Ukjent handling.'})
  if data is None:return self.reply(400,{'error':'Ugyldig forespørsel.'})
  if self.path=='/api/nominate':
   mid=data.get('matchId');m=next((m for m in state()['matches'] if type(mid) is int and m['id']==mid),None);problem=check_nomination(data,m)
   if problem:return self.reply(400,{'error':problem})
   with connection() as c:c.execute('INSERT INTO nominations(match_id,award,team,player,reason,author,created) VALUES (?,?,?,?,?,?,?)',(m['id'] if m else 0,data['award'],data['team'],(data.get('player') or '').strip() if AWARDS[data['award']] else '',data['reason'].strip(),s.get('user','admin'),int(time.time())))
   return self.reply(200,{'nominations':nominations()})
  if self.path=='/api/nomination/delete':
   if type(data.get('id')) is not int:return self.reply(400,{'error':'Ugyldig forespørsel.'})
   with connection() as c:gone=c.execute('DELETE FROM nominations WHERE id=? AND author=?',(data.get('id'),s.get('user','admin'))).rowcount
   if gone!=1:return self.reply(403,{'error':'Du kan bare slette dine egne nominasjoner.'})
   return self.reply(200,{'nominations':nominations()})
  if self.path=='/api/goal':
   side,delta=data.get('side'),data.get('delta')
   if side not in ['home','away'] or type(delta) is not int or delta not in [1,-1]:return self.reply(400,{'error':'Ugyldig forespørsel.'})
   # Valgfri trykk-id (samme som worker.js): et trykk som sendes på nytt etter tidsavbrudd, telles bare én gang.
   rid=data.get('rid')
   if rid is not None and not (isinstance(rid,str) and re.fullmatch(r'[A-Za-z0-9_-]{8,64}',rid)):return self.reply(400,{'error':'Ugyldig forespørsel.'})
   with LOCK:
    m=next((m for m in state()['matches'] if type(data.get('id')) is int and m['id']==data.get('id')),None)
    if not m:return self.reply(404,{'error':'Ukjent kamp.'})
    if m.get('provisional'):return self.reply(409,{'error':'Lås sluttspilloppsettet før du registrerer mål.'})
    col='hs' if side=='home' else 'aws'
    with connection() as c:
     if rid is not None and c.execute('SELECT 1 FROM meta WHERE key=?',('g:'+rid,)).fetchone():return self.reply(200,state())
     n=c.execute(f"UPDATE scores SET {col}=MIN(99,MAX(0,COALESCE({col},0)+?)),version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='live'",(delta,s.get('user'),now_local().strftime('%Y-%m-%dT%H:%M:%S'),m['id'])).rowcount
     if n!=1:return self.reply(409,{'error':'Kampen er avsluttet. Åpne den igjen for å endre resultatet.' if m['status']=='finished' else 'Start kampen før du fører mål.'})
     if rid is not None:
      c.execute('INSERT OR IGNORE INTO meta VALUES(?,?)',('g:'+rid,str(int(time.time()))))
      c.execute("DELETE FROM meta WHERE key LIKE 'g:%' AND CAST(value AS INTEGER)<?",(int(time.time())-3600,))
     bump(c)
    return self.reply(200,state())
  if self.path=='/api/match':
   action=data.get('action')
   if action not in ['start','finish','reopen','unstart']:return self.reply(400,{'error':'Ugyldig forespørsel.'})
   with LOCK:
    m=next((m for m in state()['matches'] if type(data.get('id')) is int and m['id']==data.get('id')),None)
    if not m:return self.reply(404,{'error':'Ukjent kamp.'})
    if m.get('provisional'):return self.reply(409,{'error':'Lås sluttspilloppsettet før kampen startes.'})
    stamp=(s.get('user'),now_local().strftime('%Y-%m-%dT%H:%M:%S'),m['id'])
    if action=='start':
     sql,args="UPDATE scores SET status='live',hs=COALESCE(hs,0),aws=COALESCE(aws,0),started_at=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND status NOT IN ('live','finished')",(int(time.time()),*stamp)
     problem='Kampen er allerede avsluttet.' if m['status']=='finished' else 'Kampen er allerede i gang.'
    elif action=='finish':
     draw=m['kind']=='playoff' and m['hs']==m['aws'];winner=data.get('winner') if draw else None
     if draw and winner not in [m['home'],m['away']]:return self.reply(400,{'error':'Uavgjort i sluttspill: velg hvem som vant på straffer.'})
     sql,args="UPDATE scores SET status='finished',winner=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='live' AND hs IS ? AND aws IS ?",(winner,*stamp,m['hs'],m['aws'])
     problem={'finished':'Kampen er allerede avsluttet.','upcoming':'Kampen er ikke startet.'}.get(m['status'],'Stillingen ble endret samtidig. Sjekk resultatet og prøv igjen.')
    elif action=='reopen':
     sql,args="UPDATE scores SET status='live',winner=NULL,version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='finished'",stamp;problem='Kampen er ikke avsluttet.'
    else:
     sql,args="UPDATE scores SET status='upcoming',hs=NULL,aws=NULL,winner=NULL,started_at=NULL,version=version+1,updated_by=?,updated_at=? WHERE id=? AND status='live' AND hs=0 AND aws=0",stamp;problem='Start kan bare angres mens stillingen er 0–0.'
    with connection() as c:
     if c.execute(sql,args).rowcount!=1:return self.reply(409,{'error':conflict_message(action,m['status'],problem)})
     bump(c)
    return self.reply(200,state())
  if self.path=='/api/tiebreak':
   # Myntkast (samme som worker.js): kast gir et forslag, en admin godkjenner; nødutgang = fast rekkefølge før noen har kastet.
   action,key=data.get('action'),data.get('key')
   if action not in ['flip','approve','fallback'] or not isinstance(key,str):return self.reply(400,{'error':'Ugyldig forespørsel.'})
   with LOCK:
    cur=state();verdict,g=tie_verdict(cur,action,key)
    if verdict=='done':return self.reply(200,cur)
    if verdict:return self.reply(409,{'error':verdict})
    by=s.get('user');at=now_local().strftime('%Y-%m-%dT%H:%M:%S');nonce=secrets.token_hex(6)
    with connection() as c:
     if action=='approve':
      dec={k:v for k,v in read_ties(c)[g['key']].items() if k!='n'}
      c.execute('UPDATE meta SET value=? WHERE key=?',(json.dumps({**dec,'status':'approved','approvedBy':by,'approvedAt':at,'n':nonce}),'tie:'+g['key']))
     else:
      flip=action=='flip';order=list(g['teams'])
      if flip:secrets.SystemRandom().shuffle(order)
      c.execute('INSERT INTO meta VALUES(?,?)',('tie:'+g['key'],json.dumps(dict(order=order,kind=('coin' if len(order)==2 else 'lodd') if flip else 'fixed',status='proposed' if flip else 'approved',by=by,at=at,approvedBy=None if flip else by,approvedAt=None if flip else at,n=nonce))))
     bump(c)
    return self.reply(200,state())
  if self.path=='/api/seeding':
   action=data.get('action')
   if action not in ['lock','unlock']:return self.reply(400,{'error':'Ugyldig forespørsel.'})
   with LOCK:
    cur=state()
    # Ikke lås over helt like lag uten godkjent myntkast, heller ikke på nytt etter en rettelse (samme som worker.js).
    if action=='lock' and any(t['status']!='approved' for t in cur['ties']):return self.reply(409,{'error':TIE_MSG['pending']})
    # Samme som worker.js: et låst oppsett med sluttspillresultater kan ikke overskrives.
    if action=='lock' and cur['seeded'] and any(m['kind']=='playoff' and (m['hs'] is not None or m['aws'] is not None) for m in cur['matches']):return self.reply(409,{'error':'Sluttspillet har allerede resultater. Fjern dem før du låser opp oppsettet.'})
    with connection() as c:
     if action=='lock':c.execute("INSERT INTO meta VALUES('seeding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps([r['name'] for r in cur['table']]),))
     else:
      if any(m['kind']=='playoff' and (m['hs'] is not None or m['aws'] is not None) for m in cur['matches']):return self.reply(409,{'error':'Sluttspillet har allerede resultater. Fjern dem før du låser opp oppsettet.'})
      c.execute("DELETE FROM meta WHERE key='seeding'")
     bump(c)
    return self.reply(200,state())
  with LOCK:
   current=state();m=next((m for m in current['matches'] if type(data.get('id')) is int and m['id']==data.get('id')),None)
   if not m:return self.reply(404,{'error':'Ukjent kamp.'})
   if m.get('provisional'):return self.reply(409,{'error':'Sluttspillet er ikke klart. Fullfør alle seriekampene først.'})
   hs,aws=data.get('hs'),data.get('aws');mode=data.get('mode');winner=data.get('winner')
   if any(v is not None and (type(v)!=int or not 0<=v<=99) for v in [hs,aws]) or mode not in ['upcoming','live','finished']:return self.reply(400,{'error':'Bruk hele mål mellom 0 og 99 og en gyldig status.'})
   if mode!='upcoming' and (hs is None or aws is None):return self.reply(400,{'error':'Fyll inn mål for begge lagene.'})
   if mode=='finished' and m['kind']=='playoff' and hs==aws and winner not in [m['home'],m['away']]:return self.reply(400,{'error':'Uavgjort i sluttspill: velg hvem som vant på straffer.'})
   if winner is not None and (winner not in [m['home'],m['away']] or m['kind']!='playoff' or hs is None or hs!=aws):return self.reply(400,{'error':'Vinner ved uavgjort må være et av lagene i kampen.'})
   if mode=='upcoming':hs=aws=winner=None
   with connection() as c:
    result=c.execute("UPDATE scores SET hs=?,aws=?,status=?,winner=?,started_at=CASE WHEN ?='upcoming' THEN NULL WHEN ?='live' AND started_at IS NULL THEN ? ELSE started_at END,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?",(hs,aws,mode,winner,mode,mode,int(time.time()),s.get('user'),now_local().strftime('%Y-%m-%dT%H:%M:%S'),m['id'],data.get('version')))
    if result.rowcount!=1:return self.reply(409,{'error':'En annen administrator endret kampen. Last inn siste resultat før du lagrer.'})
    bump(c)
   return self.reply(200,state())
class Server(ThreadingHTTPServer):request_queue_size=128
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8767);parser.add_argument('--host',default='127.0.0.1');args=parser.parse_args();initialize();print(f'KonfAction: http://{args.host}:{args.port}',flush=True);Server((args.host,args.port),Handler).serve_forever()
if __name__=='__main__':main()
