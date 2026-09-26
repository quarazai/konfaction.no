// KonfAction – offentlig side + admin + dommermodus.
// Ingen rammeverk: én fil, ~20 KB, lastes etter crests.js (som gir crest(), TEAMS og COLORS).
'use strict';

let state = null, admin = false, user = null, csrf = null;
let currentRound = null, stateKey = null, timeOffset = 0;
// Kampen som har «Rett resultat» åpent. Kortene tegnes ikke om mens den er åpen.
let editing = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- API ----------------------------------------------------------------
// Dårlig dekning ved banen er normalt: alle kall får en tidsgrense og norske feilmeldinger,
// også når Cloudflare svarer med en HTML-feilside i stedet for JSON.
async function api(path, body) {
  const ctrl = new AbortController(), timeout = setTimeout(() => ctrl.abort(), 10000);
  try {
    let res;
    try {
      res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' } : csrf ? { 'X-CSRF-Token': csrf } : {},
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = Error(e.name === 'AbortError' ? 'Serveren svarte ikke. Sjekk nettet og prøv igjen.' : 'Ingen nettforbindelse. Sjekk nettet og prøv igjen.');
      err.offline = true; throw err;
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || !data) {
      const err = Error((data && data.error) || (res.status === 429 ? 'For mange forespørsler akkurat nå. Vent litt og prøv igjen.' : 'Serveren har problemer akkurat nå. Prøv igjen om litt.'));
      err.status = res.status; throw err;
    }
    return data;
  } finally { clearTimeout(timeout); }
}
// Telles opp for hver ny stilling, så refresh() kan se om noe nyere kom mens den ventet.
let stateSeq = 0;
function setState(next) {
  stateSeq++;
  state = next;
  stateKey = next.key || null;
  if (next.serverTime) timeOffset = Date.parse(next.serverTime) - Date.now();
}
// Samme melding settes ikke på nytt: role=alert ville ellers lest den opp igjen ved hver mislykkede henting.
function error(message) { const e = $('#error'); if (e.textContent === message && e.hidden === !message) return; e.textContent = message; e.hidden = !message; }
// Beskjed nederst på siden. (toast() lenger ned er dommermodusens egen beskjed.)
function pageToast(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(pageToast.timer); pageToast.timer = setTimeout(() => { t.hidden = true; t.textContent = ''; }, 5000); }

// ---------- Små hjelpere --------------------------------------------------------
const statusLabel = (m) => ({ upcoming: 'Ikke startet', live: 'Pågår', finished: 'Avsluttet' }[m.status]);
const score = (v) => (v === null || v === undefined ? '–' : v);
const rowTeam = (name) => `${crest(name)}<span>${esc(name)}</span>`;
// Beste plass i paret (1 = finalen, 3 = bronsekampen …). Uavhengig av rekkefølgen i ranks, så hvem som er hjemmelag ikke betyr noe her.
const topRank = (m) => Math.min(...m.ranks);
const isFinalMatch = (m) => m.kind === 'playoff' && topRank(m) === 1;
const matchTitle = (m) => m.kind !== 'playoff' ? `Runde ${m.round}` : topRank(m) === 1 ? 'Finale' : topRank(m) === 3 ? 'Bronsekamp' : `Kamp om ${topRank(m)}. plass`;
// Man kan følge flere lag (f.eks. sitt eget og en kompis sitt). Eldre versjoner lagret ett lag som tekst.
const followed = () => {
  try {
    const list = JSON.parse(localStorage.getItem('konfaction-follows') || 'null');
    if (Array.isArray(list)) return list;
    const one = localStorage.getItem('konfaction-follow');
    return one ? [one] : [];
  } catch { return []; }
};
const saveFollowed = (list) => { try { localStorage.setItem('konfaction-follows', JSON.stringify(list)); localStorage.removeItem('konfaction-follow'); } catch {} };
const isMine = (m, fav = followed()) => fav.includes(m.home) || fav.includes(m.away);
const joinNames = (a) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' og ' + a[a.length - 1];
const teamColor = (name) => (typeof COLORS !== 'undefined' ? COLORS[TEAMS.indexOf(name)] : null) || '#1c5d9f';
function decided(m) {
  if (m.status !== 'finished' || m.hs === null || m.aws === null) return null;
  if (m.hs !== m.aws) return m.hs > m.aws ? m.home : m.away;
  const p = pens(m);
  return m.winner || (p && p.decided && (p.winner === 'home' || p.winner === 'away') ? m[p.winner] : null);
}
// ---------- Straffer (bare uavgjort i sluttspillet) ------------------------------
// Serveren fører straffene og avgjør når straffekonkurransen er ferdig; appen viser dem og sender trykkene.
// Hjemmelaget skyter først i hver runde, så tur-rekkefølgen følger av antall straffer: H, B, H, B …
const pens = (m) => (m && m.kind === 'playoff' && m.penalties && Array.isArray(m.penalties.kicks) ? m.penalties : null);
const penNext = (p) => (p.nextSide === 'home' || p.nextSide === 'away' ? p.nextSide : p.kicks.length % 2 ? 'away' : 'home');
// «3–2» for en uavgjort sluttspillkamp som ble avgjort på straffer (tom tekst ellers). mine: sett fra laget.
function penScore(m, mine = null) {
  const p = pens(m);
  if (!p || !p.decided || m.hs === null || m.hs !== m.aws || !Number.isInteger(p.home) || !Number.isInteger(p.away)) return '';
  return mine === m.away ? `${p.away}–${p.home}` : `${p.home}–${p.away}`;
}
// «3–2 etter straffekonkurranse», eller «avgjort på straffer» for kamper der vinneren ble valgt uten straffeføring (nødutgangen).
const penNote = (m, mine = null) => { const s = penScore(m, mine); return s ? `${s} etter straffekonkurranse` : m.kind === 'playoff' && m.hs !== null && m.hs === m.aws && m.winner ? 'avgjort på straffer' : ''; };
// «Echo vant straffekonkurransen 3–2» (vinnerens tall først).
const penWinText = (m) => { const w = decided(m) || (pens(m) && pens(m).decided ? m[pens(m).winner] : null), s = w ? penScore(m, w) : ''; return w ? (s ? `${w} vant straffekonkurransen ${s}` : `${w} vant på straffer`) : ''; };
// Genitiv: «Alphas tur», «Hans’ tur».
const genitive = (n) => (/[sxz]$/i.test(n) ? n + '’' : n + 's');
// Oslo-klokka (justert mot serverens tid), som sekunder siden midnatt + dato.
function osloClock() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + timeOffset));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, secs: +g('hour') * 3600 + +g('minute') * 60 + +g('second') };
}
const hmToSecs = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 3600 + m * 60; };
const clock = (t) => t.replace(':', '.');
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function lastEdit(m) {
  if (!m.updated_by) return '';
  const t = m.updated_at ? String(m.updated_at).slice(11, 16) : '';
  return `Sist endret av ${esc(m.updated_by)}${t ? ' kl. ' + esc(t) : ''}`;
}

