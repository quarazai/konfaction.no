// KonfAction – offentlig side + admin + dommermodus.
// Ingen rammeverk: én fil, ~20 KB, lastes etter crests.js (som gir crest(), TEAMS og COLORS).
'use strict';

let state = null, admin = false, user = null, csrf = null;
let currentRound = null, saving = false, stateKey = null, timeOffset = 0;
const dirty = new Set(), timers = new Map();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- API ----------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' } : csrf ? { 'X-CSRF-Token': csrf } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok) { const err = Error(data.error || 'Kunne ikke hente data.'); err.status = res.status; throw err; }
  return data;
}
function setState(next) {
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
function render() {
  if (!state) return;
  const fav = followed();
  $('#standings').innerHTML = state.table.map((r, i) => `<tr class="pair-${Math.floor(i / 2)}${fav.includes(r.name) ? ' followed' : ''}"><td>${i + 1}</td><td><span class="team-label">${rowTeam(r.name)}</span></td><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gf}–${r.ga}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td>${r.pts}</td></tr>`).join('');

  const live = state.matches.filter((m) => m.status === 'live').length;
  $('#live-indicator').textContent = live ? `${live} kamp${live === 1 ? '' : 'er'} pågår` : 'Ingen kamper pågår';
  $('#live-indicator').classList.toggle('live', live > 0);
  const completed = state.matches.filter((m) => m.status === 'finished' && m.hs !== null && m.aws !== null).length;
  $('#progress').textContent = `${completed} av ${state.matches.length} kamper ferdigspilt`;

  let next = state.matches.filter((m) => m.status === 'live');
  if (!next.length) next = state.matches.filter((m) => m.status === 'upcoming');
  next = next.slice(0, 4);
  // Lagene du følger får sin neste kamp øverst, selv om den er senere enn de fire første.
  const favNext = [...new Set(fav.map((t) => state.matches.find((m) => m.status !== 'finished' && (m.home === t || m.away === t))).filter(Boolean))];
  if (favNext.length) next = [...favNext, ...next.filter((m) => !favNext.includes(m))].slice(0, Math.max(4, favNext.length));
  $('#upcoming').innerHTML = next.map((m) => `<div class="fixture${favNext.includes(m) ? ' followed' : ''}"><div class="fixture-meta"><span>${m.start}–${m.end} · Bane ${m.pitch}</span><span>${matchTitle(m)}</span></div><div class="fixture-team">${rowTeam(m.home)}<b>${m.status === 'live' ? score(m.hs) : ''}</b></div><div class="fixture-team">${rowTeam(m.away)}<b>${m.status === 'live' ? score(m.aws) : ''}</b></div>${m.provisional ? '<p class="small-note">Foreløpig oppsett</p>' : ''}</div>`).join('') || '<div class="fixture">Alle kampene er ferdigspilt.</div>';

  $('#auth-button').innerHTML = admin ? `Logg ut${user ? ' <span class="auth-user">(' + esc(user) + ')</span>' : ''}` : 'Admin';
  $('#nom-tab').hidden = !admin;
  if (!admin && tabName === 'nominations') selectTab('table');
  const fb = $('#follow-button');
  fb.textContent = !fav.length ? 'Følg lag' : fav.length === 1 ? `★ ${fav[0]}` : `★ ${fav.length} lag`;
  if (!dirty.size && !$('#match-cards').contains(document.activeElement)) renderCards();
  if (refId) renderRef();
}

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
function seedingHtml() {
  if (!admin) return '';
  const hasResults = state.matches.some((m) => m.kind === 'playoff' && (m.hs !== null || m.aws !== null));
  if (!state.seeded) return `<div class="seed-banner"><p><strong>Oppsettet er foreløpig.</strong> Det låses automatisk når alle 30 seriekampene er avsluttet. Er seriespillet ferdig før klokka sier det, kan du låse nå og registrere sluttspillresultater med en gang.</p><button class="primary" data-seed="lock">Lås oppsettet nå</button></div>`;
  return hasResults ? '' : `<div class="seed-banner quiet"><p>Oppsettet er låst etter tabellen.</p><button class="text-button" data-seed="unlock">Lås opp igjen</button></div>`;
}
function matchCard(m, showRound = false) {
  const editable = admin && !m.provisional;
  const fav = followed();
  const isFav = isMine(m, fav);
  const winner = m.kind === 'playoff' ? decided(m) : null;
  const drawNeedsWinner = m.kind === 'playoff' && m.hs !== null && m.hs === m.aws;
  const won = decided(m);
  // Admin får store −/+ ved målfeltet. (div, ikke label: en label ville sendt trykk på lagnavnet til −-knappen.)
  const rows = [['home', 'hs'], ['away', 'aws']].map(([side, field]) => `<div class="score-block${won && won === m[side] ? ' won' : ''}">${editable
    ? `<div class="score-row">${rowTeam(m[side])}<div class="stepper"><button type="button" data-step="-1" aria-label="Ett mål mindre for ${esc(m[side])}">−</button><input aria-label="Mål ${esc(m[side])}" data-field="${field}" type="number" min="0" max="99" step="1" inputmode="numeric" value="${m[field] ?? ''}" placeholder="–"><button type="button" data-step="1" aria-label="Ett mål til ${esc(m[side])}">+</button></div></div>`
    : `<div class="score-row">${rowTeam(m[side])}<b>${score(m[field])}</b></div>`}</div>`).join('');
  const winnerSelect = `<label class="winner-pick">Vinner etter uavgjort<select data-field="winner"><option value="">Ikke avgjort ennå</option>${[m.home, m.away].map((t) => `<option ${m.winner === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const controls = editable ? `<div class="admin-controls">
      <button class="primary ref-open" data-ref="${m.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>Dommermodus</button>
      ${drawNeedsWinner ? winnerSelect : ''}
      <div class="admin-row">${m.status !== 'finished' ? `<button class="outline dark" data-finish="${m.id}">Avslutt kamp</button>` : '<span class="small-note">Kampen er avsluttet.</span>'}<span class="small-note save-message" role="status">${lastEdit(m) || 'Mål lagres automatisk'}</span></div>
      <details><summary>Overstyr status</summary><label>Kampstatus<select data-field="mode">${[['auto', 'Følg klokka (standard)'], ['upcoming', 'Ikke startet'], ['live', 'Pågår'], ['finished', 'Avsluttet']].map(([v, l]) => `<option value="${v}" ${v === m.mode ? 'selected' : ''}>${l}</option>`).join('')}</select></label></details>
    </div>` : '';
  const isFinal = m.kind === 'playoff' && m.ranks[1] === 1;
  return `<article class="match ${m.status}${isFav ? ' followed' : ''}${isFinal ? ' final' : ''}" data-id="${m.id}">
    <div class="match-header"><span>${m.start}–${m.end} · Bane ${m.pitch}${showRound && m.kind !== 'playoff' ? ` · Runde ${m.round}` : ''}</span><span class="status">${statusLabel(m)}</span></div>
    ${m.kind === 'playoff' ? `<h3>${isFinal ? '<span class="final-star" aria-hidden="true">★</span>' : ''}${matchTitle(m)}</h3><p class="small-note pair-note">${m.ranks[0]}. mot ${m.ranks[1]}. plass${m.provisional ? ' · foreløpig' : ''}</p>` : ''}
    ${rows}${controls}
    ${m.status === 'finished' && (m.hs === null || m.aws === null) ? '<p class="small-note">Avsluttet – venter på resultat.</p>' : ''}
    ${m.kind === 'playoff' && m.status === 'finished' && m.hs !== null && m.aws !== null ? `<p class="winner">${winner ? 'Vinner: ' + esc(winner) : 'Uavgjort – vinner ikke valgt'}</p>` : ''}
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
  const ms = state.matches.filter((m) => m.round === currentRound);
  $('#round-description').textContent = currentRound === 10
    ? `Plasseringskamper kl. 13.35–13.50 · Finale kl. 13.55–14.10. ${state.seeded ? 'Motstanderne er låst etter seriespillet.' : 'Motstanderne er foreløpige og følger tabellen til alle serieresultater er klare.'}`
    : `10. oktober · kl. ${ms[0].start}–${ms[0].end} · ${ms.length} kamper.${admin ? ' Mål lagres automatisk.' : ''}`;
  $('#round-extra').innerHTML = currentRound === 10 ? podiumHtml() + seedingHtml() : '';
  // Finalen spilles etter plasseringskampene, så den får egen rad under et skille.
  const final = currentRound === 10 ? ms.find((m) => m.ranks[1] === 1) : null;
  $('#match-cards').innerHTML = ms.filter((m) => m !== final).map(matchCard).join('')
    + (final ? `<div class="final-divider"><span>Deretter · kl. ${final.start.replace(':', '.')}</span></div>${matchCard(final)}` : '');
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
    return `<div class="fav-time${now ? ' now' : ''}"><b>${clock(st)}</b><small>${label}</small></div>${fav.map((t) => { const m = inSlot.find((x) => x.home === t || x.away === t); return m ? favCell(m, t) : '<div class="fav-empty" aria-label="Pause"></div>'; }).join('')}`;
  }).join('');
  $('#fav-grid').innerHTML = `<div class="fav-grid" role="table" aria-label="Kampskjema for favorittlag">${head}${rows}</div>`;
  $('#fav-grid .fav-grid').style.setProperty('--cols', fav.length);
}
$('#fav-grid').addEventListener('click', (e) => { const c = e.target.closest('[data-ref]'); if (c && admin) openRef(Number(c.dataset.ref)); });

// Innskrevne mål lagres automatisk (etter en kort pause), status/vinner lagres straks.
async function saveCard(id, overrides = {}) {
  clearTimeout(timers.get(id));
  if (saving) { timers.set(id, setTimeout(() => saveCard(id, overrides), 200)); return; }
  const card = document.querySelector(`#match-cards [data-id="${id}"]`);
  const m = state.matches.find((x) => x.id === id);
  if (!m || (!dirty.has(id) && !Object.keys(overrides).length)) return;
  const msg = card && card.querySelector('.save-message');
  const say = (t) => { if (msg) msg.textContent = t; };
  const val = (f) => card ? card.querySelector(`[data-field="${f}"]`)?.value : undefined;
  if (card && [...card.querySelectorAll('input')].some((i) => !i.checkValidity())) { say('Bruk hele mål mellom 0 og 99.'); return; }
  const num = (v, fallback) => (v === undefined ? fallback : v === '' ? null : Number(v));
  const body = { id, hs: num(val('hs'), m.hs), aws: num(val('aws'), m.aws), mode: val('mode') ?? m.mode, winner: (val('winner') ?? m.winner) || null, version: m.version, ...overrides };
  if (body.hs !== body.aws) body.winner = null;
  saving = true; say('Lagrer …');
  try {
    setState(await api('/api/score', body));
    dirty.delete(id); error(''); render(); renderCards();
  } catch (e) {
    if (e.status === 409) {
      dirty.delete(id); saving = false; await refresh(true); renderCards();
      error('En annen admin endret kampen samtidig. Siste resultat vises nå – legg inn ditt igjen om nødvendig.');
      return;
    }
    error(e.message); say('Ikke lagret. Rett feilen eller last siden på nytt.');
  } finally { saving = false; }
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
async function finishMatch(id) {
  const m = state.matches.find((x) => x.id === id);
  if (m.hs === null || m.aws === null) { error('Registrer resultatet før du avslutter kampen.'); return false; }
  const ok = await confirmBox('Avslutte kampen?', `${m.home} ${score(m.hs)}–${score(m.aws)} ${m.away} blir sluttresultatet og teller i tabellen.`, 'Ja, avslutt');
  if (!ok) return false;
  dirty.add(id);
  await saveCard(id, { mode: 'finished', hs: m.hs, aws: m.aws });
  return true;
}

$('#match-cards').addEventListener('input', (e) => {
  if (e.target.tagName !== 'INPUT') return;
  const id = Number(e.target.closest('[data-id]').dataset.id);
  dirty.add(id); clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => saveCard(id), 550));
});
$('#match-cards').addEventListener('change', (e) => {
  if (e.target.tagName !== 'SELECT') return;
  const id = Number(e.target.closest('[data-id]').dataset.id);
  dirty.add(id); saveCard(id);
});
$('#match-cards').addEventListener('click', async (e) => {
  const step = e.target.closest('[data-step]');
  if (step) {
    const input = step.parentElement.querySelector('input'), delta = Number(step.dataset.step);
    input.value = input.value === '' ? Math.max(0, delta) : Math.min(99, Math.max(0, Number(input.value) + delta));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const ref = e.target.closest('[data-ref]'), fin = e.target.closest('[data-finish]');
  if (ref) openRef(Number(ref.dataset.ref));
  if (fin) { const id = Number(fin.dataset.finish); if (dirty.has(id)) await saveCard(id); finishMatch(id); }
});
$('#round-extra').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-seed]');
  if (!b) return;
  const lock = b.dataset.seed === 'lock';
  const ok = await confirmBox(lock ? 'Låse sluttspilloppsettet?' : 'Låse opp oppsettet?', lock ? 'Motstanderne settes etter tabellen slik den står nå. Senere rettelser i seriespillet endrer ikke oppsettet.' : 'Oppsettet følger tabellen igjen til alle seriekampene er avsluttet.', lock ? 'Ja, lås' : 'Ja, lås opp');
  if (!ok) return;
  try { setState(await api('/api/seeding', { action: b.dataset.seed })); error(''); render(); renderCards(); } catch (err) { error(err.message); }
});

