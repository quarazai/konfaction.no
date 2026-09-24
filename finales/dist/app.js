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
function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
// Beskjed nederst på siden. (toast() lenger ned er dommermodusens egen beskjed.)
function pageToast(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(pageToast.timer); pageToast.timer = setTimeout(() => (t.hidden = true), 5000); }

// ---------- Små hjelpere --------------------------------------------------------
const statusLabel = (m) => ({ upcoming: 'Ikke startet', live: 'Pågår', finished: 'Avsluttet' }[m.status]);
const score = (v) => (v === null || v === undefined ? '–' : v);
const rowTeam = (name) => `${crest(name)}<span>${esc(name)}</span>`;
const matchTitle = (m) => m.kind !== 'playoff' ? `Runde ${m.round}` : m.ranks[1] === 1 ? 'Finale' : m.ranks[1] === 3 ? 'Bronsekamp' : `Kamp om ${m.ranks[1]}. plass`;
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
  return m.winner || null;
}
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
  const t = m.updated_at ? m.updated_at.slice(11, 16) : '';
  return `Sist endret av ${esc(m.updated_by)}${t ? ' kl. ' + t : ''}`;
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
function renderTable(fav) {
  $('#standings').innerHTML = state.table.map((r, i) => `<tr role="row" class="pair-${Math.floor(i / 2)}${fav.includes(r.name) ? ' followed' : ''}" data-team="${r.index}"><td role="cell">${i + 1}</td><td role="cell"><span class="team-label">${rowTeam(r.name)}</span></td><td role="cell">${r.p}</td><td role="cell">${r.w}</td><td role="cell">${r.d}</td><td role="cell">${r.l}</td><td role="cell">${r.gf}–${r.ga}</td><td role="cell">${r.gd > 0 ? '+' : ''}${r.gd}</td><td role="cell">${r.pts}</td></tr>`).join('');
  $('#standings').querySelectorAll('tr').forEach((tr) => { tr.style.viewTransitionName = 'team-' + tr.dataset.team; });
  updateScrollFocus();
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

  const live = state.matches.filter((m) => m.status === 'live').length;
  $('#live-indicator').textContent = live ? `${live} kamp${live === 1 ? '' : 'er'} pågår` : 'Ingen kamper pågår';
  $('#live-indicator').classList.toggle('live', live > 0);
  const completed = state.matches.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;


  $('#auth-button').innerHTML = admin ? `Logg ut${user ? ' <span class="auth-user">(' + esc(user) + ')</span>' : ''}` : 'Admin';
  $('#nom-tab').hidden = !admin;
  $('#export-link').hidden = !admin;
  if (!admin && tabName === 'nominations') selectTab('table');
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
  else if (upcoming.length) text = `Neste avspark kl. ${clock(upcoming[0])}`;
  else text = 'Turneringen er ferdigspilt';
  el.textContent = text;
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
function renderAdminAlert() {
  const box = $('#admin-alert');
  const late = admin && state ? state.matches.filter((m) => m.status === 'live' && secondsLeft(m) < -60) : [];
  const key = late.map((m) => `${m.id}:${m.hs}:${m.aws}`).join(',');
  if (key === renderAdminAlert.key) return;
  renderAdminAlert.key = key;
  box.hidden = !late.length;
  if (!late.length) return;
  box.innerHTML = `<strong>${late.length === 1 ? 'Én kamp er' : late.length + ' kamper er'} ikke avsluttet i appen</strong><span>15 minutter er spilt. Tabellen og sluttspillet venter til noen trykker «Avslutt kamp».</span><div>${late.map((m) => `<button type="button" data-ref="${m.id}">Bane ${m.pitch}: ${esc(m.home)} ${score(m.hs)}–${score(m.aws)} ${esc(m.away)} →</button>`).join('')}</div>`;
}
$('#admin-alert').addEventListener('click', (e) => { const b = e.target.closest('[data-ref]'); if (b) openRef(Number(b.dataset.ref)); });

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
  if (!state.seeded) return `<div class="seed-banner"><p><strong>Oppsettet er foreløpig.</strong> Det låses automatisk når alle 30 seriekampene er avsluttet. Er seriespillet ferdig før klokka sier det, kan du låse nå og registrere sluttspillresultater med en gang.</p><button class="primary" data-seed="lock">Lås oppsettet nå</button></div>`;
  return hasResults ? '' : `<div class="seed-banner quiet"><p>Oppsettet er låst etter tabellen.</p><button class="text-button" data-seed="unlock">${leagueFinished() ? 'Sett opp på nytt fra tabellen' : 'Lås opp igjen'}</button></div>`;
}
// Admin-kortet følger kampens gang: ikke startet → dommermodus, pågår → dommermodus og
// Avslutt, avsluttet → «Rett resultat». Resultater endres aldri av et feiltrykk:
// rettelser lagres først når man trykker Lagre.
function matchCard(m, showRound = false) {
  const editable = admin && !m.provisional, isEditing = editable && editing === m.id;
  const fav = followed();
  const isFav = isMine(m, fav);
  const winner = m.kind === 'playoff' ? decided(m) : null;
  const won = decided(m);
  // Bare admin-er trenger å se at en kamp ikke er avsluttet i appen.
  const late = admin && m.status === 'live' && secondsLeft(m) < -60;
  // Kortet: bane-fane øverst, lagmerker og stort resultat i midten, statusmerke nederst.
  // Under «Rett resultat» byttes midten ut med −/+ for hvert lag.
  const side = (s) => `<div class="mc-team${won ? (won === m[s] ? ' won' : ' lost') : ''}">${crest(m[s])}<b>${esc(m[s])}</b><small>${s === 'home' ? 'Hjemme' : 'Borte'}</small></div>`;
  const rows = isEditing
    ? [['home', 'hs'], ['away', 'aws']].map(([s, field]) => `<div class="score-block"><div class="score-row">${rowTeam(m[s])}<div class="stepper"><button type="button" data-step="-1" aria-label="Ett mål mindre for ${esc(m[s])}">−</button><input aria-label="Mål ${esc(m[s])}" data-field="${field}" type="number" min="0" max="99" step="1" inputmode="numeric" value="${m[field] ?? 0}"><button type="button" data-step="1" aria-label="Ett mål til ${esc(m[s])}">+</button></div></div></div>`).join('')
    : `<div class="mc-body">${side('home')}<div class="mc-score" aria-label="Stilling ${score(m.hs)} mot ${score(m.aws)}">${m.status === 'upcoming' ? '<span class="mc-time">VS</span>' : `${score(m.hs)}<i>:</i>${score(m.aws)}`}</div>${side('away')}</div>
      <span class="mc-status ${m.status}">${m.status === 'live' ? 'LIVE' : m.status === 'finished' ? 'Slutt' : 'Ikke startet'}</span>`;
  const refButton = (label) => `<button class="primary ref-open" data-ref="${m.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>${label}</button>`;
  let controls = '';
  if (isEditing) {
    const draw = m.kind === 'playoff';
    controls = `<div class="admin-controls edit-box">
      ${draw ? `<label class="winner-pick">Vinner hvis uavgjort (straffer)<select data-field="winner"><option value="">Ikke valgt</option>${[m.home, m.away].map((t) => `<option ${m.winner === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
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
  const isFinal = m.kind === 'playoff' && m.ranks[1] === 1;
  return `<article class="match ${m.status}${isFav ? ' followed' : ''}${isFinal ? ' final' : ''}${late ? ' late' : ''}" data-id="${m.id}">
    <div class="mc-tab">Bane ${m.pitch}</div>
    ${m.kind === 'playoff' ? `<h3>${isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : ''}${matchTitle(m)}${isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : ''}</h3><p class="small-note pair-note">${m.ranks[0]}. mot ${m.ranks[1]}. plass${m.provisional ? ' · foreløpig' : ''}</p>` : ''}
    ${rows}${controls ? `<div class="mc-tray">${controls}</div>` : ''}
    ${m.kind === 'playoff' && m.status === 'finished' && m.hs !== null && m.aws !== null ? `<p class="winner">${winner ? 'Vinner: ' + esc(winner) + (m.hs === m.aws ? ' (straffer)' : '') : 'Uavgjort – vinner ikke valgt'}</p>` : ''}
  </article>`;
}
// ---------- Låst sluttspill ---------------------------------------------------
function lockIntroHtml() {
  const league = state.matches.filter((m) => m.kind === 'league');
  const done = league.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;
  return `<section class="lock-intro" aria-labelledby="lock-title">${lockCrest()}<div><h3 id="lock-title">Låst til seriespillet er ferdig</h3>
    <p>Lagene settes inn automatisk etter tabellen.</p>
    <div class="lock-progress" role="progressbar" aria-label="Seriekamper ferdigspilt" aria-valuemin="0" aria-valuemax="${league.length}" aria-valuenow="${done}"><span data-pct="${league.length ? Math.round((done / league.length) * 100) : 0}"></span></div>
    <p class="lock-count"><b>${done} av ${league.length}</b> seriekamper spilt</p></div></section>`;
}
function lockedCard(m) {
  const isFinal = m.ranks[1] === 1, star = isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : '';
  const hi = Math.min(...m.ranks), lo = Math.max(...m.ranks);
  return `<article class="match locked${isFinal ? ' final' : ''}" data-id="${m.id}">
    <div class="mc-tab">Bane ${m.pitch}</div>
    <h3>${star}${matchTitle(m)}${star}</h3><p class="small-note pair-note">Nr. ${hi} mot nr. ${lo} i tabellen</p>
    <div class="lock-body">${lockCrest('lock-crest small')}<div><b class="lock-time">kl. ${m.start.replace(':', '.')}</b><span class="lock-note">Åpnes når sluttspillet er klart</span></div></div>
  </article>`;
}

function renderCards() {
  if (!state) return;
  const fav = followed();
  if (currentRound === null || (currentRound === 'mine' && !fav.length)) currentRound = defaultRound();
  renderRoundTabs(fav);
  const mineView = currentRound === 'mine';
  $('#fav-grid').hidden = !mineView; $('#match-cards').hidden = mineView;
  if (mineView) {
    $('#round-description').textContent = `Kampskjema for ${joinNames(fav)}. Tom rute betyr at laget har pause.${admin ? ' Trykk på en kamp for å åpne dommermodus.' : ''}`;
    $('#round-extra').innerHTML = '';
    $('#match-cards').innerHTML = '';
    renderFavGrid(fav);
    return;
  }
  // Kampene vises alltid i banenummerets rekkefølge (bane 1 først).
  const inRound = state.matches.filter((m) => m.round === currentRound);
  const ms = [...inRound].sort((x, y) => x.pitch - y.pitch || x.id - y.id);
  // Sluttspillet er låst til alle 30 seriekamper er ferdigspilt. Da settes lagene inn automatisk.
  const locked = currentRound === 10 && !state.seeded;
  const final = currentRound === 10 ? ms.find((m) => m.ranks[1] === 1) : null;
  const rest = ms.filter((m) => m !== final);
  const span = (list) => list.length ? `${clock(list.map((m) => m.start).sort()[0])}–${clock(list.map((m) => m.end).sort().pop())}` : '';
  $('#round-description').textContent = currentRound === 10
    ? `Plasseringskamper kl. ${span(rest)} · Finale kl. ${span(final ? [final] : [])}.${locked ? '' : ' Motstanderne er låst etter seriespillet.'}`
    : `Runde ${currentRound}, avspark kl. ${clock(ms[0].start)}, ${ms.length} kamper à 15 minutter.${admin ? ' Dommeren starter og avslutter kampen i dommermodus.' : ''}`;
  $('#round-extra').innerHTML = currentRound === 10 ? (locked ? lockIntroHtml() : podiumHtml()) + seedingHtml() : '';
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
  const result = !scored ? '' : m.status === 'live' ? `${mine}–${theirs}` : mine > theirs ? `Seier ${mine}–${theirs}` : mine < theirs ? `Tap ${mine}–${theirs}` : `Uavgjort ${mine}–${theirs}`;
  const tag = admin && !m.provisional ? 'button' : 'div';
  const isFinal = m.kind === 'playoff' && m.ranks[1] === 1;
  return `<${tag} ${tag === 'button' ? `type="button" data-ref="${m.id}" ` : ''}class="fav-cell ${m.status}${isFinal ? ' final' : ''}"><span class="fav-top"><b>Bane ${m.pitch}</b><span>${clock(m.start)}–${clock(m.end)}</span></span><span class="fav-opp">mot ${crest(opp)}<span>${esc(opp)}</span></span>${m.kind === 'playoff' ? `<span class="fav-note">${isFinal ? '★ ' : ''}${matchTitle(m)}${m.provisional ? ', foreløpig' : ''}</span>` : ''}${result ? `<span class="fav-result">${result}</span>` : ''}${m.status === 'live' ? '<span class="fav-live">Pågår</span>' : ''}</${tag}>`;
}
function renderFavGrid(fav) {
  const slots = [...new Set(state.matches.map((m) => m.start))].sort();
  const head = `<div class="fav-corner">Tid</div>${fav.map((t) => `<div class="fav-head">${crest(t)}<span>${esc(t)}</span></div>`).join('')}`;
  const rows = slots.map((st) => {
    const inSlot = state.matches.filter((m) => m.start === st), r = inSlot[0], now = inSlot.some((m) => m.status === 'live');
    const label = r.kind === 'playoff' ? (inSlot.some((m) => m.ranks[1] === 1) ? 'Finale' : 'Sluttspill') : `Runde ${r.round}`;
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
    if (e.status === 409) { editing = null; await refresh(true); render(); error('En annen admin endret kampen samtidig. Siste resultat vises nå. Rett på nytt om det trengs.'); return; }
    if (e.status === 401 || e.status === 403) { editing = null; return sessionExpired(); }
    say(e.message);
  }
}

// Én felles bekreftelsesdialog – returnerer true/false.
function confirmBox(title, text, ok) {
  return new Promise((resolve) => {
    const d = $('#confirm-score');
    $('#confirm-title').textContent = title; $('#confirm-copy').textContent = text; $('#confirm-save').textContent = ok;
    d.onclose = () => resolve(d.returnValue === 'confirm');
    d.returnValue = ''; d.showModal();
  });
}
// Start, avslutt, åpne igjen og angre start. Stillingen i bekreftelsen er den serveren har.
async function matchAction(id, action, extra = {}) {
  try {
    setState(await api('/api/match', { id, action, ...extra }));
    error(''); render(); return true;
  } catch (e) {
    if (e.status === 401 || e.status === 403) { sessionExpired(); return false; }
    refId ? toast(e.message) : error(e.message);
    // Uten svar kan handlingen likevel være lagret: hent stillingen så skjermen viser sannheten.
    if (e.status === 409 || e.status >= 500 || e.offline) { await refresh(true); render(); }
    return false;
  }
}
async function finishMatch(id, winner = null) {
  const m = state.matches.find((x) => x.id === id);
  const draw = m.kind === 'playoff' && m.hs === m.aws;
  if (draw && !winner) { refId ? toast('Uavgjort: velg hvem som vant på straffer.') : openRef(id); return false; }
  const ok = await confirmBox('Avslutte kampen?', `${m.home} ${score(m.hs)}–${score(m.aws)} ${m.away}${draw ? ` (${winner} vant på straffer)` : ''} blir sluttresultatet og teller i tabellen.`, 'Ja, avslutt');
  if (!ok) return false;
  return matchAction(id, 'finish', draw ? { winner } : {});
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
$('#round-extra').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-seed]');
  if (!b) return;
  const lock = b.dataset.seed === 'lock';
  const done = leagueFinished();
  const ok = await confirmBox(lock ? 'Låse sluttspilloppsettet?' : done ? 'Sette opp sluttspillet på nytt?' : 'Låse opp oppsettet?', lock ? 'Motstanderne settes etter tabellen slik den står nå. Senere rettelser i seriespillet endrer ikke oppsettet.' : done ? 'Seriespillet er ferdig, så lagene settes inn på nytt etter tabellen slik den står nå. Bruk dette bare hvis du har rettet et seriespillresultat.' : 'Oppsettet følger tabellen igjen til alle seriekampene er avsluttet.', lock ? 'Ja, lås' : done ? 'Ja, sett opp på nytt' : 'Ja, lås opp');
  if (!ok) return;
  try { setState(await api('/api/seeding', { action: b.dataset.seed })); error(''); render(); renderCards(); } catch (err) { error(err.message); }
});

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
  $('#round-tabs').innerHTML = tabs.map(([r, name]) => `<button data-round="${r}" aria-pressed="${r === currentRound}" aria-label="${esc(name)}${r === 10 && !state.seeded ? ' (låst til seriespillet er ferdig)' : ''}" class="${r === currentRound ? 'active' : ''}${r === liveRound ? ' has-live' : ''}${r === 'mine' ? ' mine-tab' : ''}">${tabLabel(r)}</button>`).join('');
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

let tabName = 'table';
function selectTab(name) {
  tabName = name; document.body.dataset.tab = name;
  if (name === 'nominations') loadNoms();
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== name));
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'));
  // Bytter du fane langt nede på siden, hopper vi til toppen av den nye fanen.
  const anchor = $('.connection');
  if (anchor.getBoundingClientRect().top < 0) anchor.scrollIntoView({ block: 'start' });
  if (name === 'matches') centerRound(true);
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

// ---------- Dommermodus (fullskjerm) -------------------------------------------
// Laget for en dommer med telefonen i én hånd ute ved banen: store flater, ett trykk = ett mål,
// og tre faste steg: Start kampen → trykk på laget som scorer → Avslutt kampen.
let refId = null, refWinner = null, askWinner = false, goalChain = Promise.resolve(), goalsPending = 0, clockTimer = null, wakeLock = null, toastTimer = null;
const lastGoalTap = { home: 0, away: 0 }, buzzed = new Set();
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
  for (const side of ['home', 'away']) {
    const f = side === 'home' ? 'hs' : 'aws';
    const el = ref.querySelector(`.ref-side[data-side="${side}"]`), goalBtn = el.querySelector('.ref-goal');
    el.querySelector('.ref-crest').innerHTML = crest(m[side]);
    el.querySelector('.ref-name').textContent = m[side];
    el.querySelector('.ref-score').textContent = upcoming ? '–' : m[f] ?? 0;
    el.querySelector('.ref-hint').textContent = upcoming ? 'Start kampen først' : done ? 'Avsluttet' : 'Trykk for mål';
    goalBtn.disabled = !live;
    goalBtn.setAttribute('aria-label', live ? `Mål til ${m[side]}. Stilling ${m[f] ?? 0}` : `${m[side]}: ${m[f] ?? 0}`);
    el.querySelector('.ref-undo').disabled = !live || !m[f];
    el.querySelector('.ref-undo').setAttribute('aria-label', `Fjern ett mål fra ${m[side]}`);
  }
  if (!(live && m.kind === 'playoff' && m.hs === m.aws)) { refWinner = null; askWinner = false; }
  $('#ref-winner').innerHTML = `<span>Uavgjort i sluttspill: hvem vant på straffer?</span>${[m.home, m.away].map((t) => `<button type="button" class="${refWinner === t ? 'chosen' : ''}" data-winner="${esc(t)}">${esc(t)}</button>`).join('')}`;
  $('#ref-howto').hidden = !upcoming;
  $('#ref-start').hidden = !upcoming;
  $('#ref-finish').hidden = !live;
  $('#ref-unstart').hidden = !(live && m.hs === 0 && m.aws === 0);
  $('#ref-reopen').hidden = !done;
  $('#ref-done').hidden = !done;
  if (done) $('#ref-done').textContent = `Slutt: ${m.home} ${m.hs}–${m.aws} ${m.away}${m.winner ? ` (${m.winner} vant på straffer)` : ''}. Husk: vestene henges i målet.`;
  const next = done && nextOnPitch(m);
  $('#ref-next').hidden = !next;
  if (next) $('#ref-next').textContent = `Neste kamp på bane ${m.pitch}: kl. ${clock(next.start)}, ${next.home} mot ${next.away} →`;
  $('#ref-nominate').hidden = !!m.provisional;
  renderRefNoms();
  $('#ref-edit').textContent = goalsPending ? 'Lagrer …' : lastEdit(m);
  tickClock();
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
  ref.classList.toggle('time-up', timeUp);
  $('#ref-alert').hidden = !timeUp;
  const draw = m.status === 'live' && m.kind === 'playoff' && m.hs === m.aws;
  $('#ref-winner').hidden = !(draw && (timeUp || askWinner || refWinner));
  if (timeUp && !buzzed.has(m.id)) { buzzed.add(m.id); navigator.vibrate?.([300, 150, 300, 150, 300]); }
}
async function openRef(id) {
  if (editing !== null) stopEdit();
  refId = id; refWinner = null; askWinner = false;
  renderRef();
  ref.hidden = false;
  document.body.classList.add('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = true;
  $('#ref-close').focus();
  (ref.requestFullscreen || ref.webkitRequestFullscreen)?.call(ref)?.catch?.(() => {});
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
  refId = null;
  clearInterval(clockTimer);
  ref.hidden = true;
  document.body.classList.remove('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  renderCards(); schedule();
}
function toast(text, undoSide) {
  const t = $('#ref-toast');
  t.innerHTML = `<span>${esc(text)}</span>${undoSide ? `<button type="button" data-undo="${undoSide}">Angre</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
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
  if (t('.ref-goal')) return goal(t('.ref-goal').closest('.ref-side').dataset.side, 1);
  if (t('.ref-undo')) return goal(t('.ref-undo').closest('.ref-side').dataset.side, -1);
  if (t('[data-undo]')) { goal(t('[data-undo]').dataset.undo, -1); $('#ref-toast').hidden = true; return; }
  if (t('[data-winner]')) { refWinner = t('[data-winner]').dataset.winner; renderRef(); return; }
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
    if (m.kind === 'playoff' && m.hs === m.aws && !refWinner) { askWinner = true; renderRef(); toast('Uavgjort: velg hvem som vant på straffer.'); return; }
    if (await finishMatch(refId, refWinner)) navigator.vibrate?.(120);
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
    if (n) { refId = n.id; refWinner = null; askWinner = false; renderRef(); }
  }
});
// Esc lukker dommermodus (men ikke mens en dialog er åpen).
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && refId && !$('#confirm-score').open && !$('#nom-dialog').open) closeRef(); });

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
  if (document.hidden) { clearTimeout(pollTimer); return; }
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
      const text = `${m.home} ${m.hs}–${m.aws} ${m.away}`;
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
function setNoms(list) { nomSeq++; const snap = JSON.stringify(list); if (snap === nomSnapshot) return; nomSnapshot = snap; noms = list; renderNoms(); renderRefNoms(); }
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
  $('#loader-pixel').src = 'pixel/' + loaderImages[Math.floor(Math.random() * loaderImages.length)];
  const duration = 3000 + Math.random() * 2000;
  $('#load-bar').style.transitionDuration = Math.max(duration - 300, 0) + 'ms';
  setTimeout(() => ($('#load-bar').style.width = '100%'), 30);
  setTimeout(() => { $('#loader').classList.add('done'); document.body.classList.add('ready'); setTimeout(() => $('#loader')?.remove(), 600); }, duration);
})();

(async () => {
  const cached = cachedState();
  if (cached) { setState(cached); stateKey = null; render(); $('#connection-status').textContent = 'Henter siste resultater …'; }
  try { const s = await api('/api/session'); admin = s.admin; user = s.user; csrf = s.csrf; markAdminDevice(s.admin); $('#login-local').hidden = !s.local; } catch {}
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
  let queued = false;
  function paint() {
    queued = false;
    if (calm.matches || tabName !== 'table') return;
    const h = cover.offsetHeight || 1;
    const p = Math.min(1, Math.max(0, (window.scrollY - cover.offsetTop) / (h * .72)));
    cover.style.setProperty('--p', p.toFixed(3));
    if (ball) {
      const size = ball.offsetWidth || 34; const start = 22; const run = Math.max(0, cover.clientWidth - size - start * 2);
      const x = start + p * run;
      ball.style.setProperty('--bx', x.toFixed(1) + 'px');
      ball.style.setProperty('--br', (p * run / (Math.PI * size) * 360).toFixed(1) + 'deg');
    }
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  addEventListener('scroll', ask, { passive: true }); addEventListener('resize', ask); paint();
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