// ---------- Tabell og «på banen» -----------------------------------------------
// Kamper som nettopp fikk nytt resultat eller ny status, lyser kort opp etter neste tegning.
let flashIds = new Set(), lastOrder = '';
function changedMatches(before, after) {
  if (!before) return new Set();
  const old = new Map(before.matches.map((m) => [m.id, m]));
  return new Set(after.matches.filter((m) => { const o = old.get(m.id); return o && (o.hs !== m.hs || o.aws !== m.aws || o.status !== m.status); }).map((m) => m.id));
}
function flash(root) {
  if (reducedMotion || !flashIds.size) return;
  root.querySelectorAll('[data-id]').forEach((el) => { if (flashIds.has(Number(el.dataset.id))) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } });
}
// Lag som står helt likt etter seriespillet får et lite myntmerke i tabellen (se Myntkast lenger ned).
function tieMark(name, g) {
  if (!g) return '';
  // Låst uten avgjørelse (afterFreeze): bare merket, ingen påstand om myntkast (publikum får ikke vite mer).
  const how = g.afterFreeze && g.status === 'pending' ? '' : g.status === 'approved' ? (g.kind === 'fixed' ? 'avgjort med fast rekkefølge' : isLodd(g) ? 'avgjort ved loddtrekning' : 'avgjort ved myntkast') : isLodd(g) ? 'avgjøres ved loddtrekning' : 'avgjøres ved myntkast';
  return `<i class="tie-mark${g.status === 'approved' ? ' done' : ''}" aria-hidden="true"></i><span class="sr-only">, står helt likt med ${esc(joinNames(g.teams.filter((n) => n !== name)))}${how ? ', ' + how : ''}</span>`;
}
function renderTable(fav) {
  const tieOf = new Map(); for (const g of tieList()) for (const n of g.teams) tieOf.set(n, g);
  $('#standings').innerHTML = state.table.map((r, i) => `<tr role="row" class="pair-${Math.floor(i / 2)}${fav.includes(r.name) ? ' followed' : ''}" data-team="${r.index}"><td role="cell">${i + 1}</td><td role="cell"><span class="team-label" role="button" tabindex="0" aria-label="${esc(r.name)}, form og resultater">${rowTeam(r.name)}${tieMark(r.name, tieOf.get(r.name))}</span></td><td role="cell">${r.p}</td><td role="cell">${r.w}</td><td role="cell">${r.d}</td><td role="cell">${r.l}</td><td role="cell">${r.gf}–${r.ga}</td><td role="cell">${r.gd > 0 ? '+' : ''}${r.gd}</td><td role="cell">${r.pts}</td></tr>`).join('');
  $('#standings').querySelectorAll('tr').forEach((tr) => { tr.style.viewTransitionName = 'team-' + tr.dataset.team; });
  updateScrollFocus();
}
// Trykk på et lag (kampkort eller tabellrad) -- form og alle seriekamper, runde 1 øverst. Viser
// ALLE 9 seriekamper, ikke bare de spilte: ikke-spilte kamper vises med en tydelig «ikke spilt
// ennå»-rad, så noen som sjekker siden dagen før også ser at funksjonen finnes, i stedet for en
// tom liste. Ingen tallsammendrag (S/U/T/poeng) her -- det står allerede i tabellen; denne
// dialogen er for FORM (kamp for kamp), ikke en duplikat-statistikk.
function openTeam(idx) {
  const name = TEAMS[idx];
  if (!name || !state) return;
  const fixtures = state.matches
    .filter((m) => m.kind === 'league' && (m.home === name || m.away === name))
    .sort((a, b) => a.round - b.round);
  $('#team-head').innerHTML = `${crest(name)}<h2 id="team-title">${esc(name)}</h2>`;
  $('#team-matches').innerHTML = fixtures
    .map((m) => {
      const opp = m.home === name ? m.away : m.home;
      const played = m.status === 'finished' && m.hs !== null && m.aws !== null;
      if (!played) return `<li class="team-match unplayed"><span class="tm-opp">${crest(opp)}<span>${esc(opp)}</span></span><span class="tm-score">Kampen er ikke spilt ennå</span></li>`;
      const w = decided(m), letter = !w ? 'U' : w === name ? 'S' : 'T';
      const mine = score(m[name === m.home ? 'hs' : 'aws']), theirs = score(m[name === m.home ? 'aws' : 'hs']);
      const note = penNote(m, name);
      return `<li class="team-match"><span class="tm-letter tm-${letter}" aria-hidden="true">${letter}</span><span class="tm-opp">${crest(opp)}<span>${esc(opp)}</span></span><span class="tm-score">${mine}–${theirs}${note ? `<small>${esc(note)}</small>` : ''}<span class="sr-only">, ${letter === 'S' ? 'seier' : letter === 'U' ? 'uavgjort' : 'tap'}</span></span></li>`;
    })
    .join('');
  $('#team-dialog').showModal();
}
$('#team-dialog .close').addEventListener('click', () => $('#team-dialog').close());
for (const id of ['match-cards', 'fav-grid', 'admin-alert']) {
  const el = $('#' + id);
  if (!el) continue;
  el.addEventListener('click', (e) => { const t = e.target.closest('.mc-team[data-team]'); if (t) openTeam(Number(t.dataset.team)); });
  el.addEventListener('keydown', (e) => { const t = e.target.closest('.mc-team[data-team]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTeam(Number(t.dataset.team)); } });
}
$('#standings').addEventListener('click', (e) => { const t = e.target.closest('.team-label'); if (t) openTeam(Number(t.closest('tr').dataset.team)); });
$('#standings').addEventListener('keydown', (e) => { const t = e.target.closest('.team-label'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTeam(Number(t.closest('tr').dataset.team)); } });
// Ny stilling tegner kort og rundefaner på nytt. Står tastaturfokus der, settes det tilbake på samme knapp
// (eller samme plass i lista), så polling ikke kaster brukeren tilbake til toppen av siden.
function keepFocus(draw) {
  const a = document.activeElement, box = a && a.closest ? a.closest('#round-tabs, #match-cards, #fav-grid, #round-extra, #round-seed, #tie-table, #tie-playoff, #nom-board, #admin-alert') : null;
  if (!box) return draw();
  const all = () => [...box.querySelectorAll('button, a[href], input, select, textarea')];
  const attr = [...a.attributes].find((x) => x.name.startsWith('data-')), idx = all().indexOf(a);
  draw();
  if (document.activeElement && document.activeElement !== document.body) return;
  const next = (attr && box.querySelector(`[${attr.name}="${CSS.escape(attr.value)}"]`)) || all()[Math.min(idx, all().length - 1)];
  if (next) next.focus({ preventScroll: true });
}
// Rullbare bokser må kunne nås med tastatur, men bare når de faktisk ruller (ellers blir de et unødvendig tabulatorstopp).
function updateScrollFocus() {
  for (const el of [$('.table-wrap'), $('#fav-grid')]) if (el) el.tabIndex = el.scrollWidth > el.clientWidth + 1 ? 0 : -1;
}
window.addEventListener('resize', updateScrollFocus);
function render() {
  if (!state) return;
  const fav = followed();
  // Når plasseringene endres, glir radene til ny plass (View Transitions). Nettlesere uten
  // støtte, og brukere som har slått av animasjoner, får bare den nye tabellen.
  const order = state.table.map((r) => r.name).join('|');
  const moved = lastOrder && order !== lastOrder && tabName === 'table' && !document.hidden;
  lastOrder = order;
  if (moved && document.startViewTransition && !reducedMotion) document.startViewTransition(() => renderTable(fav));
  else renderTable(fav);
  renderCoverStatus();
  renderAdminAlert();
  renderTies();
  trackStandings();

  const live = state.matches.filter((m) => m.status === 'live').length;
  $('#live-indicator').textContent = live ? `${live} kamp${live === 1 ? '' : 'er'} pågår` : 'Ingen kamper pågår';
  $('#live-indicator').classList.toggle('live', live > 0);
  const completed = state.matches.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;


  $('#auth-button').innerHTML = admin ? `Logg ut${user ? ' <span class="auth-user">(' + esc(user) + ')</span>' : ''}` : 'Admin';
  $('#nom-tab').hidden = !admin;
  $('#export-link').hidden = !admin;
  if (!admin && tabName === 'nominations') selectTab('table');
  const fl = finalList();
  $('#final-tab').hidden = !fl;
  if (!fl && tabName === 'final') selectTab('table');
  renderFinalStandings(fl, fav);
  const fb = $('#follow-button');
  fb.textContent = !fav.length ? 'Følg lag' : fav.length === 1 ? `★ ${fav[0]}` : `★ ${fav.length} lag`;
  if (editing === null) renderCards();
  if (refId) renderRef();
  flash(document);
  flashIds = new Set();
}

// ---------- Kampklokke og statuslinje på åpningsflaten --------------------------
// Sekunder igjen av en kamp som pågår, regnet fra når dommeren trykket Start.
// Eldre rader uten starttid faller tilbake til klokkeslettet i kampoppsettet.
// Alle kamper i en runde starter samtidig og varer 15 minutter. Klokka teller derfor
// oppover fra når dommeren trykket Start. Eldre rader uten starttid bruker kampoppsettet.
function elapsed(m) {
  const now = (Date.now() + timeOffset) / 1000;
  if (m.started_at) return Math.max(0, Math.round(now - m.started_at));
  const { secs } = osloClock();
  return Math.max(0, secs - hmToSecs(m.start));
}
const secondsLeft = (m) => m.duration - elapsed(m);
const timeLeftText = (m) => secondsLeft(m) > 0 ? `${mmss(elapsed(m))} spilt` : '15 min spilt · venter på slutt';
// Statuslinjen på åpningsflaten: nedtelling frem til kampdagen. Mens kamper pågår vises ingenting (se Kamper-fanen).
function renderCoverStatus() {
  const el = $('#cover-status');
  if (!el || !state) return;
  const live = state.matches.filter((m) => m.status === 'live');
  const upcoming = state.matches.filter((m) => m.status === 'upcoming' && !m.provisional).map((m) => m.start).sort();
  const { date } = osloClock();
  const day = (d) => Date.UTC(...d.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
  const days = Math.round((day(state.config.date) - day(date)) / 864e5);
  let text;
  const first = clock(state.matches.map((m) => m.start).sort()[0]);
  if (live.length) text = '';
  else if (days > 1) text = `Om ${days} dager: første avspark kl. ${first}`;
  else if (days === 1) text = `I morgen: første avspark kl. ${first}`;
  else if (state.tiePending) text = 'Sluttspillet åpner etter myntkastet';
  else if (upcoming.length) text = `Neste avspark kl. ${clock(upcoming[0])}`;
  else text = 'Turneringen er ferdigspilt';
  if (el.textContent !== text) el.textContent = text;
  el.dataset.live = live.length ? '1' : '';
}
// Klokkene på kampene teller ned lokalt hvert sekund, uten nye kall til serveren.
setInterval(() => {
  if (!state || document.hidden) return;
  document.querySelectorAll('[data-clock]').forEach((el) => { const m = state.matches.find((x) => x.id === Number(el.dataset.clock)); if (m) el.textContent = timeLeftText(m); });
  renderAdminAlert();
}, 1000);

// ---------- Påminnelse til admin: kamper som ikke er avsluttet i appen ----------
// Klokka avslutter ingenting av seg selv lenger, så en glemt «Avslutt» stopper tabellen
// og sluttspilloppsettet. Alle admin-er ser derfor en tydelig liste over slike kamper.
// Står lag helt likt når seriespillet er ferdig, må en admin kaste mynt (og godkjenne) før noen sluttspillkamp
// kan starte. Varselet vises på alle faner, så admin-er ser det uansett hvor de står.
// Innholdet skrives bare når nøkkelen endres (role=alert leses opp én gang per endring).
function renderAdminAlert() {
  const box = $('#admin-alert');
  const late = admin && state ? state.matches.filter((m) => m.status === 'live' && secondsLeft(m) < -60) : [];
  const ties = admin && state && state.tiePending ? activeTies().filter((g) => g.status !== 'approved') : [];
  const key = late.map((m) => `${m.id}:${m.hs}:${m.aws}`).join(',') + '|' + ties.map((g) => `${g.key}:${g.status}`).join(',');
  if (key === renderAdminAlert.key) return;
  renderAdminAlert.key = key;
  box.hidden = !late.length && !ties.length;
  keepFocus(() => {
    const tieHtml = !ties.length ? '' : `<strong>${ties.some((g) => g.status === 'pending') ? 'Myntkast trengs før sluttspillet' : 'Myntkastet må godkjennes'}</strong><span>${ties.map((g) => `${esc(joinNames(g.teams))} (plass ${esc(joinNames(g.positions.map(String)))})`).join('; ')}. Ingen sluttspillkamp kan starte før det er avgjort.</span><div><button type="button" data-tiego="">Gå til myntkastet →</button></div>`;
    const lateHtml = !late.length ? '' : `<strong>${late.length === 1 ? 'Én kamp er' : late.length + ' kamper er'} ikke avsluttet i appen</strong><span>15 minutter er spilt. Tabellen og sluttspillet venter til noen trykker «Avslutt kamp».</span><div>${late.map((m) => `<button type="button" data-ref="${m.id}">Bane ${m.pitch}: ${esc(m.home)} ${score(m.hs)}–${score(m.aws)} ${esc(m.away)} →</button>`).join('')}</div>`;
    box.innerHTML = tieHtml + lateHtml;
  });
}
// «Gå til myntkastet →»: Kamper → Sluttspill, kortet midt på skjermen og fokus på hovedknappen (Kast mynt / Godkjenn).
function goToTie() {
  if (editing !== null) { error('Lagre eller avbryt rettelsen først.'); return; }
  if (tabName !== 'matches') selectTab('matches', 'push');
  changeRound(10);
  const g = activeTies().find((t) => t.status === 'pending') || activeTies().find((t) => t.status !== 'approved');
  const slot = $('#tie-playoff'), card = [...slot.querySelectorAll('.tie-card')].find((c) => g && c.dataset.tieCard === g.key) || slot.querySelector('.tie-card');
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  (card.querySelector('.tie-go') || card.querySelector('.tie-focus'))?.focus({ preventScroll: true });
}
$('#admin-alert').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ref]');
  if (b) openRef(Number(b.dataset.ref));
  else if (e.target.closest('[data-tiego]')) goToTie();
});

// ---------- Kamper-fanen --------------------------------------------------------
function defaultRound() {
  const pick = state.matches.find((m) => m.status === 'live') || state.matches.find((m) => m.status === 'upcoming');
  return pick ? pick.round : 10;
}
function podiumHtml() {
  const p = state.podium;
  if (!p) return '';
  const place = (n, name, cls) => `<li class="${cls}">${name ? `<div class="podium-team">${crest(name)}<strong>${esc(name)}</strong></div>` : '<div class="podium-team pending"><span>Avgjøres i bronsekampen</span></div>'}<div class="podium-step" aria-label="${n}. plass"><span>${n}</span></div></li>`;
  return `<section class="podium" aria-labelledby="podium-title"><div class="podium-head"><span class="eyebrow">Premieutdeling kl. 14.15</span><h3 id="podium-title">Pallen</h3></div><ol class="podium-steps">${place(1, p.first, 'p1')}${place(2, p.second, 'p2')}${place(3, p.third, 'p3')}</ol></section>`;
}
const leagueFinished = () => state.matches.every((m) => m.kind !== 'league' || (m.status === 'finished' && m.hs !== null && m.aws !== null));
function seedingHtml() {
  if (!admin) return '';
  const hasResults = state.matches.some((m) => m.kind === 'playoff' && (m.hs !== null || m.aws !== null));
  // Står lag helt likt, låses oppsettet først når myntkastet er godkjent (serveren avviser manuell låsing så lenge).
  if (!state.seeded && state.tiePending) return '<div class="seed-banner quiet"><p>Oppsettet låses automatisk når myntkastet er godkjent. «Avslutt seriespillet nå» er slått av så lenge.</p></div>';
  if (!state.seeded) return `<div class="seed-banner"><p><strong>Oppsettet er foreløpig.</strong> Det låses automatisk når alle 30 seriekampene er avsluttet. «Avslutt seriespillet nå» avslutter seriespillet med en gang og setter motstanderne etter tabellen slik den står akkurat nå. Kamper som avsluttes eller rettes etterpå, endrer ikke oppsettet, og står lag da helt likt, blir det ikke myntkast.</p><button class="primary" data-seed="lock">Avslutt seriespillet nå</button></div>`;
  const note = freezeNoteHtml();
  if (note) return note;
  return hasResults ? '' : `<div class="seed-banner quiet"><p>Oppsettet er låst etter tabellen.</p><button class="text-button" data-seed="unlock">${leagueFinished() ? 'Sett opp på nytt fra tabellen' : 'Lås opp igjen'}</button></div>`;
}
// Bare admin: lag står helt likt, men oppsettet ble låst uten avgjørelse (fast lagrekkefølge). Vises i Sluttspill og Tabell.
function freezeNoteHtml() {
  const list = admin && state && state.seeded ? frozenTies() : [];
  if (!list.length) return '';
  const hasResults = state.matches.some((m) => m.kind === 'playoff' && (m.hs !== null || m.aws !== null));
  const coin = list.some((g) => !isLodd(g)), lodd = list.some(isLodd);
  const what = coin && lodd ? 'myntkast eller loddtrekning' : lodd ? 'loddtrekning' : 'myntkast';
  const who = list.map((g) => `${joinNames(g.teams)} står helt likt (plass ${joinNames(g.positions.map(String))})`).join('. ');
  const tail = hasResults ? 'Sluttspillet har allerede resultater, så oppsettet kan ikke settes opp på nytt.' : `Vil du ha ${what}? Trykk «Sett opp på nytt fra tabellen».`;
  return `<div class="seed-banner freeze-note"><p>${esc(`${who}, men oppsettet er allerede låst med fast lagrekkefølge. ${tail}`)}</p>${hasResults ? '' : '<button class="primary" data-seed="unlock">Sett opp på nytt fra tabellen</button>'}</div>`;
}
// Admin-kortet følger kampens gang: ikke startet → dommermodus, pågår → dommermodus og
// Avslutt, avsluttet → «Rett resultat». Resultater endres aldri av et feiltrykk:
// rettelser lagres først når man trykker Lagre.
function matchCard(m, showRound = false) {
  const editable = admin && !m.provisional, isEditing = editable && editing === m.id;
  const fav = followed();
  const isFav = isMine(m, fav);
  const winner = m.kind === 'playoff' ? decided(m) : null;
  const won = decided(m), pen = m.status === 'finished' ? penScore(m) : '';
  // Bare admin-er trenger å se at en kamp ikke er avsluttet i appen.
  const late = admin && m.status === 'live' && secondsLeft(m) < -60;
  // Kortet: bane-fane øverst, lagmerker og stort resultat i midten, statusmerke nederst.
  // Under «Rett resultat» byttes midten ut med −/+ for hvert lag.
  const side = (s) => `<div class="mc-team${won ? (won === m[s] ? ' won' : ' lost') : ''}" data-team="${TEAMS.indexOf(m[s])}" role="button" tabindex="0" aria-label="${esc(m[s])}, form og resultater">${crest(m[s])}<b>${esc(m[s])}</b><small>${s === 'home' ? 'Hjemme' : 'Borte'}</small></div>`;
  const rows = isEditing
    ? [['home', 'hs'], ['away', 'aws']].map(([s, field]) => `<div class="score-block"><div class="score-row">${rowTeam(m[s])}<div class="stepper"><button type="button" data-step="-1" aria-label="Ett mål mindre for ${esc(m[s])}">−</button><input aria-label="Mål ${esc(m[s])}" data-field="${field}" type="number" min="0" max="99" step="1" inputmode="numeric" value="${m[field] ?? 0}"><button type="button" data-step="1" aria-label="Ett mål til ${esc(m[s])}">+</button></div></div></div>`).join('')
    : `<div class="mc-body">${side('home')}${pen ? '<div class="mc-mid">' : ''}<div class="mc-score" aria-label="Stilling ${score(m.hs)} mot ${score(m.aws)}${pen ? `, ${pen} etter straffekonkurranse` : ''}">${m.status === 'upcoming' ? '<span class="mc-time">VS</span>' : `${score(m.hs)}<i>:</i>${score(m.aws)}`}</div>${pen ? `<span class="mc-pens" aria-hidden="true">${pen} etter straffekonkurranse</span></div>` : ''}${side('away')}</div>
      <span class="mc-status ${m.status}">${m.status === 'live' ? 'LIVE' : m.status === 'finished' ? 'Slutt' : 'Ikke startet'}</span>`;
  const refButton = (label) => `<button class="primary ref-open" data-ref="${m.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>${label}</button>`;
  let controls = '';
  if (isEditing) {
    const draw = m.kind === 'playoff', pk = pens(m);
    const pensLine = pk && pk.kicks.length ? `<p class="winner-pick">${pk.decided ? `${esc(penWinText({ ...m, status: 'finished', winner: null }))}.` : 'Straffekonkurransen er ikke avgjort.'} Straffene endres i dommermodus. Stillingen kan ikke endres før straffene er angret.</p>` : '';
    controls = `<div class="admin-controls edit-box">
      ${draw ? pensLine || `<label class="winner-pick">Vinner hvis uavgjort (straffer)<select data-field="winner"><option value="">Ikke valgt</option>${[m.home, m.away].map((t) => `<option ${m.winner === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
      <label>Status<select data-field="status">${[['finished', 'Avsluttet'], ['live', 'Pågår'], ['upcoming', 'Ikke startet (nullstiller kampen)']].map(([v, l]) => `<option value="${v}" ${v === m.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="admin-row"><button class="primary" data-save="${m.id}">Lagre rettelse</button><button class="outline dark" data-cancel="${m.id}">Avbryt</button></div>
      <span class="small-note save-message" role="status"></span>
    </div>`;
  } else if (editable) {
    const edit = `<button class="text-button" data-edit="${m.id}">Rett resultat</button>`;
    controls = `<div class="admin-controls">
      ${m.status === 'upcoming' ? `${refButton('Dommermodus – start kampen')}<p class="small-note">Mål kan føres når dommeren har trykket «Start kampen».</p>`
        : m.status === 'live' ? `${refButton('Dommermodus')}${late ? '<p class="late-note">15 minutter er spilt, men kampen er ikke avsluttet i appen.</p>' : ''}<div class="admin-row"><button class="outline dark" data-finish="${m.id}">Avslutt kamp</button>${edit}</div>`
        : `<div class="admin-row"><span class="small-note">Kampen er avsluttet.</span>${edit}</div>`}
      <span class="small-note save-message" role="status">${lastEdit(m)}</span>
    </div>`;
  }
  const isFinal = isFinalMatch(m);
  return `<article class="match ${m.status}${isFav ? ' followed' : ''}${isFinal ? ' final' : ''}${late ? ' late' : ''}" data-id="${m.id}">
    <div class="mc-tab">Bane ${m.pitch}</div>
    ${m.kind === 'playoff' ? `<h3>${isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : ''}${matchTitle(m)}${isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : ''}</h3><p class="small-note pair-note">${topRank(m)}. mot ${Math.max(...m.ranks)}. plass${m.provisional ? ' · foreløpig' : ''}</p>` : ''}
    ${rows}${controls ? `<div class="mc-tray">${controls}</div>` : ''}
    ${m.kind === 'playoff' && m.status === 'finished' && m.hs !== null && m.aws !== null ? `<p class="winner">${winner ? 'Vinner: ' + esc(winner) + (penNote(m, winner) ? ', ' + penNote(m, winner) : '') : 'Uavgjort. Vinneren er ikke avgjort.'}</p>` : ''}
  </article>`;
}
// ---------- Låst sluttspill ---------------------------------------------------
function lockIntroHtml() {
  const league = state.matches.filter((m) => m.kind === 'league');
  const done = league.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;
  // Seriespillet er ferdig, men lag står helt likt: sluttspillet venter på myntkastet (og godkjenningen).
  const waiting = state.tiePending, flipped = waiting && activeTies().every((g) => g.status !== 'pending');
  return `<section class="lock-intro" aria-labelledby="lock-title">${lockCrest()}<div><h3 id="lock-title">${!waiting ? 'Låst til seriespillet er ferdig' : flipped ? 'Venter på godkjenning av myntkastet' : 'Venter på myntkast'}</h3>
    <p>${!waiting ? 'Lagene settes inn automatisk etter tabellen.' : `Alle seriekampene er spilt, men lag står helt likt. Sluttspillet åpnes når ${flipped ? 'en admin har godkjent myntkastet' : 'myntkastet er kastet og godkjent'}.`}</p>
    <div class="lock-progress" role="progressbar" aria-label="Seriekamper ferdigspilt" aria-valuemin="0" aria-valuemax="${league.length}" aria-valuenow="${done}"><span data-pct="${league.length ? Math.round((done / league.length) * 100) : 0}"></span></div>
    <p class="lock-count"><b>${done} av ${league.length}</b> seriekamper spilt</p></div></section>`;
}
function lockedCard(m) {
  const isFinal = isFinalMatch(m), star = isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : '';
  const hi = Math.min(...m.ranks), lo = Math.max(...m.ranks);
  return `<article class="match locked${isFinal ? ' final' : ''}" data-id="${m.id}">
    <div class="mc-tab">Bane ${m.pitch}</div>
    <h3>${star}${matchTitle(m)}${star}</h3><p class="small-note pair-note">Nr. ${hi} mot nr. ${lo} i tabellen</p>
    <div class="lock-body">${lockCrest('lock-crest small')}<div><b class="lock-time">kl. ${m.start.replace(':', '.')}</b><span class="lock-note">${state.tiePending ? 'Åpnes etter myntkastet' : 'Åpnes når sluttspillet er klart'}</span></div></div>
  </article>`;
}

// ---------- Sluttresultat (plass 1–10) -------------------------------------------
// Serveren fyller ut plass 3.-10. så snart de fire andre sluttspillkampene er avsluttet; plass 1.
// og 2. står som null til finalen er ferdig. Feltet er helt null (ikke vist) før det.
function finalList() {
  const f = state && state.finalStandings;
  return Array.isArray(f) && f.length === 10 && f.slice(2).every((n) => typeof n === 'string' && n) ? f : null;
}
const MEDALS = ['gull', 'sølv', 'bronse'];
function finalStandingsHtml(list, fav) {
  const row = (n, i) =>
    n
      ? `<li class="fs-row pair-${Math.floor(i / 2)}${i < 3 ? ' fs-top' : ''}${fav.includes(n) ? ' followed' : ''}"><span class="fs-rank">${i + 1}.</span>${crest(n)}<span class="fs-name">${esc(n)}${i < 3 ? `<span class="sr-only"> (${MEDALS[i]})</span>` : ''}${fav.includes(n) ? '<span class="sr-only"> (følger)</span>' : ''}</span>${i < 3 ? `<span class="fs-medal">${awardCrest('medal' + (i + 1))}</span>` : ''}</li>`
      : `<li class="fs-row fs-tbd"><span class="fs-rank">${i + 1}.</span><span class="fs-name">Avgjøres i finalen</span></li>`;
  const done = list.every((n) => n);
  const lead = done ? 'Turneringen er ferdigspilt' : 'Sluttspillet er nesten ferdig';
  const sub = done ? 'Alle sluttspillkampene er spilt. Dette er de endelige plasseringene.' : 'Plass 3. til 10. er klare. 1. og 2. plass avgjøres når finalen er ferdig.';
  return `<div class="fs-head"><span class="eyebrow">${lead}</span><h2 id="fs-title">Sluttresultat</h2><p>${sub}</p></div><ol class="fs-list" role="list">${list.map(row).join('')}</ol>`;
}
function renderFinalStandings(list, fav) {
  const box = $('#final-standings');
  if (!box) return;
  const html = list ? finalStandingsHtml(list, fav) : '';
  // Skrives bare når innholdet faktisk endres (polling tegner ellers lista på nytt hvert minutt).
  if (renderFinalStandings.html !== html) { renderFinalStandings.html = html; box.innerHTML = html; }
  box.hidden = !list;
}
// Skjermleseren får beskjed når plass 3.-10. blir klare, og igjen når finalen fyller inn 1. og 2. (aldri samme tekst to ganger).
let standingsSeen;
function trackStandings() {
  if (!state || stateKey === null) return; // lagret stilling fra forrige besøk: vent på serveren
  const list = finalList(), key = list ? list.join('|') : '';
  if (standingsSeen === undefined) { standingsSeen = key; return; }
  if (key === standingsSeen) return;
  const first = !standingsSeen;
  standingsSeen = key;
  if (!list) return;
  const done = list.every((n) => n);
  if (done) announce(`Turneringen er ferdigspilt. Sluttresultat: ${list.slice(0, 3).map((n, i) => `${i + 1}. ${n}`).join(', ')}. Hele lista står i en egen fane: Sluttresultat.`);
  else if (first) announce('Plassering 3. til 10. er klare. 1. og 2. plass avgjøres når finalen er ferdig. Se fanen Sluttresultat.');
}

function renderCards() { keepFocus(drawCards); }
function drawCards() {
  if (!state) return;
  const fav = followed();
  if (currentRound === null || (currentRound === 'mine' && !fav.length)) currentRound = defaultRound();
  renderRoundTabs(fav);
  const mineView = currentRound === 'mine';
  $('#fav-grid').hidden = !mineView; $('#match-cards').hidden = mineView;
  $('#tie-playoff').hidden = currentRound !== 10;
  // Sluttresultatet (hele 1.-10.-lista) står i sin egen fane -- bare en lenke dit her, så
  // Sluttspill-visningen ikke blir overfylt når alt er ferdig. renderFinalStandings() selv
  // kalles fra render(), uavhengig av hvilken runde som vises.
  const showLink = currentRound === 10 && finalList();
  $('#final-link').hidden = !showLink;
  if (showLink) $('#final-link').innerHTML = `Turneringen er ferdigspilt. <button type="button" class="text-button" data-goto-final>Se sluttresultatet →</button>`;
  if (mineView) {
    $('#round-description').textContent = `Kampskjema for ${joinNames(fav)}. Tom rute betyr at laget har pause.${admin ? ' Trykk på en kamp for å åpne dommermodus.' : ''}`;
    $('#round-extra').innerHTML = ''; $('#round-seed').innerHTML = '';
    $('#match-cards').innerHTML = '';
    renderFavGrid(fav);
    return;
  }
  // Kampene vises alltid i banenummerets rekkefølge (bane 1 først).
  const inRound = state.matches.filter((m) => m.round === currentRound);
  const ms = [...inRound].sort((x, y) => x.pitch - y.pitch || x.id - y.id);
  // Sluttspillet er låst til alle 30 seriekamper er ferdigspilt. Da settes lagene inn automatisk.
  const locked = currentRound === 10 && !state.seeded;
  const final = currentRound === 10 ? ms.find(isFinalMatch) : null;
  const rest = ms.filter((m) => m !== final);
  const span = (list) => list.length ? `${clock(list.map((m) => m.start).sort()[0])}–${clock(list.map((m) => m.end).sort().pop())}` : '';
  $('#round-description').textContent = currentRound === 10
    ? `Plasseringskamper kl. ${span(rest)} · Finale kl. ${span(final ? [final] : [])}.${locked ? '' : ' Motstanderne er låst etter seriespillet.'}`
    : `Runde ${currentRound}, avspark kl. ${clock(ms[0].start)}, ${ms.length} kamper à 15 minutter.${admin ? ' Dommeren starter og avslutter kampen i dommermodus.' : ''}`;
  // Rekkefølge under Sluttspill: hengelås/pall, så myntkastet (#tie-playoff, tegnes av renderTies), så admin-banneret.
  $('#round-extra').innerHTML = currentRound === 10 ? (locked ? lockIntroHtml() : podiumHtml()) : '';
  const seed = currentRound === 10 ? seedingHtml() : '';
  if ($('#round-seed').innerHTML !== seed) $('#round-seed').innerHTML = seed;
  const bar = document.querySelector('.lock-progress span');
  if (bar) bar.style.setProperty('--w', bar.dataset.pct + '%');
  // Finalen spilles etter plasseringskampene, så den får egen rad under et skille.
  const card = locked ? lockedCard : matchCard;
  $('#match-cards').innerHTML = rest.map((m) => card(m)).join('')
    + (final ? `<div class="final-divider"><span>Deretter · kl. ${final.start.replace(':', '.')}</span></div>${card(final)}` : '');
}

// Favoritter som rutenett: én kolonne per lag, én rad per avsparkstid. Tom rute betyr pause.
function favCell(m, team) {
  const home = m.home === team, opp = home ? m.away : m.home, mine = home ? m.hs : m.aws, theirs = home ? m.aws : m.hs;
  const scored = m.status !== 'upcoming' && mine !== null && theirs !== null;
  // Uavgjort sluttspillkamp avgjort på straffer: seier/tap, med straffene i liten tekst under.
  const w = m.status === 'finished' ? decided(m) : null, note = m.status === 'finished' ? penNote(m, team) : '';
  const result = !scored ? '' : m.status === 'live' ? `${mine}–${theirs}` : mine > theirs ? `Seier ${mine}–${theirs}` : mine < theirs ? `Tap ${mine}–${theirs}`
    : w && note ? `${w === team ? 'Seier' : 'Tap'} ${mine}–${theirs} <small class="fav-pens">${note}</small>` : `Uavgjort ${mine}–${theirs}`;
  const tag = admin && !m.provisional ? 'button' : 'div';
  const isFinal = isFinalMatch(m);
  return `<${tag} ${tag === 'button' ? `type="button" data-ref="${m.id}" ` : ''}class="fav-cell ${m.status}${isFinal ? ' final' : ''}"><span class="fav-top"><b>Bane ${m.pitch}</b><span>${clock(m.start)}–${clock(m.end)}</span></span><span class="fav-opp">mot ${crest(opp)}<span>${esc(opp)}</span></span>${m.kind === 'playoff' ? `<span class="fav-note">${isFinal ? '★ ' : ''}${matchTitle(m)}${m.provisional ? ', foreløpig' : ''}</span>` : ''}${result ? `<span class="fav-result">${result}</span>` : ''}${m.status === 'live' ? '<span class="fav-live">Pågår</span>' : ''}</${tag}>`;
}
function renderFavGrid(fav) {
  const slots = [...new Set(state.matches.map((m) => m.start))].sort();
  const head = `<div class="fav-corner">Tid</div>${fav.map((t) => `<div class="fav-head">${crest(t)}<span>${esc(t)}</span></div>`).join('')}`;
  const rows = slots.map((st) => {
    const inSlot = state.matches.filter((m) => m.start === st), r = inSlot[0], now = inSlot.some((m) => m.status === 'live');
    const label = r.kind === 'playoff' ? (inSlot.some(isFinalMatch) ? 'Finale' : 'Sluttspill') : `Runde ${r.round}`;
    return `<div class="fav-time${now ? ' now' : ''}"><b>${clock(st)}</b><small>${label}</small></div>${fav.map((t) => { const m = inSlot.find((x) => x.home === t || x.away === t); return m ? favCell(m, t) : '<div class="fav-empty"><span class="sr-only">Pause</span></div>'; }).join('')}`;
  }).join('');
  $('#fav-grid').innerHTML = `<div class="fav-grid">${head}${rows}</div>`;
  $('#fav-grid .fav-grid').style.setProperty('--cols', fav.length);
  updateScrollFocus();
}
$('#fav-grid').addEventListener('click', (e) => { const c = e.target.closest('[data-ref]'); if (c && admin) openRef(Number(c.dataset.ref)); });

// «Rett resultat»: alle admin-er kan overstyre resultat og status i etterkant.
// Versjonsnummeret stopper to samtidige rettelser fra å overskrive hverandre.
function startEdit(id) {
  if (editing !== null && editing !== id) { error('Lagre eller avbryt rettelsen du holder på med først.'); return; }
  editing = id; renderCards();
  document.querySelector(`#match-cards [data-id="${id}"] input`)?.focus();
}
function stopEdit() { editing = null; renderCards(); }
async function saveEdit(id) {
  const card = document.querySelector(`#match-cards [data-id="${id}"]`), m = state.matches.find((x) => x.id === id);
  if (!card || !m) return stopEdit();
  const msg = card.querySelector('.save-message'), say = (t) => { msg.textContent = t; };
  if ([...card.querySelectorAll('input')].some((i) => i.value === '' || !i.checkValidity())) { say('Bruk hele mål mellom 0 og 99.'); return; }
  const val = (f) => card.querySelector(`[data-field="${f}"]`)?.value;
  const body = { id, hs: Number(val('hs')), aws: Number(val('aws')), mode: val('status'), winner: val('winner') || null, version: m.version };
  if (body.hs !== body.aws) body.winner = null;
  if (body.mode === 'upcoming' && !(await confirmBox('Nullstille kampen?', `Resultatet for ${m.home} mot ${m.away} slettes, og kampen står som «Ikke startet».`, 'Ja, nullstill'))) return;
  const button = card.querySelector('[data-save]'); button.disabled = true; say('Lagrer …');
  try {
    setState(await api('/api/score', body));
    editing = null; error(''); render(); pageToast('Rettelsen er lagret.');
  } catch (e) {
    button.disabled = false;
    if (e.status === 409) { editing = null; await refresh(true); render(); error(/straff/i.test(e.message) ? e.message : 'En annen admin endret kampen samtidig. Siste resultat vises nå. Rett på nytt om det trengs.'); return; }
    if (e.status === 401 || e.status === 403) { editing = null; return sessionExpired(); }
    say(e.message);
  }
}

// Én felles bekreftelsesdialog – returnerer true/false.
// safe = true: for handlinger som ikke kan angres starter fokus på «Nei, gå tilbake» (Enter avbryter).
function confirmBox(title, text, ok, safe = false) {
  return new Promise((resolve) => {
    const d = $('#confirm-score');
    $('#confirm-title').textContent = title; $('#confirm-copy').textContent = text; $('#confirm-save').textContent = ok;
    d.onclose = () => resolve(d.returnValue === 'confirm');
    d.returnValue = ''; d.showModal();
    if (safe) d.querySelector('button[value="cancel"]')?.focus();
  });
}
// Start, avslutt, åpne igjen og angre start. Stillingen i bekreftelsen er den serveren har.
async function matchAction(id, action, extra = {}) {
  try {
    setState(await api('/api/match', { id, action, ...extra }));
    error(''); render(); return true;
  } catch (e) {
    if (e.status === 401 || e.status === 403) { sessionExpired(); return false; }
    // Uten svar kan handlingen likevel være lagret: hent stillingen så skjermen viser sannheten.
    // Meldingen vises etter hentingen, ellers visker refresh() den bort med error('').
    if (e.status === 409 || e.status >= 500 || e.offline) { await refresh(true); render(); }
    refId ? toast(e.message) : error(e.message);
    return false;
  }
}
// Uavgjort i sluttspillet kan bare avsluttes når straffekonkurransen er avgjort (serveren sjekker det samme og finner vinneren selv).
const needsPens = (m) => m.kind === 'playoff' && m.hs !== null && m.hs === m.aws && !(pens(m) && pens(m).decided);
const PENS_FIRST = 'Uavgjort: kampen avgjøres på straffer før den kan avsluttes.';
async function finishMatch(id) {
  const m = state.matches.find((x) => x.id === id);
  if (!m) return false;
  if (needsPens(m)) {
    if (refId === id) showPens(PENS_FIRST); else openRef(id, true);
    return false;
  }
  const draw = m.kind === 'playoff' && m.hs === m.aws;
  // Stillingen dommeren ser i vinduet sendes med. Har en annen telefon ført et mål i mellomtiden,
  // avviser serveren (409) og appen viser den nye stillingen.
  const seen = { hs: m.hs, aws: m.aws };
  const ok = await confirmBox('Avslutte kampen?', `${m.home} ${score(m.hs)}–${score(m.aws)} ${m.away}${draw ? ` (${penWinText(m)})` : ''} blir sluttresultatet og teller i tabellen.`, 'Ja, avslutt');
  if (!ok) return false;
  const expect = Number.isInteger(seen.hs) && Number.isInteger(seen.aws) ? { expect: seen } : {};
  // Straffevinneren sendes ikke med: serveren finner den fra straffene.
  return matchAction(id, 'finish', expect);
}

$('#match-cards').addEventListener('click', async (e) => {
  const step = e.target.closest('[data-step]');
  if (step) {
    const input = step.parentElement.querySelector('input'), delta = Number(step.dataset.step);
    input.value = Math.min(99, Math.max(0, (Number(input.value) || 0) + delta));
    return;
  }
  const b = (k) => e.target.closest(`[data-${k}]`);
  if (b('ref')) openRef(Number(b('ref').dataset.ref));
  else if (b('finish')) finishMatch(Number(b('finish').dataset.finish));
  else if (b('edit')) startEdit(Number(b('edit').dataset.edit));
  else if (b('save')) saveEdit(Number(b('save').dataset.save));
  else if (b('cancel')) stopEdit();
});
// «Avslutt seriespillet nå» (manuell låsing, bare mulig før alle seriekampene er avsluttet) / «Sett opp på nytt fra tabellen» / «Lås opp igjen». Knappen finnes i Sluttspill (#round-seed)
// og, for låst oppsett med likt lag, også i Tabell (#tie-table).
async function seedAction(e) {
  const b = e.target.closest('[data-seed]');
  if (!b) return;
  const lock = b.dataset.seed === 'lock';
  const done = leagueFinished();
  // Står lag helt likt uten avgjørelse (også etter låsing), låses sluttspillet igjen til myntkastet er avgjort.
  const tied = tieList().some((g) => g.status === 'pending');
  const redo = tied ? 'Lag står helt likt: sluttspillet låses til myntkastet er avgjort. Deretter settes lagene inn etter tabellen.' : 'Lagene settes straks inn på nytt etter tabellen slik den står nå.';
  // Manuell låsing vises bare mens seriespillet ikke er ferdig: den avslutter altså seriespillet før tiden. Si det rett ut, med antallet.
  const league = state.matches.filter((m) => m.kind === 'league'), played = league.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;
  const early = played < league.length ? `Bare ${played} av ${league.length} seriekamper er avsluttet. ` : '';
  const ok = await confirmBox(lock ? 'Avslutte seriespillet nå?' : done ? 'Sette opp sluttspillet på nytt?' : 'Låse opp oppsettet?',
    lock ? `${early}Trykker du «Ja», avsluttes seriespillet med en gang, og sluttspillet settes opp etter tabellen slik den står nå. Seriekamper som spilles eller rettes etterpå, endrer ikke oppsettet. Står lag da helt likt, blir det ikke myntkast: de settes i fast lagrekkefølge. Du kan låse opp igjen senere.`
      : done ? `${redo} Bruk dette hvis du har rettet et seriespillresultat${tied ? ', eller for å avgjøre likt lag med myntkast' : ''}.`
        : 'Oppsettet følger tabellen igjen til alle seriekampene er avsluttet. Står lag da helt likt om en sluttspillplass, avgjøres det med myntkast.',
    lock ? 'Ja, avslutt seriespillet' : done ? 'Ja, sett opp på nytt' : 'Ja, lås opp');
  if (!ok) return;
  try { setState(await api('/api/seeding', { action: b.dataset.seed })); error(''); render(); renderCards(); } catch (err) { error(err.message); }
}
$('#round-seed').addEventListener('click', seedAction);
$('#tie-table').addEventListener('click', seedAction);

// ---------- Myntkast: lag som står helt likt før sluttspillet -------------------
// Serveren trekker utfallet (bare der) og lagrer det som forslag; en admin godkjenner, og da åpnes
// sluttspillet. Mynten her er bare visning: den spinner fra trykket og lander på serverens svar.
// Eldre servere uten «ties» gir tom liste, så ingenting vises.
function tieList() { return state && Array.isArray(state.ties) ? state.ties.filter((g) => g && Array.isArray(g.teams) && g.teams.length > 1 && Array.isArray(g.positions) && g.positions.length === g.teams.length) : []; }
// afterFreeze: oppsettet ble låst før gruppen fikk en avgjørelse (fast lagrekkefølge). Serveren avviser kast på dem,
// så de vises bare som en merknad til admin (og myntmerket i tabellen), ikke som myntkast-kort.
const activeTies = () => tieList().filter((g) => !g.afterFreeze);
const frozenTies = () => tieList().filter((g) => g.afterFreeze && g.status === 'pending');
// Grupper som fortsatt venter, bortsett fra g: styrer om sluttspillet åpnes med en gang etter denne avgjørelsen.
const tiesLeft = (g) => activeTies().filter((t) => t.key !== g.key && t.status !== 'approved').length;
function isLodd(g) { return g.teams.length > 2; }
// Hva en plass i tabellen spiller om i sluttspillet: plass 1–2 finalen, 3–4 bronsekampen, 5–6 kampen om 5. plass osv.
function stakeOf(p) {
  const m = state && state.matches.find((x) => x.kind === 'playoff' && Array.isArray(x.ranks) && x.ranks.includes(p));
  const low = m ? Math.min(...m.ranks) : p - ((p - 1) % 2);
  return low === 1 ? 'finalen' : low === 3 ? 'bronsekampen' : `kampen om ${low}. plass`;
}
// «plass 2 (finalen) og plass 3 og 4 (bronsekampen)»: påfølgende plasser med samme kamp slås sammen.
function stakesText(positions) {
  const parts = [];
  for (const p of positions) { const s = stakeOf(p), last = parts[parts.length - 1]; if (last && last.s === s) last.p.push(p); else parts.push({ s, p: [p] }); }
  return joinNames(parts.map((x) => `plass ${joinNames(x.p.map(String))} (${x.s})`));
}
const placeText = (g, k) => `plass ${g.positions[k]} (${stakeOf(g.positions[k])})`;
// Hvorfor innbyrdes kamp ikke avgjorde (h2h fra serveren). Uten feltet (eldre server): ingen forklaring.
function tieReason(g) {
  const two = g.teams.length === 2;
  if (g.h2h === 'never') return two ? ', og de har ikke møtt hverandre i serien' : ', og ingen av dem har møtt hverandre i serien';
  if (g.h2h === 'partial') return ', men ikke alle av dem har møtt hverandre, så innbyrdes kamper telles ikke';
  if (g.h2h === 'level') {
    const m = two && state.matches.find((x) => x.kind === 'league' && g.teams.includes(x.home) && g.teams.includes(x.away) && x.hs !== null && x.aws !== null);
    return m ? `, og innbyrdes kamp endte ${m.hs}–${m.aws}` : two ? ', og innbyrdes kamp skiller dem ikke' : ', og innbyrdes kamper skiller dem ikke';
  }
  return null;
}
function tiePendingText(g) {
  const names = joinNames(g.teams), why = tieReason(g);
  const first = why === null ? `${names} står helt likt etter alle reglene.` : `${names} har like mange poeng, samme målforskjell og like mange scorede mål${why}.`;
  return `${first} ${isLodd(g) ? `Loddtrekning avgjør rekkefølgen: ${stakesText(g.positions)}.` : `Et myntkast avgjør hvem som får ${placeText(g, 0)} og hvem som får ${placeText(g, 1)}.`}`;
}
const tieBusy = new Map(), ownTie = new Set(), tieReveal = new Set(), tieHtml = {};
let coinRun = null, tieSeen = null, tieSeeded = null, tieFocus = null;
// Midtsirkelen med midtlinje: myntens nøytrale side før kastet.
const COIN_MARK = '<svg class="coin-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><path d="M20 3v34" stroke="currentColor" stroke-width="2.4"/><circle cx="20" cy="20" r="9.5" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="20" cy="20" r="2.6" fill="currentColor"/></svg>';
const coinHtml = (front, back = '', cls = '') => `<div class="coin${cls}" aria-hidden="true"><div class="coin-spin"><div class="coin-face front">${front}</div><div class="coin-face back">${back}</div></div></div>`;
const tieOrder = (g) => (Array.isArray(g.order) && g.order.length === g.teams.length ? g.order : g.teams);
const tieOrderText = (g, o = tieOrder(g)) => isLodd(g) ? o.map((n, k) => `${g.positions[k]}. ${n}`).join(', ') : `${o[0]} foran ${o[1]}`;
// Rekkefølgen med hva hver plass spiller om: «Echo får plass 2 (finalen), Delta plass 3 (bronsekampen)».
const tieStakeOrder = (g, o = tieOrder(g)) => o.map((n, k) => `${n} ${k ? '' : 'får '}${placeText(g, k)}`).join(', ');
const tieFinalText = (g) => `${g.kind === 'fixed' ? 'Fast rekkefølge' : isLodd(g) ? 'Loddtrekning avgjorde' : 'Myntkast avgjorde'}: ${tieOrderText(g)}`;
const coinResultText = (o, g) => `${o[0]} vant myntkastet og tar ${placeText(g, 0)}.`;
const coinLoserText = (o, g) => `${o[1]} får ${placeText(g, 1)}.`;
const tieProposalText = (g) => isLodd(g) ? `Loddtrekning: ${tieOrder(g).map((n, k) => `${g.positions[k]}. ${n} (${stakeOf(g.positions[k])})`).join(', ')}` : `Myntkast: ${tieOrder(g)[0]} vant og tar ${placeText(g, 0)}. ${coinLoserText(tieOrder(g), g).slice(0, -1)}`;
// Når åpnes sluttspillet etter denne avgjørelsen? Bare «med en gang» hvis ingen annen gruppe venter.
const opensText = (g) => { const n = tiesLeft(g); return n ? `Sluttspillet åpnes når alle myntkast er avgjort (${n} igjen).` : 'Sluttspillet åpnes med en gang.'; };
function tieCard(g, slot, i) {
  const lodd = isLodd(g), word = lodd ? 'Loddtrekning' : 'Myntkast', busy = tieBusy.get(g.key), o = tieOrder(g), id = `tie-${slot}-${i}`;
  const cls = `tie-card is-${g.status}${tieReveal.has(g.key) ? ' reveal' : ''}${ownTie.has(g.key) ? ' own' : ''}${busy ? ' busy' : ''}`;
  if (g.status === 'approved') {
    return `<div class="${cls}" data-tie-card="${esc(g.key)}">${coinHtml(crest(o[0]), '', ' small')}<p class="tie-final tie-focus" tabindex="-1"><b>${g.kind === 'fixed' ? 'Fast rekkefølge' : word + ' avgjorde'}:</b> ${esc(tieOrderText(g))}</p></div>`;
  }
  // Knappene deaktiveres med aria-disabled mens svaret er underveis: da beholder tastaturfokus plassen sin.
  const act = (a, label, c) => `<button type="button" class="${c}" data-tie="${a} ${esc(g.key)}"${busy ? ' aria-disabled="true"' : ''}>${label}</button>`;
  let body, actions = '';
  if (g.status === 'pending') {
    body = busy === 'flip' ? `<p class="tie-text">${lodd ? 'Loddene trekkes …' : 'Mynten er i lufta …'}</p>`
      : `<p class="tie-text">${esc(tiePendingText(g))}</p><p class="tie-meta">${admin ? `Trykk «${lodd ? 'Trekk lodd' : 'Kast mynt'}». Du kan godkjenne selv etterpå.` : 'Venter på en admin.'}</p>`;
    if (admin) actions = act('flip', busy === 'flip' ? (lodd ? 'Trekker …' : 'Kaster …') : lodd ? 'Trekk lodd' : 'Kast mynt', 'primary tie-go')
      + act('fallback', busy === 'fallback' ? 'Lagrer …' : 'Bruk fast rekkefølge i stedet', 'text-button tie-alt');
  } else {
    const when = g.at && /T\d\d:\d\d/.test(g.at) ? ' kl. ' + esc(g.at.slice(11, 16).replace(':', '.')) : '';
    body = `<p class="tie-result tie-focus" tabindex="-1">${lodd ? 'Rekkefølgen er trukket:' : `${esc(coinResultText(o, g))} <span class="tie-sub">${esc(coinLoserText(o, g))}</span>`}</p>`
      + (lodd ? `<ol class="tie-order">${o.map((n, k) => `<li>${crest(n)}<span><b>${esc(g.positions[k])}.</b> ${esc(n)} <small class="tie-stake">(${esc(stakeOf(g.positions[k]))})</small></span></li>`).join('')}</ol>` : '')
      + `<p class="tie-meta">${admin ? 'Kontroller og trykk «Godkjenn». Du kan godkjenne selv.' : 'Venter på godkjenning fra en admin.'}${admin && g.by ? ` ${lodd ? 'Trukket' : 'Kastet'} av ${esc(g.by)}${when}.` : ''}</p>`;
    if (admin) actions = act('approve', busy ? 'Godkjenner …' : 'Godkjenn', 'primary tie-go');
  }
  const coin = g.status === 'pending' ? coinHtml(COIN_MARK, COIN_MARK) : coinHtml(crest(o[0]));
  return `<article class="${cls}" data-tie-card="${esc(g.key)}" aria-labelledby="${id}">${coin}<div class="tie-body"><h3 id="${id}">${word}</h3>${body}${actions ? `<div class="tie-actions">${actions}</div>` : ''}</div></article>`;
}
// Skjermleseren får én kort beskjed per endring (ikke ved hver henting). Samme tekst skrives aldri to ganger på rad.
function announce(text) { const el = $('#tie-live'); if (el && text && el.textContent !== text) el.textContent = text; }
function trackTies() {
  if (!state || stateKey === null) return; // lagret stilling fra forrige besøk: vent på serveren
  const list = tieList();
  if (tieSeen === null) { tieSeen = new Map(list.filter((g) => !g.afterFreeze).map((g) => [g.key, g.status])); tieSeeded = !!state.seeded; return; }
  const msgs = [];
  for (const g of list) {
    if (g.afterFreeze) continue; // låst uten avgjørelse: bare en merknad til admin, ingen beskjed til publikum
    if (coinRun && coinRun.key === g.key) continue; // kastet vises først når mynten har landet
    const prev = tieSeen.get(g.key);
    if (prev === g.status) continue;
    tieSeen.set(g.key, g.status);
    if (g.status === 'pending') msgs.push(`${joinNames(g.teams)} står helt likt. ${isLodd(g) ? 'Loddtrekning' : 'Et myntkast'} avgjør ${stakesText(g.positions)}.`);
    else if (g.status === 'proposed') { msgs.push(`${tieProposalText(g)}. Venter på godkjenning.`); if (!ownTie.has(g.key) || isLodd(g)) tieReveal.add(g.key); }
    else msgs.push(`${tieFinalText(g)}.`);
  }
  if (tieSeeded === false && state.seeded && list.length) msgs.push('Sluttspillet er åpnet.');
  tieSeeded = !!state.seeded;
  if (msgs.length) announce(msgs.join(' '));
}
function drawTies() {
  const list = activeTies();
  for (const [sel, slot] of [['#tie-table', 't'], ['#tie-playoff', 'p']]) {
    const el = $(sel);
    if (!el || (coinRun && coinRun.slot === el)) continue; // mynten er i lufta her: ikke tegn over den
    // I Sluttspill står merknaden om låst oppsett i #round-seed (seedingHtml); i Tabell her, under kortene.
    const html = list.map((g, i) => tieCard(g, slot, i)).join('') + (slot === 't' ? freezeNoteHtml() : '');
    if (tieHtml[sel] !== html) { tieHtml[sel] = html; el.innerHTML = html; }
  }
}
function renderTies() {
  if (!state) return;
  trackTies();
  keepFocus(drawTies);
  tieReveal.clear();
  if (tieFocus) {
    const [slot, key] = tieFocus; tieFocus = null;
    const card = [...slot.querySelectorAll('.tie-card')].find((c) => c.dataset.tieCard === key);
    const target = card ? card.querySelector('.tie-focus') : slot.querySelector('.tie-focus');
    if (target && !slot.hidden) {
      target.focus({ preventScroll: true });
      // Etter kastet: «Godkjenn» skal synes (ikke gjemt under fanelinjen nederst). Fokus blir stående på resultatet,
      // så skjermleseren leser utfallet; scroll-padding/scroll-margin i CSS holder knappen over fanelinjen.
      const go = card && card.querySelector('[data-tie^="approve"]');
      if (go) go.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  }
}
// Mynten: spinner så lenge svaret er underveis, og lander på vinnerens side når det kommer.
const canAnimate = () => !reducedMotion && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
function startCoin(slot, g) {
  const card = [...slot.querySelectorAll('.tie-card')].find((c) => c.dataset.tieCard === g.key);
  const coin = card && card.querySelector('.coin'), spin = coin && coin.querySelector('.coin-spin');
  if (!spin) return null;
  const front = spin.querySelector('.front'), back = spin.querySelector('.back'), lodd = isLodd(g), PERIOD = 260;
  let shuffle = null, idle;
  coinRun = { key: g.key, slot };
  card.classList.add('flipping');
  const lift = coin.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-16px) scale(1.24)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
  if (lodd) {
    let i = 0; back.innerHTML = '';
    const next = () => { front.innerHTML = crest(g.teams[i++ % g.teams.length]); };
    next(); shuffle = setInterval(next, 150);
    idle = spin.animate([{ transform: 'rotateY(-28deg)' }, { transform: 'rotateY(28deg)' }], { duration: 300, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
  } else {
    front.innerHTML = crest(g.teams[0]); back.innerHTML = crest(g.teams[1]);
    idle = spin.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(360deg)' }], { duration: PERIOD, iterations: Infinity });
  }
  const stop = () => { clearInterval(shuffle); for (const a of [...coin.getAnimations(), ...spin.getAnimations()]) a.cancel(); card.classList.remove('flipping'); };
  return {
    stop,
    // Lander på serverens rekkefølge. Løses når mynten ligger stille (ca. 1,8 s for mynt, 0,8 s for lodd).
    land(t) {
      const o = t && Array.isArray(t.order) ? t.order : null;
      if (!o) { stop(); return Promise.resolve(); }
      lift.finish(); clearInterval(shuffle);
      const down = (ms) => coin.animate([{ transform: 'translateY(-16px) scale(1.24)', offset: 0 }, { transform: 'translateY(-24px) scale(1.3)', offset: 0.3 }, { transform: 'translateY(0) scale(1)', offset: 1 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
      let turn;
      if (lodd) {
        idle.cancel(); front.innerHTML = crest(o[0]);
        turn = spin.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0deg)' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.3,1.25)', fill: 'forwards' });
        down(700);
      } else {
        const from = (((idle.currentTime || 0) % PERIOD) / PERIOD) * 360;
        idle.cancel();
        const to = Math.ceil((from + 1080) / 360) * 360 + (o[0] === g.teams[1] ? 180 : 0);
        turn = spin.animate([{ transform: `rotateY(${from}deg)` }, { transform: `rotateY(${to}deg)` }], { duration: 1800, easing: 'cubic-bezier(.3,.9,.35,1)', fill: 'forwards' });
        down(1800);
      }
      return turn.finished.then(() => { card.classList.add('landed'); return new Promise((r) => setTimeout(r, 350)); }, () => {});
    },
  };
}
async function tieAction(b) {
  const raw = b.dataset.tie || '', cut = raw.indexOf(' '), action = raw.slice(0, cut), key = raw.slice(cut + 1);
  if (!admin || tieBusy.size || coinRun) return; // ett kall om gangen; dobbelttrykk gjør ingenting
  const g = activeTies().find((t) => t.key === key);
  if (!g) return;
  const slot = b.closest('.tie-slot'), lodd = isLodd(g), names = joinNames(g.teams);
  const ask = action === 'flip'
    ? [lodd ? `Trekk lodd mellom ${names}?` : `Kast mynt mellom ${names}?`, `${lodd ? `Loddtrekningen avgjør ${stakesText(g.positions)}` : `Vinneren får ${placeText(g, 0)}, den andre ${placeText(g, 1)}`}. Resultatet kan ikke angres. Etterpå må det godkjennes, og det kan du gjøre selv.`, lodd ? 'Ja, trekk lodd' : 'Ja, kast mynt']
    : action === 'approve'
      ? [`Godkjenne ${lodd ? 'loddtrekningen' : 'myntkastet'}?`, `${tieStakeOrder(g)}. ${opensText(g)}`, 'Ja, godkjenn']
      : ['Bruke fast rekkefølge?', `Ingen ${lodd ? 'lodd trekkes' : 'mynt kastes'}: ${tieStakeOrder(g, g.teams)}, etter rekkefølgen i lagslista. Dette er endelig. ${opensText(g)}`, 'Ja, bruk fast rekkefølge'];
  // Handlingene kan ikke angres: dialogen åpner med fokus på «Nei, gå tilbake», så Enter to ganger aldri kaster mynten.
  if (!(await confirmBox(...ask, true))) return;
  if (tieBusy.size || coinRun || !admin) return;
  tieBusy.set(key, action); ownTie.add(key);
  renderTies();
  const run = action === 'flip' && slot && canAnimate() ? startCoin(slot, g) : null;
  try {
    const next = await api('/api/tiebreak', { action, key });
    const seq = stateSeq;
    if (run) await run.land(Array.isArray(next.ties) ? next.ties.find((t) => t.key === key) : null);
    // Mens mynten var i lufta kan en henting ha gitt nyere stilling. Den beholdes; ellers brukes svaret på kastet.
    const num = (k) => (/^\d+$/.test(String(k)) ? Number(k) : NaN);
    const newer = stateSeq !== seq && state && num(state.key) >= num(next.key);
    if (!newer) { setState(next); cacheState(next); }
    if (stateSeq !== seq && !newer && Number.isNaN(num(next.key))) refresh(true).then(() => render()); // ukjent nøkkelformat: hent sannheten
    error('');
    if (slot) tieFocus = [slot, key];
  } catch (e) {
    if (run) run.stop();
    coinRun = null; tieBusy.delete(key); ownTie.delete(key);
    if (e.status === 401 || e.status === 403) return sessionExpired();
    // Uten svar kan handlingen likevel være lagret: hent stillingen så skjermen viser sannheten.
    // Feilmeldingen settes etterpå, ellers visker en vellykket henting den bort med en gang.
    if (e.status === 409 || e.status >= 500 || e.offline) await refresh(true);
    error(e.message);
  } finally {
    coinRun = null; tieBusy.delete(key);
    render();
    ownTie.delete(key);
  }
}
for (const sel of ['#tie-table', '#tie-playoff']) $(sel).addEventListener('click', (e) => { const b = e.target.closest('[data-tie]'); if (b) tieAction(b); });

function changeRound(r) {
  if (editing !== null) { error('Lagre eller avbryt rettelsen først.'); return; }
  currentRound = r; renderCards();
}
// Følger du lag, får du en egen fane først med alle kampene deres.
function renderRoundTabs(fav) {
  const tabs = [...(fav.length ? [['mine', '★ Favoritter']] : []), ...Array.from({ length: 10 }, (_, i) => [i + 1, i === 9 ? 'Sluttspill' : 'Runde ' + (i + 1)])];
  const first = (r) => state.matches.find((m) => m.round === r);
  const tabLabel = (r) => r === 'mine' ? `<small>Mine lag</small><b>★</b><small>Favoritter</small>` : r === 10 ? `<small>Sluttspill</small><b>${state.seeded ? '★' : '<svg class="tab-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'}</b><small>${clock(first(r).start)}</small>` : `<small>Runde</small><b>${r}</b><small>${clock(first(r).start)}</small>`;
  // Runden med en kamp som pågår får en grønn prikk.
  const liveRound = state.matches.find((m) => m.status === 'live')?.round;
  $('#round-tabs').innerHTML = tabs.map(([r, name]) => `<button data-round="${r}" aria-pressed="${r === currentRound}" aria-label="${esc(name)}${r === 10 && !state.seeded ? (state.tiePending ? ' (låst til myntkastet er godkjent)' : ' (låst til seriespillet er ferdig)') : ''}${r === liveRound ? ' (kamp pågår)' : ''}" class="${r === currentRound ? 'active' : ''}${r === liveRound ? ' has-live' : ''}${r === 'mine' ? ' mine-tab' : ''}">${tabLabel(r)}</button>`).join('');
  centerRound(false);
}
// Midtstill valgt runde i den vannrette lista, men bare når runden eller fanen endres,
// så vi ikke overstyrer brukerens egen scrolling.
let lastCentered = null;
function centerRound(force) {
  const c = $('#round-tabs'), a = c.querySelector('.active');
  if (!a || !c.offsetParent || (!force && lastCentered === currentRound)) return;
  lastCentered = currentRound;
  c.scrollLeft += a.getBoundingClientRect().left - c.getBoundingClientRect().left - (c.clientWidth - a.offsetWidth) / 2;
}
$('#round-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-round]'); if (b) { changeRound(b.dataset.round === 'mine' ? 'mine' : Number(b.dataset.round)); } });
$('#final-link').addEventListener('click', (e) => { if (e.target.closest('[data-goto-final]')) selectTab('final', 'push'); });

let tabName = 'table';
// Fanene har egne adresser (#tabell, #kamper …), så Tilbake-knappen går mellom faner og lenker kan peke rett på en fane.
// how: 'push' (trykk på fane: ny historikk-oppføring), 'replace' (fanen byttes av appen) eller ingenting (fra Tilbake/Frem).
const TAB_HASH = { table: 'tabell', matches: 'kamper', final: 'sluttresultat', awards: 'utmerkelser', rules: 'regler', nominations: 'nominert' };
function tabFromHash() {
  let h = ''; try { h = decodeURIComponent(String((typeof location !== 'undefined' && location.hash) || '').slice(1)).toLowerCase(); } catch {}
  return h === '' ? '' : Object.keys(TAB_HASH).find((k) => TAB_HASH[k] === h) || null;
}
function setTabHash(name, how) {
  if (!how || typeof history === 'undefined' || !history.pushState || tabFromHash() === name) return;
  // Ingen fane i adressen ennå og appen bytter selv (f.eks. etter innlogging): ikke fyll adressen.
  if (how === 'replace' && tabFromHash() === '') return;
  try { history[how === 'push' ? 'pushState' : 'replaceState'](null, '', '#' + TAB_HASH[name]); } catch {}
}
function selectTab(name, how = 'replace') {
  setTabHash(name, how);
  tabName = name; document.body.dataset.tab = name;
  if (name === 'nominations') loadNoms();
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== name));
  document.querySelectorAll('button[data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'));
  // Bytter du fane langt nede på siden, hopper vi til toppen av den nye fanen.
  const anchor = $('.connection');
  if (anchor.getBoundingClientRect().top < 0) anchor.scrollIntoView({ block: 'start' });
  if (name === 'matches') centerRound(true);
  // Tabellen kan ha blitt tegnet mens fanen var skjult (bredde 0): regn ut på nytt om den ruller.
  updateScrollFocus();
}
// Bare knappene i fanelinjen: <body> har også data-tab (settes i selectTab) og skal ikke lytte, ellers hopper siden til toppen ved hvert klikk.
document.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab, 'push')));
// Tilbake/Frem: bytt til fanen i adressen. Andre ankere (#innhold fra hopp-lenken, #table) lar fanen være.
function tabFromAddress() {
  const t = tabFromHash();
  if (t === null) return;
  const name = t || 'table';
  if (name === 'nominations' && !admin) return;
  if (name === 'final' && !finalList()) return;
  if (name === tabName) return;
  selectTab(name, null);
  // Sto fokus i fanen som ble skjult, flyttes det til fanevalget (ikke til toppen av siden).
  const a = document.activeElement;
  if (a && a.closest && a.closest('.panel[hidden]')) document.querySelector(`[data-tab="${name}"]`)?.focus({ preventScroll: true });
}
addEventListener('popstate', tabFromAddress);