function changeRound(r) {
  if (dirty.size) { error('Vent til endringene er lagret før du bytter runde.'); return; }
  currentRound = r; renderCards();
}
// Følger du lag, får du en egen fane først med alle kampene deres.
function renderRoundTabs(fav) {
  const tabs = [...(fav.length ? [['mine', '★ Favoritter']] : []), ...Array.from({ length: 10 }, (_, i) => [i + 1, i === 9 ? 'Sluttspill' : 'Runde ' + (i + 1)])];
  // Runden med en kamp som pågår får en grønn prikk.
  const liveRound = state.matches.find((m) => m.status === 'live')?.round;
  $('#round-tabs').innerHTML = tabs.map(([r, label]) => `<button data-round="${r}" aria-pressed="${r === currentRound}" class="${r === currentRound ? 'active' : ''}${r === liveRound ? ' has-live' : ''}${r === 'mine' ? ' mine-tab' : ''}">${esc(label)}</button>`).join('');
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
let refId = null, goalChain = Promise.resolve(), goalsPending = 0, clockTimer = null, wakeLock = null, toastTimer = null;
const ref = $('#ref');
function renderRef() {
  const m = state && state.matches.find((x) => x.id === refId);
  if (!m) return closeRef();
  ref.style.setProperty('--home', teamColor(m.home));
  ref.style.setProperty('--away', teamColor(m.away));
  $('#ref-title').textContent = `${matchTitle(m)} · Bane ${m.pitch}`;
  for (const side of ['home', 'away']) {
    const f = side === 'home' ? 'hs' : 'aws';
    const el = ref.querySelector(`.ref-side[data-side="${side}"]`);
    el.querySelector('.ref-crest').innerHTML = crest(m[side]);
    el.querySelector('.ref-name').textContent = m[side];
    el.querySelector('.ref-score').textContent = m[f] ?? 0;
    el.querySelector('.ref-goal').setAttribute('aria-label', `Mål til ${m[side]}. Stilling ${m[f] ?? 0}`);
    el.querySelector('.ref-undo').disabled = !m[f];
    el.querySelector('.ref-undo').setAttribute('aria-label', `Fjern ett mål fra ${m[side]}`);
  }
  const needsWinner = m.kind === 'playoff' && (m.hs ?? 0) === (m.aws ?? 0);
  const done = m.status === 'finished', upcoming = m.status === 'upcoming';
  $('#ref-start').hidden = !upcoming;
  $('#ref-finish').hidden = done || upcoming;
  const next = done && nextOnPitch(m);
  $('#ref-next').hidden = !next;
  if (next) $('#ref-next').textContent = `Neste kamp på bane ${m.pitch}: kl. ${clock(next.start)}, ${next.home} mot ${next.away} →`;
  $('#ref-nominate').hidden = !!m.provisional;
  renderRefNoms();
  $('#ref-done').hidden = !done;
  $('#ref-winner').hidden = !(needsWinner && m.hs !== null);
  $('#ref-winner').innerHTML = `<span>Uavgjort i sluttspill – hvem vant på straffer?</span>${[m.home, m.away].map((t) => `<button type="button" class="${m.winner === t ? 'chosen' : ''}" data-winner="${esc(t)}">${esc(t)}</button>`).join('')}`;
  $('#ref-edit').textContent = lastEdit(m);
  tickClock();
}
function nextOnPitch(m) { return state.matches.filter((x) => x.pitch === m.pitch && x.start > m.start && !x.provisional).sort((a, b) => a.start.localeCompare(b.start))[0]; }
function tickClock() {
  const m = state && state.matches.find((x) => x.id === refId);
  if (!m) return;
  const { date, secs } = osloClock();
  const start = hmToSecs(m.start), end = hmToSecs(m.end);
  let text = `${m.start}–${m.end}`;
  if (m.status === 'finished') text = 'Slutt';
  else if (date === state.config.date) {
    if (secs < start) text = start - secs <= 3600 ? `Avspark om ${mmss(start - secs)}` : `Avspark ${m.start}`;
    else if (secs < end) text = `${mmss(end - secs)} igjen`;
    else text = 'Tiden er ute';
  }
  $('#ref-clock').textContent = text;
}
async function openRef(id) {
  if (dirty.has(id)) await saveCard(id);
  refId = id;
  renderRef();
  ref.hidden = false;
  document.body.classList.add('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = true;
  $('#ref-close').focus();
  (ref.requestFullscreen || ref.webkitRequestFullscreen)?.call(ref)?.catch?.(() => {});
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  clockTimer = setInterval(tickClock, 1000);
}
function closeRef() {
  if (!refId) return;
  refId = null;
  clearInterval(clockTimer);
  ref.hidden = true;
  document.body.classList.remove('ref-on');
  for (const el of document.querySelectorAll('body > header, body > main')) el.inert = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  renderCards();
}
function toast(text, undoSide) {
  const t = $('#ref-toast');
  t.innerHTML = `<span>${esc(text)}</span>${undoSide ? `<button type="button" data-undo="${undoSide}">Angre</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}
// Mål sendes i kø (ett om gangen) og vises med en gang (optimistisk).
function goal(side, delta) {
  const m = state.matches.find((x) => x.id === refId);
  if (!m) return;
  const f = side === 'home' ? 'hs' : 'aws', o = side === 'home' ? 'aws' : 'hs';
  if (delta < 0 && !m[f]) return;
  m[f] = Math.max(0, (m[f] ?? 0) + delta); if (m[o] === null) m[o] = 0;
  if (delta > 0) navigator.vibrate?.(35);
  renderRef();
  toast(delta > 0 ? `Mål til ${m[side]} · ${m.hs}–${m.aws}` : `Mål fjernet · ${m.hs}–${m.aws}`, delta > 0 ? side : null);
  const id = refId;
  goalsPending++;
  goalChain = goalChain.then(async () => {
    try { setState(await api('/api/goal', { id, side, delta })); error(''); }
    catch (e) { toast('Ikke lagret: ' + e.message); await refresh(true); }
    finally { goalsPending--; if (!goalsPending) render(); }
  });
}
ref.addEventListener('click', async (e) => {
  const g = e.target.closest('.ref-goal'), u = e.target.closest('.ref-undo'), undo = e.target.closest('[data-undo]'), w = e.target.closest('[data-winner]');
  if (g) goal(g.closest('.ref-side').dataset.side, 1);
  if (u) goal(u.closest('.ref-side').dataset.side, -1);
  if (undo) { goal(undo.dataset.undo, -1); $('#ref-toast').hidden = true; }
  if (w) { await goalChain; const m = state.matches.find((x) => x.id === refId); dirty.add(refId); await saveCard(refId, { winner: w.dataset.winner, hs: m.hs, aws: m.aws, mode: m.mode }); renderRef(); }
  if (e.target.closest('#ref-close')) closeRef();
  if (e.target.closest('#ref-nominate')) openNom();
  if (e.target.closest('#ref-start')) {
    await goalChain;
    const m = state.matches.find((x) => x.id === refId);
    dirty.add(refId); await saveCard(refId, { mode: 'live', hs: m.hs ?? 0, aws: m.aws ?? 0 }); renderRef();
  }
  // Neste kamp på samme bane: bytt kamp i den åpne dommermodusen (ikke åpne en ny oppå).
  if (e.target.closest('#ref-next')) {
    const n = nextOnPitch(state.matches.find((x) => x.id === refId));
    if (n) { refId = n.id; renderRef(); }
  }
  if (e.target.closest('#ref-finish')) {
    await goalChain;
    const m = state.matches.find((x) => x.id === refId);
    if (m.kind === 'playoff' && m.hs === m.aws && !m.winner) { toast('Velg vinner før du avslutter.'); return; }
    if (await finishMatch(refId)) renderRef();
  }
});
// Esc lukker dommermodus (men ikke mens bekreftelsesboksen er åpen).
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && refId && !$('#confirm-score').open && !$('#nom-dialog').open) closeRef(); });
// Går telefonen ut av fullskjerm (sveip/tilbake), blir vi i dommermodus – laget dekker fortsatt hele skjermen.