// ---------- Dommermodus (fullskjerm) -------------------------------------------
// Laget for en dommer med telefonen i én hånd ute ved banen: store flater, ett trykk = ett mål,
// og tre faste steg: Start kampen → trykk på laget som scorer → Avslutt kampen.
let refOpener = null, refId = null, askPens = false, pensBusy = false, lastPenTap = 0, goalChain = Promise.resolve(), goalsPending = 0, clockTimer = null, wakeLock = null, toastTimer = null;
const lastGoalTap = { home: 0, away: 0 }, buzzed = new Set();
// Skjermen holdes våken som normalt (wake lock) -- ingen innstilling å huske på. Men en telefon
// kan likevel sovne (dommeren legger den bevisst i lomma, batterisparing, eller trykker selv på
// av/på-knappen -- nettleseren slipper da wake locken av seg selv). Kommer dommermodus tilbake i
// bildet etter å ha vært skjult, kreves ett bekreftende trykk til på akkurat det FØRSTE målet, i
// tilfelle telefonen ble tatt opp av lomma med et trykk midt oppi. Deretter er det ett trykk igjen,
// helt til den ev. sovner på nytt.
let armedSide = null, armedTimer = null, guardNextGoal = false, refWasHidden = false;
function disarmGoal(announce) {
  clearTimeout(armedTimer); armedTimer = null;
  if (!armedSide) return;
  armedSide = null;
  if (announce) { const el = $('#ref-goal-status'); if (el) el.textContent = 'Ikke bekreftet. Trykk på nytt for å registrere mål.'; }
  renderRef();
}
function armGoal(side) {
  clearTimeout(armedTimer);
  armedSide = side;
  guardNextGoal = false;
  const m = refMatch();
  armedTimer = setTimeout(() => disarmGoal(true), 4000);
  const el = $('#ref-goal-status');
  if (el && m) el.textContent = `Trykk ${m[side]} én gang til for å bekrefte mål.`;
  renderRef();
}
// Kalles fra visibilitychange når dommermodus er åpen og siden var skjult (skjermen sovnet/telefon
// låst) og nå vises igjen. Ber om wake lock på nytt (den ble sluppet automatisk da siden ble skjult)
// og krever bekreftelse på neste måltrykk.
async function refReturned() {
  if (!refId) return;
  if (!wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; } }
  guardNextGoal = true;
  toast('Skjermen sovnet mens du var borte. Neste mål må bekreftes med to trykk.');
  const el = $('#ref-goal-status');
  if (el) el.textContent = 'Skjermen sovnet. Neste mål må bekreftes med to trykk.';
}
// Kamper der dommeren har bekreftet at lagene kjenner straffereglene (bare i minnet: ved ny innlasting spørres det igjen, før første straffe).
const pensAcked = new Set();
const ref = $('#ref');
const refMatch = () => state && state.matches.find((x) => x.id === refId);
function renderRef() {
  const m = refMatch();
  if (!m) return closeRef(true);
  const live = m.status === 'live', done = m.status === 'finished', upcoming = m.status === 'upcoming';
  ref.style.setProperty('--home', teamColor(m.home));
  ref.style.setProperty('--away', teamColor(m.away));
  ref.dataset.phase = m.status;
  $('#ref-title').textContent = `${matchTitle(m)} · Bane ${m.pitch}`;
  // Straffene er i gang: målflatene er låst, så et trykk på laget aldri blir et ekstra mål i stedet for en straffe.
  const shootout = live && pensStarted(m);
  if (!live || shootout) armedSide = null, guardNextGoal = false, clearTimeout(armedTimer);
  for (const side of ['home', 'away']) {
    const f = side === 'home' ? 'hs' : 'aws';
    const el = ref.querySelector(`.ref-side[data-side="${side}"]`), goalBtn = el.querySelector('.ref-goal');
    const armed = armedSide === side;
    el.querySelector('.ref-crest').innerHTML = crest(m[side]);
    el.querySelector('.ref-name').textContent = m[side];
    el.querySelector('.ref-score').textContent = upcoming ? '–' : m[f] ?? 0;
    el.querySelector('.ref-hint').textContent = upcoming ? 'Start kampen først' : done ? 'Avsluttet' : shootout ? 'Straffer' : armed ? 'Trykk igjen for å bekrefte' : 'Trykk for mål';
    el.classList.toggle('is-armed', armed);
    goalBtn.disabled = !live || shootout;
    goalBtn.setAttribute('aria-label', live && !shootout ? (armed ? `Bekreft mål til ${m[side]}. Stilling ${m[f] ?? 0}` : `Mål til ${m[side]}. Stilling ${m[f] ?? 0}`) : `${m[side]}: ${m[f] ?? 0}`);
    el.querySelector('.ref-undo').disabled = !live || !m[f] || shootout;
    el.querySelector('.ref-undo').setAttribute('aria-label', `Fjern ett mål fra ${m[side]}`);
  }
  if (!(live && m.kind === 'playoff' && m.hs === m.aws)) askPens = false;
  renderPens(m);
  $('#ref-howto').hidden = !upcoming;
  $('#ref-start').hidden = !upcoming;
  $('#ref-finish').hidden = !live;
  $('#ref-unstart').hidden = !(live && m.hs === 0 && m.aws === 0 && !shootout);
  $('#ref-reopen').hidden = !done;
  $('#ref-done').hidden = !done;
  // Siden bak dommermodus er inert (varselet der når ikke dommeren), så myntkastet nevnes her også.
  if (done) $('#ref-done').innerHTML = esc(`Slutt: ${m.home} ${m.hs}–${m.aws} ${m.away}${m.kind === 'playoff' && m.hs === m.aws && penWinText(m) ? ` (${penWinText(m)})` : ''}. Husk: vestene henges i målet.`)
    + (state.tiePending ? '<span class="ref-tie">Sluttspillet venter på myntkast: se Kamper → Sluttspill.</span>' : '');
  const next = done && nextOnPitch(m);
  $('#ref-next').hidden = !next;
  if (next) $('#ref-next').textContent = `Neste kamp på bane ${m.pitch}: kl. ${clock(next.start)}, ${next.home} mot ${next.away} →`;
  $('#ref-nominate').hidden = !!m.provisional;
  renderRefNoms();
  $('#ref-edit').textContent = goalsPending || pensBusy ? 'Lagrer …' : lastEdit(m);
  tickClock();
}
// ---------- Straffekonkurranse i dommermodus --------------------------------------
// Straffer er ført (eller avgjort) i en uavgjort sluttspillkamp.
const pensStarted = (m) => m.kind === 'playoff' && m.hs !== null && m.hs === m.aws && !!pens(m) && (pens(m).kicks.length > 0 || !!pens(m).decided);
// Panelet vises bare i en uavgjort sluttspillkamp som pågår, og først når det trengs: tiden er ute,
// dommeren har trykket «Avslutt kampen», eller straffene er allerede i gang (f.eks. fra en annen telefon).
function pensOn(m) {
  if (!m || m.status !== 'live' || m.kind !== 'playoff' || m.provisional || m.hs === null || m.hs !== m.aws) return false;
  return askPens || secondsLeft(m) <= 0 || pensStarted(m);
}
// Hakemerke for mål, kryss for bom (formen skiller dem, ikke bare fargen).
const PEN_MARK = { made: '<path d="M6.5 12.6l3.6 3.6 7.4-7.6"/>', miss: '<path d="M7.6 7.6l8.8 8.8M16.4 7.6l-8.8 8.8"/>' };
const PEN_WORD = { made: 'mål', miss: 'bom', next: 'skal skytes nå', open: 'ikke tatt' };
// Hvert lag får nummererte ruter i skyterekkefølge: 1–3 først, deretter 4, 5 … én og én. Tom rute har stiplet kant,
// ruta som skal merkes nå har gullkant, og en tatt straffe får hake (mål) eller kryss (bom).
function pensBoardHtml(m, p) {
  const n = p.kicks.length, next = p.decided ? null : penNext(p);
  const by = { home: p.kicks.filter((k) => k.side === 'home'), away: p.kicks.filter((k) => k.side === 'away') };
  const made = (s) => (Number.isInteger(p[s]) ? p[s] : by[s].filter((k) => k.made).length);
  // Tre straffer hver, deretter én runde om gangen (neste runde vises med en gang den starter).
  const rounds = Math.max(3, p.decided ? Math.ceil(n / 2) : Math.floor(n / 2) + 1);
  const slot = (s, i) => {
    const k = by[s][i], st = k ? (k.made ? 'made' : 'miss') : next === s && i === by[s].length ? 'next' : 'open';
    return `<li class="pen-slot ${st}"><span class="pen-box">${PEN_MARK[st] ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PEN_MARK[st]}</svg>` : ''}</span><span class="pen-num" aria-hidden="true">${i + 1}</span><span class="sr-only">${i + 1}. straffe: ${PEN_WORD[st]}</span></li>`;
  };
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const side = (s) => `<div class="pens-side${next === s ? ' up' : ''}"><p class="pens-who">${crest(m[s])}<span>${esc(m[s])}</span></p><div class="pens-slots"><ol class="pens-reg" aria-label="${esc(m[s])}, straffe 1 til 3">${range(0, 3).map((i) => slot(s, i)).join('')}</ol>${rounds > 3 ? `<div class="pens-sdwrap"><span class="pens-sdcap" aria-hidden="true">Én og én</span><ol class="pens-sd" aria-label="${esc(m[s])}, én og én">${range(3, rounds).map((i) => slot(s, i)).join('')}</ol></div>` : ''}</div></div>`;
  return `<p class="pens-tally"><span class="sr-only">Straffer: ${esc(m.home)} ${made('home')}, ${esc(m.away)} ${made('away')}.</span><span class="pens-vis" aria-hidden="true">${crest(m.home)}<b>${made('home')}</b><i>–</i><b>${made('away')}</b>${crest(m.away)}</span></p>`
    + `<div class="pens-rows">${side('home')}${side('away')}</div>`;
}
const setAria = (el, on) => el.setAttribute('aria-disabled', on ? 'true' : 'false');
function renderPens(m) {
  const box = $('#ref-pens'), on = pensOn(m);
  ref.classList.toggle('pens-on', on);
  // Når første straffe er tatt, er målflatene låst: banefeltet skjules, stillingen står i panelet.
  ref.classList.toggle('pens-started', on && pensStarted(m));
  box.hidden = !on;
  const finish = $('#ref-finish');
  setAria(finish, on && needsPens(m));
  if (!on) return;
  const p = pens(m) || { home: 0, away: 0, kicks: [], decided: false, winner: null };
  const n = p.kicks.length, next = p.decided ? null : penNext(p);
  box.classList.toggle('decided', !!p.decided);
  // Før første straffe: dommeren bekrefter at begge lag kjenner reglene og vet hvem som skyter først.
  const ack = !n && !p.decided && !pensAcked.has(m.id);
  $('#pens-sub').textContent = `${m.home} ${m.hs}–${m.aws} ${m.away} etter full tid.`;
  $('#pens-ack').hidden = !ack;
  $('#pens-play').hidden = ack;
  $('#pens-first').textContent = `${m.home} skyter først. Hjemmelaget i sluttspillet er laget som var høyest rangert i tabellen.`;
  const board = pensBoardHtml(m, p);
  if (renderPens.board !== board || !$('#pens-board').innerHTML) { renderPens.board = board; $('#pens-board').innerHTML = board; }
  let turn;
  if (p.decided) {
    const w = p.winner === 'away' ? 'away' : 'home', l = w === 'home' ? 'away' : 'home';
    turn = `${esc(m[w])} vant straffekonkurransen ${Number.isInteger(p[w]) ? p[w] : ''}–${Number.isInteger(p[l]) ? p[l] : ''}.`;
  } else {
    const round = Math.floor(n / 2) + 1;
    turn = `${crest(m[next])}<span>${esc(genitive(m[next]))} tur · ${round <= 3 ? `straffe ${round} av 3` : `én og én, runde ${round}`}</span>`;
  }
  const turnEl = $('#pens-turn');
  if (turnEl.innerHTML !== turn) turnEl.innerHTML = turn;
  box.style.setProperty('--kicker', next ? teamColor(m[next]) : 'transparent');
  const blocked = pensBusy || goalsPending > 0;
  $('#pens-actions').hidden = !!p.decided;
  $('#pens-done').hidden = !p.decided;
  for (const [b, word] of [[$('#pen-made'), 'Mål'], [$('#pen-miss'), 'Bom']]) {
    setAria(b, blocked);
    if (next) b.setAttribute('aria-label', `${word} for ${m[next]}`);
  }
  const undo = $('#pen-undo');
  undo.hidden = !n;
  setAria(undo, blocked);
}
// «Avslutt kampen» på uavgjort sluttspillkamp: vis panelet og flytt fokus dit dommeren skal videre.
function showPens(msg) {
  askPens = true;
  renderRef();
  if (msg) toast(msg);
  const box = $('#ref-pens');
  if (box.hidden) return;
  const target = !$('#pens-ack').hidden ? $('#pens-ok') : !$('#pens-actions').hidden ? $('#pen-made') : $('#ref-finish');
  box.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  if (target) target.focus({ preventScroll: true });
}
const PEN_BUTTONS = () => [$('#pen-made'), $('#pen-miss'), $('#pen-undo'), $('#pens-ok')];
// Etter et kall: står fokus på en knapp som nå er skjult, flyttes det til neste naturlige steg.
function refocusPens(had) {
  if (!had || !refId) return;
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest?.('[hidden]')) return;
  const target = !$('#pens-actions').hidden && !$('#ref-pens').hidden ? $('#pen-made') : !$('#ref-finish').hidden ? $('#ref-finish') : $('#ref-close');
  if (target) target.focus({ preventScroll: true });
}
// Ett trykk = én straffe. Samme trykk-id sendes på nytt ved tidsavbrudd/nettbrudd/serverfeil, så serveren teller den bare én gang.
async function penKick(made) {
  const m = refMatch();
  if (!m || !pensOn(m) || pensBusy || goalsPending) return;
  const p = pens(m) || { kicks: [], decided: false };
  if (p.decided || (!p.kicks.length && !pensAcked.has(m.id))) return;
  // To trykk rett etter hverandre er nesten alltid ett trykk: det andre ville ellers blitt neste lags straffe.
  const t = Date.now(); if (t - lastPenTap < 800) return; lastPenTap = t;
  const id = refId, side = penNext(p), rid = tapId(), had = PEN_BUTTONS().includes(document.activeElement);
  pensBusy = true; renderRef();
  try {
    for (let attempt = 0; ; attempt++) {
      try { setState(await api('/api/penalty', { id, action: 'kick', side, made, rid })); break; }
      catch (e) { if (attempt < 3 && (e.offline || e.status >= 500)) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); else throw e; }
    }
    error('');
    navigator.vibrate?.(made ? 35 : [25, 50, 25]);
  } catch (e) {
    navigator.vibrate?.([80, 60, 80, 60, 80]);
    if (e.status === 401 || e.status === 403) return sessionExpired();
    toast(e.offline || e.status >= 500 ? 'Fikk ikke bekreftet straffen (dårlig nett). Sjekk straffene når de er oppdatert før du trykker igjen.' : 'Ikke lagret: ' + e.message);
    await refresh(true);
  } finally {
    pensBusy = false;
    render();
    refocusPens(had);
  }
}
// Angre siste straffe. Kontrakten har ingen trykk-id for angring, så den sendes aldri automatisk på nytt.
async function penUndo() {
  const m = refMatch(), p = pens(m);
  if (!m || !p || !p.kicks.length || pensBusy || goalsPending || m.status !== 'live') return;
  if (p.decided) {
    const w = m[p.winner === 'away' ? 'away' : 'home'];
    if (!(await confirmBox('Angre siste straffe?', `${w} har vunnet straffekonkurransen. Angrer du den siste straffen, er den ikke avgjort lenger, og kampen kan ikke avsluttes før den er avgjort igjen.`, 'Ja, angre straffen', true))) return;
    if (pensBusy || refId !== m.id) return;
  }
  const id = refId, had = PEN_BUTTONS().includes(document.activeElement) || document.activeElement === document.body;
  pensBusy = true; renderRef();
  try {
    setState(await api('/api/penalty', { id, action: 'undo', count: p.kicks.length }));
    error(''); toast('Siste straffe er angret.');
  } catch (e) {
    if (e.status === 401 || e.status === 403) return sessionExpired();
    toast(e.offline || e.status >= 500 ? 'Fikk ikke bekreftet angringen (dårlig nett). Sjekk straffene når de er oppdatert før du trykker igjen.' : 'Ikke angret: ' + e.message);
    await refresh(true);
  } finally {
    pensBusy = false;
    render();
    refocusPens(had);
  }
}
function nextOnPitch(m) { return state.matches.filter((x) => x.pitch === m.pitch && x.start > m.start && !x.provisional).sort((a, b) => a.start.localeCompare(b.start))[0]; }
// Klokka teller oppover fra når dommeren trykket Start. Ved 15 minutter kommer et tydelig
// varsel (og vibrering på Android), men kampen avsluttes bare når dommeren trykker Avslutt.
function tickClock() {
  const m = refMatch();
  if (!m) return;
  let text, timeUp = false;
  if (m.status === 'finished') text = 'Slutt';
  else if (m.status === 'live') { timeUp = secondsLeft(m) <= 0; text = `${mmss(elapsed(m))}${timeUp ? ' · 15 min spilt' : ''}`; }
  else {
    const { date, secs } = osloClock(), st = hmToSecs(m.start);
    text = `Avspark kl. ${clock(m.start)}` + (date === state.config.date && secs < st && st - secs <= 3600 ? ` · om ${mmss(st - secs)}` : '');
  }
  $('#ref-clock').textContent = text;
  // Er straffene i gang, blinker ikke klokka og «blås av»-varselet er borte: dommeren er allerede i gang med neste steg.
  const started = m.status === 'live' && pensStarted(m), draw = m.status === 'live' && m.kind === 'playoff' && m.hs === m.aws;
  ref.classList.toggle('time-up', timeUp && !started);
  const alert = $('#ref-alert'), say = draw ? '15 minutter er spilt. Uavgjort: blås av, så avgjøres kampen på straffer.' : '15 minutter er spilt. Blås av og trykk «Avslutt kampen».';
  if (alert.textContent !== say) alert.textContent = say;
  alert.hidden = !timeUp || started;
  // Tiden gikk ut i en uavgjort sluttspillkamp: straffepanelet kommer fram.
  if (pensOn(m) === $('#ref-pens').hidden) renderPens(m);
  if (timeUp && !buzzed.has(m.id)) { buzzed.add(m.id); navigator.vibrate?.([300, 150, 300, 150, 300]); }
}
// pensFirst: åpnet fra «Avslutt kamp» på en uavgjort sluttspillkamp. Da vises straffepanelet med en gang.
async function openRef(id, pensFirst = false) {
  if (editing !== null) stopEdit();
  if (!refId) refOpener = document.activeElement || null;
  refId = id; askPens = !!pensFirst; armedSide = null; guardNextGoal = false; refWasHidden = false; clearTimeout(armedTimer);
  renderRef();
  ref.hidden = false;
  document.body.classList.add('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = true;
  if (pensFirst && !$('#ref-pens').hidden) { toast(PENS_FIRST); (!$('#pens-ack').hidden ? $('#pens-ok') : $('#pen-made')).focus(); }
  else $('#ref-close').focus();
  (ref.requestFullscreen || ref.webkitRequestFullscreen)?.call(ref)?.catch?.(() => {});
  // Skjermen holdes våken som standard. Sovner den likevel mens dommermodus er åpen (lomme,
  // batterisparing, av/på-knapp), tar refReturned() over når siden vises igjen (se visibilitychange).
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  clearInterval(clockTimer); clockTimer = setInterval(tickClock, 1000);
  schedule();
}
// Å gå ut av en kamp som pågår er helt vanlig (bytte telefon, sjekke tabellen). Men er
// tiden ute, minner vi om Avslutt: ellers står kampen som «Pågår» og tabellen venter.
async function closeRef(force = false) {
  if (!refId) return;
  const m = refMatch();
  if (!force && m && m.status === 'live' && secondsLeft(m) <= 0) {
    const ok = await confirmBox('Kampen er ikke avsluttet', '15 minutter er spilt, men kampen står fortsatt som «Pågår». Tabellen oppdateres ikke før noen trykker «Avslutt kampen».', 'Lukk uten å avslutte');
    if (!ok) return;
  }
  const closedId = refId;
  refId = null; armedSide = null; guardNextGoal = false; refWasHidden = false; clearTimeout(armedTimer);
  clearInterval(clockTimer);
  ref.hidden = true;
  document.body.classList.remove('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = false;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  renderCards(); schedule();
  // Tastaturfokus tilbake dit man kom fra: samme knapp, ellers kampens knapp etter ny tegning, ellers valgt runde.
  // Nettleseren flytter fokus når fullskjerm avsluttes, så det settes igjen etterpå.
  const back = refOpener && refOpener.isConnected ? refOpener : document.querySelector(`#match-cards [data-ref="${closedId}"], #fav-grid [data-ref="${closedId}"], #admin-alert [data-ref="${closedId}"]`) || document.querySelector('#round-tabs .active');
  refOpener = null;
  const refocus = () => { if (back && back.focus && !refId) back.focus({ preventScroll: true }); };
  refocus();
  if (document.fullscreenElement) document.exitFullscreen().then(refocus, () => {});
}
function toast(text, undoSide) {
  const t = $('#ref-toast');
  t.innerHTML = `<span>${esc(text)}</span>${undoSide ? `<button type="button" data-undo="${undoSide}">Angre</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  // Lange beskjeder (f.eks. at stillingen er endret) får litt mer tid, så dommeren rekker å lese dem.
  toastTimer = setTimeout(() => (t.hidden = true), text.length > 60 ? 7000 : 4000);
}
function bump(side) {
  if (reducedMotion) return;
  const el = ref.querySelector(`.ref-side[data-side="${side}"] .ref-score`);
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}
// Tilfeldig id per trykk. getRandomValues virker også over http på lokalt nett (randomUUID gjør ikke det).
const tapId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
// Mål sendes i kø (ett om gangen) og vises med en gang. Feiler lagringen, trekkes målet
// tilbake på skjermen, så dommeren aldri tror et mål er lagret når det ikke er det.
function goal(side, delta) {
  const m = refMatch();
  if (!m || m.status !== 'live') return;
  const f = side === 'home' ? 'hs' : 'aws';
  if (delta < 0 && !m[f]) return;
  // To trykk på samme lag innen 0,7 sekunder er nesten alltid ett mål trykket to ganger.
  if (delta > 0) { const t = Date.now(); if (t - lastGoalTap[side] < 700) return; lastGoalTap[side] = t; }
  m[f] = Math.max(0, (m[f] ?? 0) + delta);
  if (delta > 0) { navigator.vibrate?.(35); bump(side); }
  toast(delta > 0 ? `Mål til ${m[side]} · ${m.hs}–${m.aws}` : `Mål fjernet · ${m.hs}–${m.aws}`, delta > 0 ? side : null);
  const id = refId, rid = tapId();
  goalsPending++;
  renderRef();
  goalChain = goalChain.then(async () => {
    try {
      // Uten svar (tidsavbrudd, nettbrudd, serverfeil) kan målet likevel være lagret. Samme
      // trykk-id sendes da på nytt, og serveren teller trykket bare én gang.
      for (let attempt = 0; ; attempt++) {
        try { setState(await api('/api/goal', { id, side, delta, rid })); break; }
        catch (e) { if (attempt < 3 && (e.offline || e.status >= 500)) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); else throw e; }
      }
      error('');
    }
    catch (e) {
      const cur = state.matches.find((x) => x.id === id);
      if (cur) cur[f] = Math.max(0, (cur[f] ?? 0) - delta);
      toast(e.offline || e.status >= 500 ? 'Fikk ikke bekreftet målet (dårlig nett). Sjekk stillingen når den er oppdatert før du trykker igjen.' : 'Ikke lagret: ' + e.message);
      navigator.vibrate?.([80, 60, 80, 60, 80]);
      if (e.status === 401 || e.status === 403) return sessionExpired();
      await refresh(true);
    }
    finally { goalsPending--; if (!goalsPending) render(); else if (refId) renderRef(); }
  });
}
ref.addEventListener('click', async (e) => {
  const t = (sel) => e.target.closest(sel);
  if (t('.ref-goal')) {
    const side = t('.ref-goal').closest('.ref-side').dataset.side;
    // Normalt: ett trykk = ett mål. Har skjermen sovnet og kommet tilbake (guardNextGoal, satt av
    // refReturned()) eller et lag allerede er armert: første trykk armer (viser «bekreft»), andre
    // trykk på SAMME lag innen fire sekunder registrerer målet. Trykk på det andre laget bytter
    // bare hvilket lag som er armert, uten å registrere noe.
    if (armedSide === side) { disarmGoal(false); return goal(side, 1); }
    if (guardNextGoal || armedSide) return armGoal(side);
    return goal(side, 1);
  }
  if (t('.ref-undo')) return goal(t('.ref-undo').closest('.ref-side').dataset.side, -1);
  if (t('[data-undo]')) { goal(t('[data-undo]').dataset.undo, -1); $('#ref-toast').hidden = true; return; }
  if (t('#pen-made')) return penKick(true);
  if (t('#pen-miss')) return penKick(false);
  if (t('#pen-undo')) return penUndo();
  if (t('#pens-ok')) { const m = refMatch(); if (m) { pensAcked.add(m.id); renderRef(); if (!$('#pens-actions').hidden) $('#pen-made').focus(); } return; }
  if (t('#ref-close')) return closeRef();
  if (t('#ref-nominate')) return openNom();
  if (t('#ref-start')) {
    const b = $('#ref-start'); b.disabled = true;
    if (await matchAction(refId, 'start')) toast('Kampen er i gang. Trykk på laget som scorer.');
    b.disabled = false; return;
  }
  if (t('#ref-finish')) {
    await goalChain;
    const m = refMatch();
    if (!m || pensBusy) return;
    if (needsPens(m)) return showPens(PENS_FIRST);
    if (await finishMatch(refId)) navigator.vibrate?.(120);
    else { const cur = refMatch(); if (cur && cur.status === 'live' && needsPens(cur)) showPens(); } // serveren sa nei (ikke avgjort likevel)
    return;
  }
  if (t('#ref-unstart')) {
    if (await confirmBox('Angre start?', 'Kampen settes tilbake til «Ikke startet». Bruk dette hvis du startet feil kamp.', 'Ja, angre start')) matchAction(refId, 'unstart');
    return;
  }
  if (t('#ref-reopen')) {
    if (await confirmBox('Åpne kampen igjen?', 'Kampen settes tilbake til «Pågår», så du kan rette mål. Husk å trykke «Avslutt kampen» igjen etterpå.', 'Ja, åpne igjen')) matchAction(refId, 'reopen');
    return;
  }
  // Neste kamp på samme bane: bytt kamp i den åpne dommermodusen (ikke åpne en ny oppå).
  if (t('#ref-next')) {
    const n = nextOnPitch(refMatch());
    if (n) { refId = n.id; askPens = false; renderRef(); }
  }
});
// Esc lukker dommermodus (men ikke mens en dialog er åpen).
// Lukkingen venter til tastetrykket er ferdig: ellers lukker samme Esc straks bekreftelsen som closeRef() åpner.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && refId && !$('#confirm-score').open && !$('#nom-dialog').open) { e.preventDefault(); setTimeout(() => closeRef(), 0); } });