// ---------- Innlogging ----------------------------------------------------------
$('#auth-button').addEventListener('click', async () => {
  if (admin) {
    if (dirty.size) { error('Vent til endringene er lagret før du logger ut.'); return; }
    try { await api('/api/logout', {}); admin = false; user = null; csrf = null; noms = []; nomSnapshot = ''; $('#nom-board').innerHTML = ''; render(); renderCards(); } catch (e) { error(e.message); }
  } else $('#login-dialog').showModal();
});
$('#login-dialog .close').addEventListener('click', () => $('#login-dialog').close());
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, button = form.querySelector('button.primary');
  button.disabled = true; button.textContent = 'Logger inn …';
  try {
    const s = await api('/api/login', { username: form.username.value, password: form.password.value });
    admin = s.admin; user = s.user; csrf = s.csrf;
    form.reset(); $('#login-error').textContent = ''; $('#login-dialog').close();
    currentRound = defaultRound(); render(); renderCards(); selectTab('matches');
  } catch (err) { $('#login-error').textContent = err.message; }
  finally { button.disabled = false; button.textContent = 'Logg inn'; }
});

// ---------- Oppdatering (billig polling) ---------------------------------------
// Serveren svarer {same:true} når ingenting er endret – da leses bare 2 rader i D1.
// Hyppighet: 8 s når noe pågår eller du er admin, ellers 20 s. Pause når fanen er skjult.
let pollTimer = null;
function pollDelay() {
  const live = state && state.matches.some((m) => m.status === 'live');
  // Publikum sjekker gjerne kort og legger bort telefonen. Pausen når fanen er skjult
  // og en ny henting når den vises igjen gjør at dette holder godt for ~100 samtidige
  // innenfor Cloudflares gratisplan (100 000 Worker-forespørsler per døgn).
  if (admin) return 8000;
  return live ? 12000 : 30000;
}
function schedule() { clearTimeout(pollTimer); if (!document.hidden) pollTimer = setTimeout(async () => { await refresh(); schedule(); }, pollDelay()); }
async function refresh(force) {
  if (!force && (saving || dirty.size || goalsPending)) return;
  try {
    const data = await api('/api/state' + (stateKey && !force ? '?since=' + encodeURIComponent(stateKey) : ''));
    if (data.same) { if (data.serverTime) timeOffset = Date.parse(data.serverTime) - Date.now(); }
    else { const before = state; setState(data); notifyChanges(before, data); render(); }
    // Nominasjonene er ikke en del av stateKey, så de hentes eget – bare for admin som ser på dem.
    if (admin && (tabName === 'nominations' || refId)) loadNoms();
    $('#connection-status').textContent = 'Oppdatert ' + new Date(Date.now() + timeOffset).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Oslo' });
    error('');
  } catch (e) {
    $('#connection-status').textContent = 'Frakoblet · prøver igjen';
    error('Kunne ikke hente oppdateringer. Viser sist mottatte resultater.');
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); schedule(); } else clearTimeout(pollTimer); });

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
      if (system) new Notification('Slutt', { body: text, tag: 'k' + m.id });
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
  if (notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
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
  admin = false; user = null; csrf = null; noms = []; nomSnapshot = ''; $('#nom-board').innerHTML = '';
  if ($('#nom-dialog').open) $('#nom-dialog').close();
  closeRef(); render(); renderCards();
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
    return `<article class="nom-award"><header><span class="award-icon">${info.icon}</span><div><h3>${info.name}</h3><p>${list.length ? `${cands.length} kandidat${cands.length === 1 ? '' : 'er'}, ${list.length} nominasjon${list.length === 1 ? '' : 'er'}` : 'Ingen nominert ennå'}</p></div></header>${cands.length ? `<ol class="nom-cands">${cands.map(([key, items], i) => {
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

// ---------- Lasteskjerm: bare første besøk i økten --------------------------------
const loaderImages = ['barca.gif', 'griezman.gif', 'haaland-robot.gif', 'luiz.gif', 'messi.gif', 'messi_2.gif', 'portugal.gif', 'ramos.gif', 'ronaldinhos-skills-1.gif', 'ronaldo.gif', 'ronaldo_2.gif', 'sturrige.gif', 'var.gif'];
(function loader() {
  let seen = false;
  try { seen = sessionStorage.getItem('konfaction-seen') === '1'; sessionStorage.setItem('konfaction-seen', '1'); } catch {}
  if (seen || reducedMotion) { $('#loader').remove(); return; }
  $('#loader-pixel').src = 'pixel/' + loaderImages[Math.floor(Math.random() * loaderImages.length)];
  const duration = 2000 + Math.random() * 3000;
  $('#load-bar').style.transitionDuration = Math.max(duration - 300, 0) + 'ms';
  setTimeout(() => ($('#load-bar').style.width = '100%'), 30);
  setTimeout(() => $('#loader').classList.add('done'), duration);
})();

(async () => {
  try { const s = await api('/api/session'); admin = s.admin; user = s.user; csrf = s.csrf; } catch {}
  await refresh(true);
  schedule();
})();