// ---------- Innlogging ----------------------------------------------------------
$('#auth-button').addEventListener('click', async () => {
  if (admin) {
    if (editing !== null) { error('Lagre eller avbryt rettelsen før du logger ut.'); return; }
    try { await api('/api/logout', {}); markAdminDevice(false); admin = false; user = null; csrf = null; noms = []; nomSnapshot = ''; $('#nom-board').innerHTML = ''; render(); renderCards(); } catch (e) { error(e.message); }
  } else $('#login-dialog').showModal();
});
$('#login-dialog .close').addEventListener('click', () => $('#login-dialog').close());
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, button = form.querySelector('button.primary');
  button.disabled = true; button.textContent = 'Logger inn …';
  try {
    const s = await api('/api/login', { username: form.username.value, password: form.password.value });
    admin = s.admin; user = s.user; csrf = s.csrf; markAdminDevice(true);
    form.reset(); $('#login-error').textContent = ''; $('#login-dialog').close();
    currentRound = defaultRound(); render(); renderCards(); selectTab('matches');
  } catch (err) { $('#login-error').textContent = err.message; }
  finally { button.disabled = false; button.textContent = 'Logg inn'; }
});

// ---------- Oppdatering (billig polling) ---------------------------------------
// Serveren svarer {same:true} når ingenting er endret – da leses bare 2 rader i D1.
// Budsjett for gratisplanen (100 000 Worker-forespørsler per døgn): publikum henter hvert
// 60. sekund bare mens siden er synlig. Selv 100 skjermer som står åpne i alle fire timene
// blir 24 000 forespørsler; 8 admin-er hvert 15. sekund blir 7 700.
let pollTimer = null, lastFetch = 0;
function pollDelay() {
  if (refId) return 20000;   // dommermodus får fersk stilling fra sine egne trykk
  if (admin) return 15000;
  return 60000;
}
function schedule() { clearTimeout(pollTimer); if (!document.hidden) pollTimer = setTimeout(async () => { await refresh(); schedule(); }, pollDelay()); }
// Siste kjente stilling lagres på telefonen, så siden viser noe med en gang ved neste
// besøk, også uten dekning. Den erstattes straks serveren svarer.
const CACHE_KEY = 'konfaction-state';
function cacheState(data) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {} }
function cachedState() { try { const d = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return d && Array.isArray(d.matches) && Array.isArray(d.table) ? d : null; } catch { return null; } }
function stamp(prefix) { return prefix + new Date(Date.now() + timeOffset).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' }); }
async function refresh(force) {
  if (!force && goalsPending) return;
  lastFetch = Date.now();
  const seq = stateSeq;
  try {
    const data = await api('/api/state' + (stateKey && !force ? '?since=' + encodeURIComponent(stateKey) : ''));
    // Et svar som ble hentet før et mål eller en handling ga nyere stilling, er utdatert. Brukes det,
    // hopper stillingen tilbake på skjermen, og dommeren kan tro at målet forsvant og trykke igjen.
    const stale = stateSeq !== seq || (!force && goalsPending > 0);
    if (data.same || stale) { if (data.serverTime) timeOffset = Date.parse(data.serverTime) - Date.now(); }
    else { const before = state; flashIds = changedMatches(before, data); setState(data); cacheState(data); render(); try { notifyChanges(before, data); } catch {} }
    // Nominasjonene er ikke en del av stateKey, så de hentes eget – bare for admin som ser på dem.
    if (admin && (tabName === 'nominations' || refId)) loadNoms();
    $('#connection-status').textContent = stamp('Oppdatert kl. ');
    $('#connection-status').classList.remove('offline');
    error('');
  } catch (e) {
    $('#connection-status').textContent = 'Frakoblet · prøver igjen';
    $('#connection-status').classList.add('offline');
    error(e.status === 401 ? 'Svar på inngangsspørsmålet for å se turneringen. Last siden på nytt.' : state ? 'Får ikke kontakt akkurat nå. Viser sist mottatte resultater.' : e.message);
  }
}
// Når siden vises igjen, hentes nytt bare hvis det er en stund siden sist, så det ikke
// blir en forespørsel hver gang noen låser opp telefonen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pollTimer); if (refId) refWasHidden = true; return; }
  if (refId && refWasHidden) { refWasHidden = false; refReturned(); }
  if (Date.now() - lastFetch > 15000) refresh().then(schedule); else schedule();
});
// «Oppdatert kl. …» er også en knapp for å hente nytt med en gang (maks hvert 5. sekund).
$('#connection-status').addEventListener('click', () => { if (Date.now() - lastFetch > 5000) refresh().then(schedule); });

// ---------- Følg lag ------------------------------------------------------------
function notifyChanges(before, after) {
  const fav = followed();
  let wanted = false; try { wanted = localStorage.getItem('konfaction-notify') === '1'; } catch {}
  if (!before || !fav.length || !wanted) return;
  const system = 'Notification' in window && Notification.permission === 'granted';
  for (const m of after.matches) {
    if (!isMine(m, fav)) continue;
    const old = before.matches.find((x) => x.id === m.id);
    if (!old) continue;
    // Bare sluttresultat varsles, ikke avspark eller mål underveis.
    if (old.status !== 'finished' && m.status === 'finished' && m.hs !== null) {
      const text = `${m.home} ${m.hs}–${m.aws} ${m.away}${penNote(m) ? ', ' + penNote(m) : ''}`;
      pageToast('Slutt: ' + text);
      // Android-Chrome tillater ikke «new Notification» (bare via service worker) og kaster feil.
      // Da holder beskjeden på siden; oppdateringen skal aldri stoppe på grunn av et varsel.
      if (system) { try { new Notification('Slutt', { body: text, tag: 'k' + m.id }); } catch {} }
    }
  }
}
function setUpFollow() {
  const teams = state ? state.config.teams : TEAMS, fav = followed();
  $('#follow-teams').innerHTML = teams.map((t) => `<label class="choice team"><input type="checkbox" name="team" value="${esc(t)}" ${fav.includes(t) ? 'checked' : ''}>${crest(t)}<span>${esc(t)}</span></label>`).join('');
  $('#follow-stop').hidden = !fav.length;
  try { $('#notification-opt').checked = localStorage.getItem('konfaction-notify') === '1'; } catch {}
}
$('#follow-button').onclick = () => { setUpFollow(); $('#follow-dialog').showModal(); };
$('#follow-later').onclick = () => $('#follow-dialog').close();
$('#follow-dialog .close').onclick = () => $('#follow-dialog').close();
$('#follow-stop').onclick = () => { saveFollowed([]); pageToast('Du følger ingen lag'); if (currentRound === 'mine') currentRound = null; $('#follow-dialog').close(); render(); renderCards(); };
$('#follow-form').onsubmit = (e) => {
  e.preventDefault();
  const teams = state ? state.config.teams : TEAMS;
  const picked = [...document.querySelectorAll('#follow-teams input:checked')].map((i) => i.value);
  saveFollowed(teams.filter((t) => picked.includes(t)));
  const notify = $('#notification-opt').checked;
  try { notify ? localStorage.setItem('konfaction-notify', '1') : localStorage.removeItem('konfaction-notify'); } catch {}
  if (notify && 'Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission()?.catch?.(() => {}); } catch {} }
  currentRound = picked.length ? 'mine' : null; $('#follow-dialog').close(); render(); renderCards();
  pageToast(picked.length ? `Du følger ${joinNames(teams.filter((t) => picked.includes(t)))}` : 'Du følger ingen lag');
};

// ---------- Nominasjoner (bare admin) -------------------------------------------
// Dommeren nominerer fra dommermodus, alle admin-er ser oversikten under «Nominert».
let noms = [], nomSeq = 0, nomSnapshot = '', nomMatch = null;
const AWARD_INFO = {
  puskas: { name: 'Årets Puskás', icon: '↗', player: 'Hvem scoret?', reason: 'Hvordan var målet?', ph: 'F.eks. volley fra 15 meter, rett i krysset.', rows: 3 },
  celebration: { name: 'Beste lagfeiring', icon: '✦', player: null, reason: 'Hvordan var feiringen? Kort holder.', ph: 'F.eks. hele laget danset sammen.', rows: 2 },
  glove: { name: 'Årets gullhanske', icon: '✋', player: 'Hvem sto i mål?', reason: 'Hvordan var redningen?', ph: 'F.eks. stupte og tipset et frispark over tverrliggeren.', rows: 3 },
};
const who = (n) => n.player || n.team;
function nomContext(n) {
  const m = state && state.matches.find((x) => x.id === n.matchId);
  if (!m) return n.matchId ? '' : '· lagt til i etterkant, uten kamp';
  const opp = n.team === m.home ? m.away : m.home;
  return `mot ${opp}, ${matchTitle(m).toLowerCase()} kl. ${clock(m.start)}`;
}
// Panelet tegnes bare om når dataene faktisk har endret seg, og åpne kandidater huskes,
// så et trykk ikke blir overstyrt av neste oppdatering.
const openNomKeys = new Set(), seenNomKeys = new Set();
const nomName = (s) => s.normalize('NFC').trim().replace(/\s+/g, ' ');
const nomKey = (award, n) => award + '|' + (award === 'celebration' ? '' : nomName(n.player).replace(/\./g, '').toLocaleLowerCase('nb')) + '|' + n.team;
function setNoms(list) { nomSeq++; const snap = JSON.stringify(list); if (snap === nomSnapshot) return; nomSnapshot = snap; noms = list; keepFocus(renderNoms); renderRefNoms(); }
async function loadNoms() {
  if (!admin) return;
  const seq = ++nomSeq;
  try { const list = (await api('/api/nominations')).nominations; if (seq === nomSeq) setNoms(list); }
  catch (e) { if (seq === nomSeq && (e.status === 401 || e.status === 403)) sessionExpired(); }
}
function sessionExpired() {
  markAdminDevice(false);
  admin = false; user = null; csrf = null; noms = []; nomSnapshot = ''; $('#nom-board').innerHTML = '';
  if ($('#nom-dialog').open) $('#nom-dialog').close();
  editing = null; closeRef(true); render(); renderCards();
  pageToast('Innloggingen har gått ut. Logg inn på nytt.');
}
// Vanligste skrivemåte av navnet; ved likt antall vinner den som ble skrevet først.
function spelling(items) { const c = new Map(); for (const x of [...items].reverse()) { const k = nomName(x.player); c.set(k, (c.get(k) || 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; }
function renderNoms() {
  $('#nom-count').textContent = noms.length ? `${noms.length} nominasjon${noms.length === 1 ? '' : 'er'}` : '';
  $('#nom-board').innerHTML = Object.entries(AWARD_INFO).map(([award, info], ai) => {
    const list = noms.filter((n) => n.award === award), groups = new Map();
    for (const n of list) { const key = nomKey(award, n); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(n); }
    const cands = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || b[1][0].created - a[1][0].created || b[1][0].id - a[1][0].id);
    const leads = cands.length > 1 && cands[0][1].length > cands[1][1].length;
    return `<article class="nom-award"><header>${awardCrest(award)}<div><h3>${info.name}</h3><p>${list.length ? `${cands.length} kandidat${cands.length === 1 ? '' : 'er'}, ${list.length} nominasjon${list.length === 1 ? '' : 'er'}` : 'Ingen nominert ennå'}</p></div></header>${cands.length ? `<ol class="nom-cands">${cands.map(([key, items], i) => {
      if (!seenNomKeys.has(key)) { seenNomKeys.add(key); if (i === 0) openNomKeys.add(key); }
      const open = openNomKeys.has(key), n = items[0], leader = i === 0 && leads, name = award === 'celebration' ? n.team : spelling(items), id = `nc-${ai}-${i}`;
      return `<li class="nom-cand${leader ? ' leader' : ''}" data-key="${esc(key)}"><button type="button" class="nom-toggle" aria-expanded="${open}" aria-controls="${id}">${crest(n.team)}<span class="nom-who"><b>${esc(name)}</b><small>${award === 'celebration' ? 'Lagpris' : esc(n.team)}${leader ? ' · flest nominasjoner' : ''}</small></span><span class="nom-votes">${items.length}<span class="sr-only"> nominasjon${items.length === 1 ? '' : 'er'}</span></span><span class="nom-chev" aria-hidden="true"></span></button><ul class="nom-reasons" id="${id}"${open ? '' : ' hidden'}>${items.map((x) => `<li><p>${esc(x.reason)}</p><span class="nom-by"><b>${esc(x.author)}</b> ${esc(nomContext(x))}${x.author === user ? ` <button type="button" class="nom-del" data-del="${x.id}" aria-label="Slett nominasjonen av ${esc(who(x))}">Slett</button>` : ''}</span></li>`).join('')}</ul></li>`;
    }).join('')}</ol>` : '<p class="nom-empty">Dommerne kan nominere fra dommermodus.</p>'}</article>`;
  }).join('');
}
function renderRefNoms() {
  if (!refId) return;
  const mine = noms.filter((n) => n.matchId === refId);
  $('#ref-nom-list').innerHTML = mine.map((n) => `<li><span><b>${esc((AWARD_INFO[n.award] || { name: n.award }).name)}:</b> ${esc(who(n))}${n.player ? ` (${esc(n.team)})` : ''}</span>${n.author === user ? `<button type="button" class="nom-del" data-del="${n.id}" aria-label="Slett nominasjonen av ${esc(who(n))}">Slett</button>` : `<small>${esc(n.author)}</small>`}</li>`).join('');
}
async function deleteNom(id) {
  if (!confirm('Slette denne nominasjonen?')) return;
  const say = (m) => (refId ? toast(m) : pageToast(m));
  try { setNoms((await api('/api/nomination/delete', { id })).nominations); say('Nominasjonen er slettet.'); }
  catch (e) { if (e.status === 401) return sessionExpired(); say(e.message); }
}
for (const el of ['#nom-board', '#ref-nom-list']) $(el).addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (b) { e.stopPropagation(); deleteNom(Number(b.dataset.del)); return; }
  const tg = e.target.closest('.nom-toggle');
  if (tg) { const li = tg.closest('.nom-cand'), open = tg.getAttribute('aria-expanded') !== 'true'; tg.setAttribute('aria-expanded', open); li.querySelector('.nom-reasons').hidden = !open; open ? openNomKeys.add(li.dataset.key) : openNomKeys.delete(li.dataset.key); }
});
// free = true: fra «Nominert»-fanen i etterkant. Da kan man velge blant alle lag, og kampen er valgfri.
let nomFree = false;
function openNom(free = false) {
  const m = free ? null : state.matches.find((x) => x.id === refId);
  if (!free && !m) return;
  const form = $('#nom-form'), key = free ? 'free' : m.id;
  if (nomMatch !== key) { form.reset(); nomMatch = key; }
  nomFree = free;
  $('#nom-match').textContent = free ? 'Legges til i etterkant. Velg lag, og kampen hvis du husker den.' : `${m.home} mot ${m.away} · bane ${m.pitch} · ${matchTitle(m).toLowerCase()}`;
  const picked = form.team && form.team.value;
  $('#nom-team-choices').classList.toggle('all', free);
  $('#nom-team-choices').innerHTML = (free ? state.config.teams : [m.home, m.away]).map((team) => `<label class="choice team"><input type="radio" name="team" value="${esc(team)}" ${picked === team ? 'checked' : ''}>${crest(team)}<span>${esc(team)}</span></label>`).join('');
  $('#nom-match-wrap').hidden = !free;
  $('#nom-help').textContent = free ? 'Hvem som nominerte lagres automatisk.' : 'Kamp og motstander legges til automatisk.';
  if (free) fillNomMatches();
  $('#nom-error').textContent = ''; updateNomForm(); $('#nom-dialog').showModal();
}
// Kamplista følger laget som er valgt. «Ingen bestemt kamp» er standard.
function fillNomMatches() {
  const form = $('#nom-form'), team = form.team ? form.team.value : '', sel = $('#nom-match-select'), prev = sel.value;
  const ms = team ? state.matches.filter((m) => !m.provisional && (m.home === team || m.away === team)).sort((a, b) => a.start.localeCompare(b.start)) : [];
  sel.innerHTML = `<option value="">${team ? 'Ingen bestemt kamp' : 'Velg lag først'}</option>` + ms.map((m) => `<option value="${m.id}">${esc(matchTitle(m))} kl. ${clock(m.start)} mot ${esc(m.home === team ? m.away : m.home)}</option>`).join('');
  sel.disabled = !team;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
$('#nom-add').addEventListener('click', () => { if (state && admin) openNom(true); });
function updateNomForm() {
  const form = $('#nom-form'), info = AWARD_INFO[form.award.value];
  $('#nom-details').hidden = !info; $('#nom-submit').hidden = !info;
  if (info) form.reason.rows = info.rows;
  $('#nom-player-wrap').hidden = !!info && !info.player;
  $('#nom-player-label').textContent = (info && info.player) || 'Spillerens navn';
  $('#nom-reason-label').textContent = info ? info.reason : 'Hva skjedde?';
  form.reason.placeholder = info ? info.ph : 'Velg pris først';
  $('#nom-submit').textContent = info ? `Nominer til ${info.name}` : 'Send nominasjon';
}
$('#nom-form').addEventListener('change', (e) => { $('#nom-error').textContent = ''; if (e.target.name === 'team' && nomFree) fillNomMatches(); if (e.target.name === 'award') { const first = $('#nom-details').hidden; updateNomForm(); if (first) $('#nom-details').scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' }); } });
$('#nom-cancel').addEventListener('click', () => $('#nom-dialog').close());
$('#nom-dialog .close').addEventListener('click', () => $('#nom-dialog').close());
$('#nom-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, award = form.award.value, info = AWARD_INFO[award], team = form.team ? form.team.value : '';
  const player = info && info.player ? form.player.value.trim() : '', reason = form.reason.value.trim();
  const problem = !info ? 'Velg hvilken pris det gjelder.' : !team ? 'Velg hvilket lag.' : info.player && !player ? 'Skriv navnet på spilleren.' : reason.length < 3 ? { puskas: 'Skriv kort hvordan målet var.', celebration: 'Skriv kort hvordan feiringen var.', glove: 'Skriv kort hvordan redningen var.' }[award] : '';
  if (problem) { $('#nom-error').textContent = problem; return; }
  const button = $('#nom-submit'); button.disabled = true;
  try {
    const matchId = nomFree ? ($('#nom-match-select').value ? Number($('#nom-match-select').value) : null) : refId;
    setNoms((await api('/api/nominate', { matchId, award, team, player, reason })).nominations);
    form.reset(); nomMatch = null; updateNomForm(); $('#nom-dialog').close();
    const msg = `Nominert: ${player || team} til ${info.name}.`;
    refId && !nomFree ? toast(msg) : pageToast(msg);
  } catch (err) { if (err.status === 401) { $('#nom-dialog').close(); return sessionExpired(); } $('#nom-error').textContent = err.message; }
  finally { button.disabled = false; }
});
// Enter i navnefeltet går videre til beskrivelsen i stedet for å sende skjemaet.
$('#nom-form [name=player]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#nom-form [name=reason]').focus(); } });

// ---------- Lasteskjerm: 3–5 sekunder med én tilfeldig pikselfotball-GIF -----------
// Vises ved hver innlasting. Innloggede admin-er/dommere slipper ventetiden (se markAdminDevice).
const loaderImages = ['barca.gif', 'griezman.gif', 'haaland-robot.gif', 'luiz.gif', 'messi.gif', 'messi_2.gif', 'portugal.gif', 'ramos.gif', 'ronaldinhos-skills-1.gif', 'ronaldo.gif', 'ronaldo_2.gif', 'sturrige.gif', 'var.gif'];
function markAdminDevice(on) { try { on ? localStorage.setItem('konfaction-admin', '1') : localStorage.removeItem('konfaction-admin'); } catch {} }
(function loader() {
  let skip = false;
  try { skip = localStorage.getItem('konfaction-admin') === '1'; } catch {}
  if (skip) { $('#loader').remove(); document.body.classList.add('ready'); return; }
  const behind = document.querySelectorAll('body > header, body > .cover, body > main');
  for (const el of behind) el.inert = true;
  $('#loader-pixel').src = 'pixel/' + loaderImages[Math.floor(Math.random() * loaderImages.length)];
  // Alltid hele lasteskjermen (3–5 s), også ved nye besøk (eierens ønske). Den holder bare igjen overlegget:
  // henting av stillingen starter med en gang uansett. 10-sekunders sikkerhetsnettet i CSS gjelder fortsatt.
  const duration = 3000 + Math.random() * 2000;
  $('#load-bar').style.transitionDuration = Math.max(duration - 300, 0) + 'ms';
  setTimeout(() => ($('#load-bar').style.width = '100%'), 30);
  setTimeout(() => { for (const el of behind) el.inert = false; $('#loader').classList.add('done'); document.body.classList.add('ready'); setTimeout(() => $('#loader')?.remove(), 600); }, duration);
})();

(async () => {
  // Lenke rett til en fane (#kamper osv.). «Nominert» krever innlogging og velges først når økten er kjent.
  const linked = tabFromHash();
  if (linked && linked !== 'nominations') selectTab(linked, null);
  const cached = cachedState();
  if (cached) { setState(cached); stateKey = null; render(); $('#connection-status').textContent = 'Henter siste resultater …'; }
  try { const s = await api('/api/session'); admin = s.admin; user = s.user; csrf = s.csrf; markAdminDevice(s.admin); $('#login-local').hidden = !s.local; } catch {}
  if (linked === 'nominations' && admin) selectTab('nominations', null);
  await refresh(true);
  schedule();
})();
// Mørk bakgrunn er standard. ?lys i adressen viser den lyse versjonen (til sammenligning).
if (/[?&]lys\b/.test(location.search)) document.body.classList.add('lys');

// ---------- Overgang fra åpningsflaten til tabellen ---------------------------
// Scroll-styrt: --p (0 til 1) driver tittelen, banelinjene og ballen. Tabellen glir inn første gang den kommer til syne.
(() => {
  const cover = $('.cover'); const ball = $('.cover-ball');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const table = $('#table');
  if (!cover) return;
  let queued = false, lastP = '';
  function paint() {
    queued = false;
    if (calm.matches || tabName !== 'table') return;
    const h = cover.offsetHeight || 1;
    const p = Math.min(1, Math.max(0, (window.scrollY - cover.offsetTop) / (h * .72)));
    // Etter at åpningsflaten er passert endres ingenting: hopp over skrivingen (sparer stilberegning ved hver scroll).
    if (p.toFixed(3) === lastP) return;
    lastP = p.toFixed(3);
    cover.style.setProperty('--p', lastP);
    if (ball) {
      const size = ball.offsetWidth || 34; const start = 22; const run = Math.max(0, cover.clientWidth - size - start * 2);
      const x = start + p * run;
      ball.style.setProperty('--bx', x.toFixed(1) + 'px');
      ball.style.setProperty('--br', (p * run / (Math.PI * size) * 360).toFixed(1) + 'deg');
    }
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  addEventListener('scroll', ask, { passive: true }); addEventListener('resize', () => { lastP = ''; ask(); }); paint();
  // Tabellen glir inn første gang den kommer til syne.
  if (table && 'IntersectionObserver' in window && !calm.matches) {
    document.body.classList.add('js-reveal');
    const io = new IntersectionObserver((list) => list.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
    io.observe(table);
  }
  const go = $('.cover-scroll');
  // Pilen fører til tabellen.
  if (go) go.addEventListener('click', (e) => { e.preventDefault(); table.scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' }); });
})();

