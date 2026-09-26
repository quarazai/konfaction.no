// KonfAction: Cloudflare Worker port of server.py.
// Stateless HMAC-signed cookie instead of an in-memory sessions map — Workers
// don't keep a single long-lived process, so server.py's SESSIONS dict has no
// equivalent here and isn't needed: everything a session held (admin, public,
// gate question index, csrf, expiry) fits in the cookie itself.
import CONFIG from "./config/tournament.json";

const GATE_QUESTIONS = [
  // Svarene står slik normalize() lager dem: små bokstaver, bare bokstaver og tall (æøå beholdes).
  // Nynorsk (kjærleik), Bibel 2011 (Vasjti) og engelske former (Vashti, Goliath, Jesse) godtas også.
  ["Hva er hovedtemaet i 1. Korinterbrev 13?", ["kjærlighet", "kjærligheten", "kjærleik", "kjærleiken"]],
  // Goliat kommer først i kapittel 17, men godtas fortsatt så ingen blir stoppet av det.
  ["Nevn en av hovedpersonene i 1. Samuelsbok 16.", ["david", "samuel", "isai", "jesse", "saul", "goliat", "goliath"]],
  ["Hvem er hovedpersonen i 1. Mosebok 6?", ["noa", "noah"]],
  ["Hva heter dronningen i Esters bok 1?", ["vasti", "vasjti", "vashti"]],
  ["Nevn en profet i Dommerne 4.", ["deborah", "debora"]],
  // 20 nye (26.09.2026), kryssjekket mot Bibel 2011 (nb-2011) på bibel.no før de ble lagt inn.
  ["Nevn en av de to brødrene i 1. Mosebok 4.", ["kain", "abel"]],
  ["Nevn far eller sønn i offerhistorien i 1. Mosebok 22.", ["abraham", "isak", "isaac"]],
  ["Hvem blir solgt som slave av brødrene sine i 1. Mosebok 37?", ["josef", "joseph"]],
  ["Hvem møter Gud i den brennende tornebusken i 2. Mosebok 3?", ["moses"]],
  ["Nevn profeten som leder folket gjennom Rødehavet i 2. Mosebok 14.", ["moses"]],
  ["Hvem blir slukt av en stor fisk i Jona bok, kapittel 1?", ["jona", "jonah"]],
  ["Hvem kastes i løvehulen i Daniel 6?", ["daniel"]],
  ["Nevn en av kvinnene i Ruts bok, kapittel 1.", ["rut", "ruth", "noomi", "naomi"]],
  ["Hvem feller den berømte dommen om de to kvinnene og barnet i 1. Kongebok 3?", ["salomo", "salomon", "solomon"]],
  ["Hvilken profet utfordrer Ba'als profeter i 1. Kongebok 18?", ["elia", "elijah"]],
  ["Nevn en av hovedpersonene i historien om hårklippingen i Dommerne 16.", ["samson", "simson", "dalila", "delilah"]],
  ["Hvem mister alt han eier i Job bok, kapittel 1?", ["job"]],
  ["Hvilken engel besøker Maria i Lukas 1?", ["gabriel"]],
  ["Hvem døper Jesus i Matteus 3?", ["johannes", "johannesdøperen"]],
  ["Hvor forvandler Jesus vann til vin i Johannes 2?", ["kana"]],
  ["Hvem vekker Jesus opp fra de døde i Johannes 11?", ["lasarus", "lazarus"]],
  ["Hvem klatrer opp i et tre for å se Jesus i Lukas 19?", ["sakkeus", "zakkeus", "zaccheus"]],
  ["Hvilken disippel tviler på oppstandelsen i Johannes 20?", ["tomas", "thomas"]],
  ["Hvem blir blind på veien til Damaskus i Apostlenes gjerninger 9?", ["paulus", "saulus", "saul"]],
  ["I hvilken by opplever disiplene pinsedag i Apostlenes gjerninger 2?", ["jerusalem"]],
];

const ENTRY_PASSWORD = "siuuuuuuu";
const GATE_OPEN = "2026-10-07T23:59:00";
const GATE_CLOSE = "2026-10-10T06:00:00";

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; " +
  "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Gratisplanen hos Cloudflare gir 10 ms CPU per forespørsel. 600 000 runder
// PBKDF2 bruker ~250 ms og kan gi feil 1102 ved innlogging. Hver bruker kan derfor
// ha sitt eget «iter»-felt (setup_admin_cloudflare.py skriver 5 000 som standard).
// Brukere uten feltet (laget med eldre skript) faller tilbake til 600 000.
const PBKDF2_LEGACY_ITERATIONS = 600000;
const PBKDF2_DEFAULT_ITERATIONS = 5000; // matches setup_admin_cloudflare.py's DEFAULT_ITERATIONS

// -- small helpers --------------------------------------------------------

function b64urlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(str) {
  return Uint8Array.from(str.match(/../g).map((b) => parseInt(b, 16)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function normalize(value) {
  return [...String(value).toLowerCase().trim()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

// Oslo wall-clock time as a sortable "YYYY-MM-DDTHH:MM:SS" string — avoids
// hardcoding the CEST/CET offset, which flips on the last Sunday of October.
function osloNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
// Alle kallere sender inn et Date-objekt. Det må gjøres om til Oslo-tid som tekst før
// sammenligningen: Date >= "2026-..." er alltid false, og da slo gåten aldri inn.
function gatePhase(date) {
  const now = osloNow(date);
  if (now < GATE_OPEN) return "password";
  if (now < GATE_CLOSE) return "bible";
  return null;
}
function gateActive(date) {
  return gatePhase(date) !== null;
}

// -- session cookie (stateless, HMAC-signed) -------------------------------

// Glemt «wrangler secret put SESSION_SECRET»: uten den kan ingen passere inngangen eller logge inn.
// Feilen fanges øverst og blir en tydelig 503 (og en linje i «wrangler tail») i stedet for «Serverfeil».
class ConfigError extends Error {}
async function hmacKey(env) {
  if (!env.SESSION_SECRET) throw new ConfigError("SESSION_SECRET mangler. Kjør setup_admin_cloudflare.py og wrangler secret put (se README).");
  return crypto.subtle.importKey("raw", b64urlDecode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(env, payload) {
  const key = await hmacKey(env);
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
  return `${body}.${sig}`;
}
async function readSession(env, request) {
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)session=([^;]+)/);
  if (!cookie) return null;
  const [body, sig] = cookie[1].split(".");
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
// Safari lagrer ikke «Secure»-cookies over http, heller ikke lokalt. Ved lokal kjøring (wrangler dev)
// sløyfes derfor Secure; på konfaction.no går alt over https og cookien er alltid Secure.
let cookieSecure = "; Secure";
function isLocalHost(url) {
  return /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/.test(url.hostname);
}
function cookieHeader(token, maxAge) {
  return `session=${token}; HttpOnly${cookieSecure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
const clearCookie = () => `session=; HttpOnly${cookieSecure}; SameSite=Strict; Path=/; Max-Age=0`;

// -- tournament state (mirrors server.py's state()/standings()/effective()) -

// Klokka styrer ikke status. En kamp er «Pågår» fra dommeren trykker Start til noen
// trykker Avslutt. Da blir tabell og sluttspilloppsett aldri låst på et halvferdig resultat
// om en runde drar ut. «auto» er standardverdien i databasen og betyr «ikke startet».
function effective(m) {
  return m.status === "live" || m.status === "finished" ? m.status : "upcoming";
}
// Spilletid i sekunder, fra kampoppsettet (15 minutter).
function duration(m) {
  const [sh, sm] = m.start.split(":").map(Number), [eh, em] = m.end.split(":").map(Number);
  return (eh * 60 + em - sh * 60 - sm) * 60;
}
// Lag som er helt like etter alle reglene (også innbyrdes oppgjør) avgjøres ved myntkast/
// loddtrekning -- uansett om likheten krysser et sluttspillpar (avgjør hvem som møter hvem)
// eller ligger innenfor ett par (1|2, 3|4 … -- avgjør da bare hvem som er hjemmelag).
// decisions: lagrede avgjørelser (nøkkel «Delta|Echo»), bare med når serien er ferdig.
// Returnerer tabellen og gruppene som betyr noe (med eventuell gyldig avgjørelse og h2h:
// «never» ingen av lagene har møtt hverandre, «partial» noen men ikke alle har møtt hverandre
// (innbyrdes teller da ikke), «level» alle har møtt hverandre og innbyrdes skiller dem ikke).
function tieKey(names) {
  return [...names].sort().join("|");
}
function validDecision(dec, names) {
  if (!dec || !["proposed", "approved"].includes(dec.status) || !Array.isArray(dec.order) || dec.order.length !== names.length) return false;
  return names.every((n) => dec.order.includes(n));
}
function standings(matches, decisions = null) {
  const rows = new Map(CONFIG.teams.map((n, i) => [n, { name: n, index: i, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
  for (const m of matches) {
    if (m.kind !== "league" || m.status === "upcoming" || m.hs === null || m.aws === null) continue;
    for (const [team, gf, ga] of [[m.home, m.hs, m.aws], [m.away, m.aws, m.hs]]) {
      const r = rows.get(team);
      r.p++; r.gf += gf; r.ga += ga; r.gd = r.gf - r.ga;
      if (gf > ga) { r.w++; r.pts += 2; } else if (gf === ga) { r.d++; r.pts += 1; } else r.l++;
    }
  }
  // Tiebreak: poeng, målforskjell, scorede mål, innbyrdes oppgjør, så fast rekkefølge.
  // Samme regel som server.py og teksten under «Om turneringen».
  const ordered = [...rows.values()].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.index - b.index);
  const played = matches.filter((m) => m.kind === "league" && m.status !== "upcoming" && m.hs !== null && m.aws !== null);
  const met = new Set();
  for (const m of played) { met.add(m.home + "\n" + m.away); met.add(m.away + "\n" + m.home); }
  // Innbyrdes oppgjør teller bare når alle de like lagene har møtt hverandre (hvert lag møter
  // bare seks av ni). Skiller minitabellen noen av dem, brukes regelen på nytt blant lagene som
  // fortsatt er like. Svarer med delene i tabellrekkefølge; en del med flere lag er fortsatt lik.
  function resolve(run) {
    if (run.length < 2) return [{ rows: run }];
    let pairs = 0;
    for (let a = 0; a < run.length; a++) for (let b = a + 1; b < run.length; b++) if (met.has(run[a].name + "\n" + run[b].name)) pairs++;
    if (pairs < (run.length * (run.length - 1)) / 2) return [{ rows: run, h2h: pairs ? "partial" : "never" }];
    const names = new Set(run.map((r) => r.name));
    const mini = Object.fromEntries(run.map((r) => [r.name, { pts: 0, gd: 0, gf: 0 }]));
    for (const m of played) {
      if (!names.has(m.home) || !names.has(m.away)) continue;
      for (const [t, gf, ga] of [[m.home, m.hs, m.aws], [m.away, m.aws, m.hs]]) {
        mini[t].gf += gf; mini[t].gd += gf - ga; mini[t].pts += gf > ga ? 2 : gf === ga ? 1 : 0;
      }
    }
    const h2h = (a, b) => mini[b.name].pts - mini[a.name].pts || mini[b.name].gd - mini[a.name].gd || mini[b.name].gf - mini[a.name].gf;
    const sorted = [...run].sort((a, b) => h2h(a, b) || a.index - b.index);
    const parts = [];
    for (let a = 0; a < sorted.length; ) {
      let b = a;
      while (b + 1 < sorted.length && h2h(sorted[a], sorted[b + 1]) === 0) b++;
      parts.push(sorted.slice(a, b + 1));
      a = b + 1;
    }
    return parts.length === 1 ? [{ rows: sorted, h2h: "level" }] : parts.flatMap(resolve);
  }
  const out = [], groups = [];
  for (let i = 0; i < ordered.length; ) {
    let j = i;
    const same = (x, y) => x.pts === y.pts && x.gd === y.gd && x.gf === y.gf;
    while (j + 1 < ordered.length && same(ordered[j + 1], ordered[i])) j++;
    for (const part of resolve(ordered.slice(i, j + 1))) {
      let run = part.rows;
      const start = out.length, end = out.length + run.length - 1;
      // Fortsatt like lag: en gruppe som avgjøres ved myntkast/loddtrekning -- også når de er like
      // KUN innenfor samme sluttspillpar (f.eks. 3.|4. plass, som uansett møtes). Da avgjør
      // myntkastet bare hvem som er hjemmelag, men det er fortsatt myntkast, ikke fast rekkefølge.
      if (run.length > 1) {
        const teams = run.map((r) => r.name);
        const key = tieKey(teams);
        const dec = decisions && Object.hasOwn(decisions, key) && validDecision(decisions[key], teams) ? decisions[key] : null;
        groups.push({ key, teams, positions: run.map((_, k) => start + k + 1), decision: dec, h2h: part.h2h });
        if (dec) run = dec.order.map((n) => run.find((r) => r.name === n));
      }
      out.push(...run);
    }
    i = j + 1;
  }
  return { table: out, groups };
}
function leagueFinished(matches) {
  return matches.every((m) => m.kind !== "league" || (m.status === "finished" && m.hs !== null && m.aws !== null));
}
function tieView(key, teams, positions, dec, h2h, afterFreeze) {
  return {
    key, teams, positions, h2h, afterFreeze,
    kind: dec ? dec.kind : null,
    status: dec ? dec.status : "pending",
    order: dec ? dec.order : null,
    by: dec ? dec.by ?? null : null,
    at: dec ? dec.at ?? null : null,
    approvedBy: dec ? dec.approvedBy ?? null : null,
    approvedAt: dec ? dec.approvedAt ?? null : null,
  };
}
// Myntkast-listen: alle grupper i dagens tabell som betyr noe. En gruppe uten avgjørelse etter at
// oppsettet er låst (låst for tidlig, eller en rettelse etter låsingen skapte den) får
// afterFreeze: true. Den stopper ingenting, men viser admin at oppsettet brukte fast
// lagrekkefølge; «Sett opp på nytt fra tabellen» gjør den klar for myntkast.
function tieList(groups, frozen) {
  return groups.map((g) => tieView(g.key, g.teams, g.positions, g.decision, g.h2h, !!frozen && !g.decision));
}
// Kryptografisk trygt og uten skjevhet: forkaster tall over siste hele multiplum av n.
function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}
function drawOrder(teams) {
  const order = [...teams];
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Et resultat er «avgjort» når kampen er avsluttet, har mål, og ikke står uavgjort uten valgt vinner.
function decided(m) {
  if (!m || m.status !== "finished" || m.hs === null || m.aws === null) return null;
  if (m.hs !== m.aws) return m.hs > m.aws ? { winner: m.home, loser: m.away } : { winner: m.away, loser: m.home };
  if (m.winner) return { winner: m.winner, loser: m.winner === m.home ? m.away : m.home };
  return null;
}
function podium(matches) {
  const final = matches.find((m) => m.kind === "playoff" && m.ranks[1] === 1);
  const bronze = matches.find((m) => m.kind === "playoff" && m.ranks[1] === 3);
  const f = final && !final.provisional ? decided(final) : null;
  if (!f) return null;
  const b = bronze && !bronze.provisional ? decided(bronze) : null;
  return { first: f.winner, second: f.loser, third: b ? b.winner : null };
}
// Sluttplassering 1–10: bare når alle sluttspillkampene er avsluttet med en vinner. Vinneren av
// kampen om plass 1–2 blir nr. 1 og taperen nr. 2, osv. Ellers null.
// Vises så snart alt UNNTATT ev. finalen er avgjort (plass 3.-10.), ikke bare når absolutt alt
// er ferdig: 1. og 2. plass står som null (ukjent) til finalen er spilt, resten fylles ut med
// en gang bronsekampen og de tre plasseringskampene er ferdige.
function finalStandings(matches) {
  const out = new Array(CONFIG.teams.length).fill(null);
  for (const m of matches) {
    if (m.kind !== "playoff") continue;
    const top = Math.min(...m.ranks);
    const isFinal = top === 1;
    const d = m.provisional ? null : decided(m);
    if (!d) {
      if (isFinal) continue;
      return null;
    }
    if (out[top - 1] !== null || out[top] !== null) return null;
    out[top - 1] = d.winner;
    out[top] = d.loser;
  }
  return out.slice(2).every((n) => n !== null) ? out : null;
}

// -- straffekonkurranse (bare sluttspill) --------------------------------------
// Tre spark hver, hjemmelaget (best plassert i tabellen) sparker først i hver runde: H, B, H, B, H, B.
// Avgjort så snart det ene laget ikke lenger kan ta igjen det andre innenfor de tre rundene. Står det
// likt etter tre runder, blir det sudden death: én runde av gangen (hjemmelaget først), avgjort når
// begge har sparket og scoringene er ulike. kicks: [{side, made}] i rekkefølge. En ugyldig liste (feil
// tur, spark etter at det er avgjort, «made» som ikke er true/false) gir null. Samme algoritme i server.py.
const PEN_ROUNDS = 3;
function penaltyStatus(kicks) {
  if (!Array.isArray(kicks)) return null;
  let home = 0, away = 0, done = false;
  for (let i = 0; i < kicks.length; i++) {
    const k = kicks[i];
    const side = i % 2 === 0 ? "home" : "away";
    if (done || !k || typeof k !== "object" || k.side !== side || typeof k.made !== "boolean") return null;
    if (k.made) { if (side === "home") home++; else away++; }
    const homeTaken = Math.floor((i + 2) / 2), awayTaken = Math.floor((i + 1) / 2);
    if (homeTaken <= PEN_ROUNDS) done = home > away + (PEN_ROUNDS - awayTaken) || away > home + (PEN_ROUNDS - homeTaken);
    else done = homeTaken === awayTaken && home !== away;
  }
  return { home, away, decided: done, winner: done ? (home > away ? "home" : "away") : null, nextSide: done ? null : kicks.length % 2 === 0 ? "home" : "away" };
}
// Lagret i meta som «pens:<kamp-id>»: {"kicks":[{side,made,rid}],"undone":[rid…],"n":…}. «undone» husker
// trykk-id-ene til angrede spark, så et spark som sendes på nytt etter tidsavbrudd ikke kommer tilbake.
// Ugyldig eller ødelagt verdi gir null (behandles som ingen straffer).
const RID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function parsePens(raw) {
  if (raw === null || raw === undefined) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || !Array.isArray(v.kicks) || !penaltyStatus(v.kicks)) return null;
  if (!v.kicks.every((k) => typeof k.rid === "string" && RID_RE.test(k.rid))) return null;
  const undone = Array.isArray(v.undone) ? v.undone.filter((r) => typeof r === "string") : [];
  return { kicks: v.kicks.map((k) => ({ side: k.side, made: k.made, rid: k.rid })), undone };
}
function penaltyView(rec) {
  if (!rec || !rec.kicks.length) return null;
  const st = penaltyStatus(rec.kicks);
  return { home: st.home, away: st.away, decided: st.decided, winner: st.winner, nextSide: st.nextSide, kicks: rec.kicks.map((k) => ({ side: k.side, made: k.made })) };
}
const PEN_MSG = {
  league: "Straffekonkurranse brukes bare i sluttspillet.",
  notStarted: "Start kampen før straffekonkurransen.",
  finished: "Kampen er avsluttet. Åpne den igjen for å endre straffene.",
  notTied: "Kampen er ikke i straffesituasjon: stillingen er ikke uavgjort.",
  decided: "Straffekonkurransen er avgjort.",
  notDecided: "Straffekonkurransen er ikke avgjort ennå.",
  none: "Ingen straffer å angre.",
  changed: "Straffene ble endret samtidig. Sjekk stillingen og prøv igjen.",
  hasKicks: "Kampen har registrerte straffer. Angre straffene først.",
  wrongWinner: "Vinneren må være laget som vant straffekonkurransen.",
};
const genitive = (name) => (/[sxzSXZ]$/.test(name) ? name + "'" : name + "s");
// Hvorfor et spark (side) ikke kan registreres nå, eller null. m er kampen slik loadState viser den.
function kickProblem(m, kicks, side) {
  if (m.status !== "live") return m.status === "finished" ? PEN_MSG.finished : PEN_MSG.notStarted;
  if (m.hs !== m.aws) return PEN_MSG.notTied;
  const st = penaltyStatus(kicks);
  if (st.decided) return PEN_MSG.decided;
  if (side !== st.nextSide) return `Det er ${genitive(st.nextSide === "home" ? m.home : m.away)} tur.`;
  return null;
}
// Sant i SQL når kampens straffe-rad har minst ett spark (samme som parsePens(...).kicks.length > 0 for
// verdier denne koden skriver). CASE sikrer at json_array_length aldri ser ugyldig JSON.
const PENS_NONEMPTY = "EXISTS (SELECT 1 FROM meta WHERE key = ? AND (CASE WHEN json_valid(value) THEN json_array_length(value, '$.kicks') ELSE 0 END) > 0)";

// -- nominasjoner til priser -------------------------------------------------
// Priser dommerne kan nominere til. true betyr at spillernavn er påkrevd.
const AWARDS = { puskas: true, celebration: false, glove: true };

async function listNominations(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, match_id AS matchId, award, team, player, reason, author, created FROM nominations ORDER BY created DESC, id DESC"
  ).all();
  return results;
}

function checkNomination(data, m) {
  const { award, team } = data;
  const player = data.player ?? "";
  const reason = data.reason ?? "";
  if (!Object.hasOwn(AWARDS, award)) return "Velg en pris.";
  // Kampen er valgfri: nominasjoner kan legges til i etterkant fra «Nominert» uten å huske kampen.
  if (data.matchId !== null && data.matchId !== undefined) {
    if (!m || m.provisional) return "Ukjent kamp.";
    if (team !== m.home && team !== m.away) return "Velg et av lagene i kampen.";
  } else if (!CONFIG.teams.includes(team)) return "Velg et lag.";
  if (typeof player !== "string" || typeof reason !== "string") return "Ugyldig nominasjon.";
  if (AWARDS[award] && !player.trim()) return "Skriv navnet på spilleren.";
  if (player.trim().length > 60) return "Spillernavnet kan ha maks 60 tegn.";
  if (reason.trim().length < 3 || reason.trim().length > 600) return "Skriv en kort begrunnelse (3 til 600 tegn).";
  return null;
}

// «expect» ved Avslutt: stillingen appen viste, to hele tall 0–99 (samme grenser som /api/score).
function validExpect(e) {
  const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 99;
  return typeof e === "object" && e !== null && !Array.isArray(e) && ok(e.hs) && ok(e.aws);
}
const scoreChangedMsg = (hs, aws) => `Stillingen er endret til ${hs}–${aws} siden du åpnet vinduet. Sjekk resultatet og prøv igjen.`;

async function readMeta(env) {
  // Én spørring: revisjon, låst oppsett og myntkast-avgjørelsene («tie:Delta|Echo»). Intervallet
  // 'tie:' ≤ key < 'tie;' (';' kommer rett etter ':') bruker primærnøkkelen; LIKE ville lest hele
  // meta-tabellen, også måltrykk-radene («g:…»), ved hver avlesning.
  // Straffene («pens:31» … «pens:35») hentes i samme spørring, med eksakte nøkler (ingen LIKE).
  const { results } = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN ('rev','seeding',${PENS_KEYS}) OR (key >= 'tie:' AND key < 'tie;')`).all();
  const map = {}, ties = Object.create(null), tieRaw = Object.create(null), pens = Object.create(null), pensRaw = Object.create(null);
  for (const r of results) {
    if (r.key.startsWith("pens:")) {
      pensRaw[r.key.slice(5)] = r.value;
      pens[r.key.slice(5)] = parsePens(r.value);
    } else if (!r.key.startsWith("tie:")) map[r.key] = r.value;
    else {
      try {
        ties[r.key.slice(4)] = JSON.parse(r.value);
        tieRaw[r.key.slice(4)] = r.value;
      } catch { /* ødelagt verdi: behandles som ingen avgjørelse */ }
    }
  }
  return { rev: Number(map.rev || 0), seeding: map.seeding || null, ties, tieRaw, pens, pensRaw };
}
// Billig endringsnøkkel: revisjonsnummeret økes ved hver skriving. Klokka endrer ingenting
// lenger, så uendret nummer betyr at ingenting er nytt.
function stateKey(rev) {
  return String(rev);
}
// Sluttspillkamper kan bare få resultat mens oppsettet er låst. Id-ene er tall fra kampoppsettet.
const PLAYOFF_IDS = CONFIG.matches.filter((m) => m.kind === "playoff").map((m) => Number(m.id)).join(",");
const PENS_KEYS = CONFIG.matches.filter((m) => m.kind === "playoff").map((m) => `'pens:${Number(m.id)}'`).join(",");
const SEEDED_OR_LEAGUE = `(id NOT IN (${PLAYOFF_IDS}) OR EXISTS (SELECT 1 FROM meta WHERE key='seeding'))`;
// Sant i SQL så lenge minst én seriekamp ikke er avsluttet med resultat (samme som leagueFinished).
const LEAGUE_IDS = CONFIG.matches.filter((m) => m.kind === "league").map((m) => Number(m.id)).join(",");
const LEAGUE_OPEN = `EXISTS (SELECT 1 FROM scores WHERE id IN (${LEAGUE_IDS}) AND NOT (status='finished' AND hs IS NOT NULL AND aws IS NOT NULL))`;
const BUMP_REV = "INSERT INTO meta(key,value) VALUES('rev','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1";
// Som BUMP_REV, men bare når nøkkelen har akkurat verdien denne forespørselen skrev (myntkast).
const BUMP_REV_IF = "INSERT INTO meta(key,value) SELECT 'rev','1' WHERE EXISTS (SELECT 1 FROM meta WHERE key=? AND value=?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1";
async function loadState(env, now, meta) {
  meta = meta || (await readMeta(env));
  let { results } = await env.DB.prepare("SELECT * FROM scores").all();
  // Mangler rader (seed.sql ble ikke kjørt, eller en kamp er lagt til i kampoppsettet),
  // lages de her. Ellers ville Start, mål og lagring feile med misvisende meldinger.
  if (results.length < CONFIG.matches.length) {
    await env.DB.prepare(`INSERT OR IGNORE INTO scores(id) VALUES ${CONFIG.matches.map(() => "(?)").join(",")}`).bind(...CONFIG.matches.map((m) => m.id)).run();
    ({ results } = await env.DB.prepare("SELECT * FROM scores").all());
  }
  const scores = new Map(results.map((r) => [r.id, r]));
  const matches = CONFIG.matches.map((base) => {
    const m = { ...base, ...scores.get(base.id) };
    m.status = effective(m);
    m.duration = duration(m);
    return m;
  });
  const leagueDone = leagueFinished(matches);
  // Myntkast teller bare når hele serien er ferdig. Før det: fast rekkefølge, ingen liste.
  const { table, groups } = standings(matches, leagueDone ? meta.ties : null);
  let frozen = meta.seeding ? { value: meta.seeding } : null;
  // Ikke godkjent myntkast som avgjør et sluttspillpar: oppsettet fryses ikke ennå.
  const tiePending = leagueDone && !frozen && groups.some((g) => !g.decision || g.decision.status !== "approved");
  if (!frozen && leagueDone && !tiePending) {
    const seed = table.map((r) => r.name);
    // OR IGNORE: flere forespørsler kan komme hit samtidig. Den som taper,
    // leser bare oppsettet som faktisk ble lagret først.
    await env.DB.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('seeding',?)").bind(JSON.stringify(seed)).run();
    frozen = await env.DB.prepare("SELECT value FROM meta WHERE key='seeding'").first();
  }
  const seed = frozen ? JSON.parse(frozen.value) : table.map((r) => r.name);
  for (const m of matches) {
    // Hjemmelaget i sluttspillet er laget som er best plassert i tabellen (ranks[1] er den beste plassen).
    if (m.kind === "playoff") {
      m.home = seed[m.ranks[1] - 1];
      m.away = seed[m.ranks[0] - 1];
      m.provisional = !frozen;
      if (m.provisional) m.status = "upcoming";
    }
    // Straffekonkurransen for sluttspillkamper (null uten spark); alltid null for seriekamper.
    m.penalties = m.kind === "playoff" ? penaltyView(meta.pens[m.id]) : null;
  }
  const ties = leagueDone ? tieList(groups, !!frozen) : [];
  const { matches: _drop, ...config } = CONFIG;
  return { config, matches, table, seeded: !!frozen, ties, tiePending, podium: podium(matches), finalStandings: finalStandings(matches), key: stateKey(meta.rev), serverTime: now.toISOString() };
}

// -- request handling -------------------------------------------------------

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

// Forsiden og inngangssiden velges ut fra tid og økt, så svaret må aldri mellomlagres,
// og det skal ha de samme sikkerhetshodene som API-et. Content-Type beholdes fra filen.
function withPageHeaders(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Tilgangen gjelder bare fasen den ble gitt i: passordet fra før 7. oktober åpner ikke bibelfasen.
async function allowed(env, request, now) {
  const phase = gatePhase(now);
  if (!phase) return true;
  const s = await readSession(env, request);
  return !!(s && (s.admin || s.passed === phase));
}

// Per-isolate in-memory limiter for the public /api/state endpoint. It only
// catches ONE runaway client in a tight loop; it must never punish real users.
// Many spectators (and the referees) can share ONE public IP at the venue
// (stadium Wi-Fi, carrier-grade NAT), and each phone polls about once a minute
// plus manual refreshes, so 300 phones behind one IP is ~300 requests/minute.
// The limit is therefore high (600/min per IP per isolate) and matches
// STATE_LIMIT_PER_MIN in server.py. Stronger protection belongs in a Cloudflare
// WAF rate-limiting rule (see README), not here. A D1-backed limiter would add a
// write to every poll.
const STATE_LIMIT_PER_MIN = 600;
const stateHits = new Map();
function stateRateLimited(ip) {
  const cutoff = Date.now() - 60000;
  const hits = (stateHits.get(ip) || []).filter((t) => t > cutoff);
  hits.push(Date.now());
  stateHits.set(ip, hits);
  if (stateHits.size > 5000) stateHits.clear();
  return hits.length > STATE_LIMIT_PER_MIN;
}

// Mislykkede innlogginger per IP per 5 minutter. Dommerne deler ofte én IP på stadion-Wi-Fi og
// skriver et langt passord på mobilen, så grensen er 15 (samme som server.py). Forsøk nr. 16 gir 429.
const LOGIN_FAILS_PER_5_MIN = 15;
async function checkRateLimit(env, ip) {
  const cutoff = Math.floor(Date.now() / 1000) - 300;
  await env.DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(cutoff).run();
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM attempts WHERE ip = ?").bind(ip).first();
  return count < LOGIN_FAILS_PER_5_MIN;
}

// Bare mislykkede forsøk teller: vellykkede innlogginger skal aldri låse ute andre arrangører bak samme nett.
async function recordFailedAttempt(env, ip) {
  await env.DB.prepare("INSERT INTO attempts(ip, ts) VALUES(?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
}

async function verifyPassword(password, salt, expectedHash, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(salt), iterations: Number(iterations) || PBKDF2_LEGACY_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return timingSafeEqual(hex(new Uint8Array(bits)), expectedHash);
}

// ADMIN_USERS er en JSON-liste [{username, salt, hash}, ...]. De gamle enkeltverdiene (ADMIN_USERNAME/SALT/HASH) virker fortsatt.
function adminUsers(env) {
  if (env.ADMIN_USERS) {
    try {
      const list = JSON.parse(env.ADMIN_USERS);
      const valid = (u) => u && typeof u.username === "string" && /^([0-9a-f]{2})+$/i.test(u.salt || "") && /^[0-9a-f]{64}$/i.test(u.hash || "");
      const ok = Array.isArray(list) ? list.filter(valid) : [];
      if (ok.length) return ok;
    } catch (e) { /* faller tilbake */ }
  }
  if (env.ADMIN_SALT && env.ADMIN_HASH) return [{ username: env.ADMIN_USERNAME || "", salt: env.ADMIN_SALT, hash: env.ADMIN_HASH }];
  throw new ConfigError("ADMIN_USERS mangler eller er ugyldig. Kjør setup_admin_cloudflare.py og wrangler secret put (se README).");
}

function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function api(request, env, path, now) {
  if (!checkOrigin(request) && request.method === "POST") {
    return json({ error: "Ugyldig forespørselskilde." }, 403);
  }

  if (path === "/api/state" && request.method === "GET") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (stateRateLimited(ip)) return json({ error: "For mange forespørsler. Vent litt." }, 429);
    if (!(await allowed(env, request, now))) return json({ error: "Svar på inngangsspørsmålet for å se turneringen." }, 401);
    // «Uendret»-svaret (det aller vanligste) leser bare revisjonsraden: én rad per poll.
    const since = new URL(request.url).searchParams.get("since");
    if (since) {
      const row = await env.DB.prepare("SELECT value FROM meta WHERE key='rev'").first();
      const key = stateKey(Number(row?.value || 0));
      if (since === key) return json({ same: true, key, serverTime: now.toISOString() });
    }
    return json(await loadState(env, now));
  }

  if (path === "/api/session" && request.method === "GET") {
    const s = await readSession(env, request);
    return json({
      admin: !!(s && s.admin),
      user: s && s.admin ? s.user || null : null,
      csrf: s ? s.csrf : null,
      gateRequired: gateActive(now),
      tournamentDay: osloNow(now).slice(0, 10) === CONFIG.date,
      local: isLocalHost(new URL(request.url)),
    });
  }

  if (path === "/api/gate" && request.method === "GET") {
    const s = await readSession(env, request);
    const phase = gatePhase(now);
    if (!phase || (s && (s.admin || s.passed === phase))) return json({ required: false });
    if (phase === "password") return json({ required: true, mode: "password", question: "Passord" });
    if (s && Number.isInteger(s.q)) return json({ required: true, mode: "bible", question: GATE_QUESTIONS[s.q][0] });
    const session = { ...(s || {}), csrf: s?.csrf || crypto.randomUUID(), exp: Date.now() / 1000 + 86400, q: Math.floor(Math.random() * GATE_QUESTIONS.length) };
    const token = await signSession(env, session);
    return json({ required: true, mode: "bible", question: GATE_QUESTIONS[session.q][0] }, 200, { "Set-Cookie": cookieHeader(token, 86400) });
  }

  if (path === "/api/gate" && request.method === "POST") {
    const s = await readSession(env, request);
    const phase = gatePhase(now);
    if (!phase || (s && s.admin)) return json({ ok: true });
    const data = await readJsonBody(request);
    if (data === null || typeof data.answer !== "string") return json({ error: "Ugyldig svar." }, 400);
    if (phase === "password") {
      if (normalize(data.answer) !== ENTRY_PASSWORD) return json({ error: "Feil passord. Prøv igjen." }, 401);
      const session = { ...(s || {}), csrf: s?.csrf || crypto.randomUUID(), exp: Date.now() / 1000 + 86400, passed: "password" };
      const token = await signSession(env, session);
      return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(token, 86400) });
    }
    if (!s || !Number.isInteger(s.q)) return json({ error: "Last siden på nytt og prøv igjen." }, 401);
    if (!GATE_QUESTIONS[s.q][1].includes(normalize(data.answer))) {
      return json({ error: "Ikke helt. Se i bibelteksten og prøv igjen." }, 401);
    }
    s.passed = "bible";
    const token = await signSession(env, s);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(token, 86400) });
  }

  if (path === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await checkRateLimit(env, ip))) return json({ error: "For mange forsøk. Vent fem minutter." }, 429);
    const data = await readJsonBody(request);
    if (data === null || typeof data.username !== "string" || typeof data.password !== "string") return json({ error: "Ugyldig innlogging." }, 400);
    // Both checks always run (no `||` short-circuit) so response time doesn't
    // reveal whether the username or the password was the wrong one.
    const users = adminUsers(env);
    const uname = data.username.trim().toLowerCase();
    const match = users.find(u => String(u.username).toLowerCase() === uname);
    // A fixed decoy, not users[0]: if the first real user happened to lack an
    // `iter` field (a legacy account), every mistyped-username login would run
    // PBKDF2 at 600 000 rounds (~250ms), blowing the 10ms/request CPU budget.
    const cfg = match || { salt: "00".repeat(16), hash: "", iter: PBKDF2_DEFAULT_ITERATIONS };
    const passOk = await verifyPassword(data.password, cfg.salt, cfg.hash, cfg.iter);
    if (!match || !passOk) {
      await recordFailedAttempt(env, ip);
      return json({ error: "Feil brukernavn eller passord." }, 401);
    }
    const session = { csrf: crypto.randomUUID(), exp: Date.now() / 1000 + 28800, admin: true, public: true, user: cfg.username };
    const token = await signSession(env, session);
    return json({ admin: true, user: cfg.username, csrf: session.csrf }, 200, { "Set-Cookie": cookieHeader(token, 28800) });
  }

  // Regneark med alle kamper for admin (backup etter hver runde). Bare lesing, så den kan
  // ikke påvirke registreringen. Vanlig lenke uten CSRF-hode; cookien er SameSite=Strict.
  if (path === "/api/export.csv" && request.method === "GET") {
    const s = await readSession(env, request);
    if (!s || !s.admin) return json({ error: "Logg inn som admin for å laste ned resultatene." }, 401);
    const st = await loadState(env, now);
    const status = { upcoming: "Ikke startet", live: "Pågår", finished: "Avsluttet" };
    // Tekst som begynner med = + - @ kan tolkes som formel i Excel: få en ' foran. Tall røres ikke (MF kan være -3).
    const cell = (v) => { let t = String(v ?? ""); if (typeof v === "string" && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = [["Runde", "Kamp", "Type", "Start", "Slutt", "Bane", "Hjemme", "Borte", "Mål hjemme", "Mål borte", "Status", "Vinner", "Vunnet på straffer", "Straffer", "Sist endret av", "Sist endret"]];
    for (const m of st.matches) {
      const d = decided(m);
      // «Straffer»: scoringer i straffekonkurransen, hjemme–borte (tankestrek, så Excel ikke gjør det om til en dato).
      rows.push([m.kind === "playoff" ? "Sluttspill" : m.round, m.id, m.kind === "playoff" ? `Plass ${m.ranks[1]}–${m.ranks[0]}` : "Serie", m.start, m.end, m.pitch,
        m.home, m.away, m.hs, m.aws, status[m.status], d ? d.winner : "", d && m.hs === m.aws ? "Ja" : "", m.penalties ? `${m.penalties.home}–${m.penalties.away}` : "", m.updated_by, m.updated_at ? m.updated_at.replace("T", " ") : ""]);
    }
    rows.push([]);
    rows.push(["Plass", "Lag", "Kamper", "Seier", "Uavgjort", "Tap", "Mål for", "Mål mot", "Målforskjell", "Poeng"]);
    st.table.forEach((r, i) => rows.push([i + 1, r.name, r.p, r.w, r.d, r.l, r.gf, r.ga, r.gd, r.pts]));
    // Semikolon og BOM: da åpner norsk Excel filen riktig, med æøå, uten importveiviser.
    const csv = "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
    const stamp = osloNow(now).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="konfaction-resultater-${stamp}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }

  // Everything below requires an admin session with a matching CSRF token.
  const s = await readSession(env, request);
  if (!s || !s.admin) return json({ error: "Logg inn for å endre resultater." }, 401);
  if (!timingSafeEqual(request.headers.get("X-CSRF-Token") || "", s.csrf)) return json({ error: "Ugyldig økt. Last siden på nytt." }, 403);

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  // Nominasjoner: bare for admin-er (sjekket over). Publikum ser dem aldri.
  if (path === "/api/nominations" && request.method === "GET") {
    return json({ nominations: await listNominations(env) });
  }

  if (path === "/api/nominate" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null) return json({ error: "Ugyldig forespørsel." }, 400);
    const current = await loadState(env, now);
    const m = data.matchId == null ? null : current.matches.find((x) => x.id === data.matchId);
    const problem = checkNomination(data, m);
    if (problem) return json({ error: problem }, 400);
    await env.DB.prepare("INSERT INTO nominations(match_id, award, team, player, reason, author, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(m ? m.id : 0, data.award, data.team, AWARDS[data.award] ? (data.player ?? "").trim() : "", data.reason.trim(), s.user || "admin", Math.floor(Date.now() / 1000))
      .run();
    return json({ nominations: await listNominations(env) });
  }

  if (path === "/api/nomination/delete" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !Number.isInteger(data.id)) return json({ error: "Ugyldig forespørsel." }, 400);
    const result = await env.DB.prepare("DELETE FROM nominations WHERE id = ? AND author = ?").bind(data.id, s.user || "admin").run();
    if (result.meta.changes !== 1) return json({ error: "Du kan bare slette dine egne nominasjoner." }, 403);
    return json({ nominations: await listNominations(env) });
  }

  if (path === "/api/score" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null) return json({ error: "Ugyldig forespørsel." }, 400);
    const meta = await readMeta(env);
    const current = await loadState(env, now, meta);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.provisional) return json({ error: "Sluttspillet er ikke klart. Fullfør alle seriekampene først." }, 409);
    const { hs, aws, mode } = data;
    let { winner } = data;
    const validScore = (v) => v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v <= 99);
    if (!validScore(hs) || !validScore(aws) || !["upcoming", "live", "finished"].includes(mode)) {
      return json({ error: "Bruk hele mål mellom 0 og 99 og en gyldig status." }, 400);
    }
    if (mode !== "upcoming" && (hs == null || aws == null)) return json({ error: "Fyll inn mål for begge lagene." }, 400);
    // Registrerte straffer: stillingen må fortsatt være uavgjort, og vinneren ved «Avsluttet» er den
    // straffekonkurransen ga (et annet lag fra klienten avvises). Uten straffer virker skjemaet som før.
    const pensRaw = m.kind === "playoff" ? meta.pensRaw[m.id] ?? null : null;
    const pens = m.kind === "playoff" ? meta.pens[m.id] : null;
    if (pens && pens.kicks.length) {
      if (mode === "upcoming" || hs !== aws) return json({ error: PEN_MSG.hasKicks }, 409);
      if (mode === "finished") {
        const st = penaltyStatus(pens.kicks);
        if (!st.decided) return json({ error: PEN_MSG.notDecided }, 409);
        const derived = st.winner === "home" ? m.home : m.away;
        if (winner !== null && winner !== undefined && winner !== "" && winner !== derived) return json({ error: PEN_MSG.wrongWinner }, 400);
        winner = derived;
      }
    }
    if (mode === "finished" && m.kind === "playoff" && hs === aws && ![m.home, m.away].includes(winner)) {
      return json({ error: "Uavgjort i sluttspill: velg hvem som vant på straffer." }, 400);
    }
    if (winner !== null && winner !== undefined && (![m.home, m.away].includes(winner) || m.kind !== "playoff" || hs == null || hs !== aws)) {
      return json({ error: "Vinner ved uavgjort må være et av lagene i kampen." }, 400);
    }
    // The write and the rev bump MUST be one atomic batch: if the bump were a separate call,
    // a failure between the two would leave `rev` unchanged and every `?since=` poll would
    // answer «uendret» for a change that really happened. (A rejected write bumping rev costs
    // one extra refresh for viewers, which is harmless.)
    const [result] = await env.DB.batch([
      // «Ikke startet» nullstiller kampen. «Pågår» uten starttid får starttid nå.
      env.DB.prepare(`UPDATE scores SET hs=?, aws=?, status=?, winner=?,
        started_at = CASE WHEN ?='upcoming' THEN NULL WHEN ?='live' AND started_at IS NULL THEN ? ELSE started_at END,
        version=version+1, updated_by=?, updated_at=? WHERE id=? AND version=? AND ${SEEDED_OR_LEAGUE}
        AND (SELECT value FROM meta WHERE key = ?) IS ?`)
        .bind(mode === "upcoming" ? null : hs, mode === "upcoming" ? null : aws, mode, mode === "upcoming" ? null : winner ?? null,
          mode, mode, Math.floor(now.getTime() / 1000), s.user || null, osloNow(now), m.id, data.version ?? null, "pens:" + m.id, pensRaw),
      env.DB.prepare(BUMP_REV),
    ]);
    if (result.meta.changes !== 1) return json({ error: "En annen administrator endret kampen. Last inn siste resultat før du lagrer." }, 409);
    return json(await loadState(env, now));
  }

  // Dommermodus: ett trykk = ett mål. Atomisk økning i databasen, så flere dommere
  // og admins kan trykke samtidig uten versjonskonflikt og uten at mål forsvinner.
  if (path === "/api/goal" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["home", "away"].includes(data.side) || ![1, -1].includes(data.delta)) return json({ error: "Ugyldig forespørsel." }, 400);
    const current = await loadState(env, now);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.provisional) return json({ error: "Lås sluttspilloppsettet før du registrerer mål." }, 409);
    const col = data.side === "home" ? "hs" : "aws";
    // Valgfri trykk-id fra appen. Kommer samme trykk to ganger (appen prøver igjen etter
    // tidsavbrudd eller et svar som ble borte på veien), telles det bare én gang.
    const rid = data.rid === undefined ? null : data.rid;
    if (rid !== null && (typeof rid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(rid))) return json({ error: "Ugyldig forespørsel." }, 400);
    const unix = Math.floor(now.getTime() / 1000);
    // Mål teller bare mens kampen pågår. Sjekken ligger i selve UPDATE-en, så et mål som
    // kommer rett etter at en annen trykket Avslutt, blir avvist i stedet for å snike seg inn.
    // Hele batchen er én transaksjon: mål, trykk-id og revisjonsnummer lagres sammen eller ikke i det hele tatt.
    const stmts = [
      env.DB.prepare(`UPDATE scores SET ${col} = MIN(99, MAX(0, COALESCE(${col},0) + ?)),
        version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'live'
        AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?) AND NOT ${PENS_NONEMPTY}`)
        .bind(data.delta, s.user || null, osloNow(now), m.id, rid === null ? null : "g:" + rid, "pens:" + m.id),
      env.DB.prepare(BUMP_REV),
    ];
    if (rid !== null) {
      stmts.push(
        // Samme vilkår som UPDATE-en over (også straffene), så en avvist trykk-id aldri lagres som «telt».
        env.DB.prepare(`INSERT OR IGNORE INTO meta(key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM scores WHERE id = ? AND status = 'live') AND NOT ${PENS_NONEMPTY}`).bind("g:" + rid, String(unix), m.id, "pens:" + m.id),
        env.DB.prepare("DELETE FROM meta WHERE key LIKE 'g:%' AND CAST(value AS INTEGER) < ?").bind(unix - 3600),
      );
    }
    const [result] = await env.DB.batch(stmts);
    if (result.meta.changes !== 1) {
      // Samme trykk er allerede lagret: svar som om det gikk bra, uten å telle det på nytt.
      if (rid !== null && (await env.DB.prepare("SELECT 1 AS hit FROM meta WHERE key = ?").bind("g:" + rid).first())) return json(await loadState(env, now));
      // Mens straffekonkurransen pågår (minst ett spark) står stillingen fast.
      const row = await env.DB.prepare("SELECT status, (SELECT value FROM meta WHERE key = ?) AS pens FROM scores WHERE id = ?").bind("pens:" + m.id, m.id).first();
      const status = row ? effective(row) : null, pens = parsePens(row ? row.pens : null);
      if (status === "live" && pens && pens.kicks.length) return json({ error: PEN_MSG.hasKicks }, 409);
      return json({ error: status === "finished" ? "Kampen er avsluttet. Åpne den igjen for å endre resultatet." : "Start kampen før du fører mål." }, 409);
    }
    return json(await loadState(env, now));
  }

  // Start, avslutt, åpne igjen og angre start. Hver handling er én betinget UPDATE,
  // så to dommere som trykker samtidig ikke kan ødelegge for hverandre.
  if (path === "/api/match" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["start", "finish", "reopen", "unstart"].includes(data.action)) return json({ error: "Ugyldig forespørsel." }, 400);
    const meta = await readMeta(env);
    const current = await loadState(env, now, meta);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.provisional) return json({ error: "Lås sluttspilloppsettet før kampen startes." }, 409);
    const stamp = [s.user || null, osloNow(now), m.id];
    const unix = Math.floor(now.getTime() / 1000);
    const expect = data.action === "finish" && data.expect !== undefined ? data.expect : null;
    let stmt, problem, draw = false, pensRaw = null;
    if (data.action === "start") {
      stmt = env.DB.prepare(`UPDATE scores SET status='live', hs=COALESCE(hs,0), aws=COALESCE(aws,0), started_at=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status NOT IN ('live','finished') AND ${SEEDED_OR_LEAGUE}`).bind(unix, ...stamp);
      problem = m.status === "finished" ? "Kampen er allerede avsluttet." : null;
    } else if (data.action === "finish") {
      // Valgfri «expect» {hs, aws}: stillingen dommeren så da Avslutt-vinduet ble åpnet. Er den en
      // annen enn den lagrede, avsluttes ingenting (to telefoner på samme kamp). Uten «expect»
      // (eldre app) virker Avslutt som før. UPDATE-en under krever fortsatt nøyaktig stillingen
      // serveren leste (som da er lik «expect»), så et mål som kommer imellom stopper den også.
      if (expect !== null && !validExpect(expect)) return json({ error: "Ugyldig forespørsel." }, 400);
      if (expect !== null && m.status === "live" && (m.hs !== expect.hs || m.aws !== expect.aws)) return json({ error: scoreChangedMsg(m.hs, m.aws) }, 409);
      // Uavgjort i sluttspill: vinneren er den straffekonkurransen ga (lagret på serveren), aldri det
      // klienten sender. Ikke avgjort ennå: ingenting avsluttes. Sender klienten et annet lag, avvises det.
      // Stillingen hentes fra databasen, ikke fra klienten.
      draw = m.kind === "playoff" && m.status === "live" && m.hs === m.aws;
      let winner = null;
      if (draw) {
        const rec = meta.pens[m.id];
        const st = rec ? penaltyStatus(rec.kicks) : null;
        if (!st || !st.decided) return json({ error: PEN_MSG.notDecided }, 409);
        winner = st.winner === "home" ? m.home : m.away;
        if (data.winner !== null && data.winner !== undefined && data.winner !== "" && data.winner !== winner) return json({ error: PEN_MSG.wrongWinner }, 400);
        pensRaw = meta.pensRaw[m.id] ?? null;
      }
      // Ved uavgjort krever UPDATE-en også at straffene er nøyaktig de vi leste (et angret spark imellom stopper den).
      stmt = draw
        ? env.DB.prepare("UPDATE scores SET status='finished', winner=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='live' AND hs IS ? AND aws IS ? AND (SELECT value FROM meta WHERE key = ?) IS ?").bind(winner, ...stamp, m.hs, m.aws, "pens:" + m.id, pensRaw)
        : env.DB.prepare("UPDATE scores SET status='finished', winner=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='live' AND hs IS ? AND aws IS ?").bind(winner, ...stamp, m.hs, m.aws);
      problem = m.status !== "live" ? (m.status === "finished" ? "Kampen er allerede avsluttet." : "Kampen er ikke startet.") : "Stillingen ble endret samtidig. Sjekk resultatet og prøv igjen.";
    } else if (data.action === "reopen") {
      stmt = env.DB.prepare("UPDATE scores SET status='live', winner=NULL, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='finished'").bind(...stamp);
      problem = "Kampen er ikke avsluttet.";
    } else {
      // Angre start: bare mens stillingen er 0–0, så ingen mål kan forsvinne, og ikke med registrerte straffer.
      stmt = env.DB.prepare(`UPDATE scores SET status='upcoming', hs=NULL, aws=NULL, winner=NULL, started_at=NULL, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='live' AND hs=0 AND aws=0 AND NOT ${PENS_NONEMPTY}`).bind(...stamp, "pens:" + m.id);
      problem = "Start kan bare angres mens stillingen er 0–0.";
    }
    const [result] = await env.DB.batch([stmt, env.DB.prepare(BUMP_REV)]);
    if (result.meta.changes !== 1) {
      // Meldingen bygger på stillingen etter konflikten, ikke den vi leste før: to dommere som
      // trykker Avslutt samtidig skal få «allerede avsluttet», ikke «stillingen ble endret».
      const row = await env.DB.prepare("SELECT status, hs, aws, (SELECT value FROM meta WHERE key = ?) AS pens FROM scores WHERE id = ?").bind("pens:" + m.id, m.id).first();
      const status = row ? effective(row) : null;
      const rowPens = parsePens(row ? row.pens : null);
      // Et mål kom mellom lesingen og skrivingen: vis den nye stillingen når appen sendte «expect».
      if (status === "live" && expect !== null && (row.hs !== expect.hs || row.aws !== expect.aws)) return json({ error: scoreChangedMsg(row.hs, row.aws) }, 409);
      if (status === "live" && data.action === "finish" && draw && row.hs === m.hs && row.aws === m.aws && (row.pens ?? null) !== pensRaw) problem = PEN_MSG.changed;
      else if (status === "live" && data.action === "unstart" && rowPens && rowPens.kicks.length) problem = PEN_MSG.hasKicks;
      else if (status === "finished" && data.action !== "reopen") problem = "Kampen er allerede avsluttet.";
      else if (status === "live" && data.action === "start") problem = "Kampen er allerede i gang.";
      else if (status === "upcoming" && data.action === "finish") problem = "Kampen er ikke startet.";
      else if (status === "live" && data.action === "finish") problem = "Stillingen ble endret samtidig. Sjekk resultatet og prøv igjen.";
      else if (status === "live" && data.action === "reopen") problem = "Kampen er allerede åpnet igjen.";
      else if (status === "upcoming" && data.action === "unstart") problem = "Kampen står allerede som «Ikke startet».";
      else if (status === "upcoming" && data.action === "start") problem = "Lås sluttspilloppsettet før kampen startes.";
      return json({ error: problem || "Kampen er allerede i gang." }, 409);
    }
    return json(await loadState(env, now));
  }

  // Lås sluttspilloppsettet manuelt (f.eks. når klokka ligger etter) eller lås det opp igjen.
  if (path === "/api/seeding" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["lock", "unlock"].includes(data.action)) return json({ error: "Ugyldig forespørsel." }, 400);
    const current = await loadState(env, now);
    // Sjekken på sluttspillresultater ligger i selve SQL-en: en dommer kan starte en
    // sluttspillkamp mellom lesingen over og skrivingen her.
    const noPlayoffResults = `NOT EXISTS (SELECT 1 FROM scores WHERE id IN (${PLAYOFF_IDS}) AND (hs IS NOT NULL OR aws IS NOT NULL))`;
    const busy = json({ error: "Sluttspillet har allerede resultater. Fjern dem før du låser opp oppsettet." }, 409);
    if (data.action === "lock") {
      // Ikke lås over helt like lag uten godkjent myntkast (heller ikke på nytt etter en rettelse).
      const undecided = (st) => st.ties.some((t) => t.status !== "approved");
      if (undecided(current)) return json({ error: TIE_MSG.pending }, 409);
      const seed = JSON.stringify(current.table.map((r) => r.name));
      // Sjekken over bygger på en lesing. Blir siste seriekamp avsluttet (eller rettet) mellom den
      // lesingen og skrivingen, kan en ny likhet ha oppstått. Skrivingen krever derfor at seriespillet
      // fortsatt ikke er ferdig, eller at ingen seriekamp er endret siden lesingen (version øker ved hver
      // endring, så summen er uendret bare hvis ingenting er skrevet).
      const versions = current.matches.reduce((sum, m) => sum + (m.kind === "league" ? Number(m.version) || 0 : 0), 0);
      const [result] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO meta(key,value) SELECT 'seeding', ? WHERE (${LEAGUE_OPEN} OR (SELECT COALESCE(SUM(version),0) FROM scores WHERE id IN (${LEAGUE_IDS})) = ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE ${noPlayoffResults}`).bind(seed, versions),
        env.DB.prepare(BUMP_REV),
      ]);
      if (result.meta.changes !== 1) {
        const after = await loadState(env, now);
        if (undecided(after)) return json({ error: TIE_MSG.pending }, 409);
        if (after.matches.some((x) => x.kind === "playoff" && (x.hs !== null || x.aws !== null))) return busy;
        return json({ error: "Noe ble endret samtidig. Prøv igjen." }, 409);
      }
    } else {
      const started = current.matches.some((x) => x.kind === "playoff" && (x.hs !== null || x.aws !== null));
      if (started) return busy;
      const [result] = await env.DB.batch([env.DB.prepare(`DELETE FROM meta WHERE key='seeding' AND ${noPlayoffResults}`), env.DB.prepare(BUMP_REV)]);
      if (result.meta.changes !== 1 && current.seeded) return busy;
    }
    return json(await loadState(env, now));
  }

  // Straffekonkurranse i sluttspillet: «kick» registrerer ett spark (scoring eller bom), «undo» fjerner
  // det siste. Sparkene ligger i meta («pens:<id>») og skrives med sammenlign-og-bytt mot nøyaktig den
  // verdien vi leste, i samme transaksjon som revisjonsnummeret. To som trykker samtidig gir derfor aldri
  // to spark på samme tur eller et spark etter at det er avgjort. Trykk-id (rid) gjør et spark som sendes
  // på nytt etter tidsavbrudd til en ufarlig gjentakelse (200 med tilstanden, ingenting telles på nytt).
  if (path === "/api/penalty" && request.method === "POST") {
    const data = await readJsonBody(request);
    const bad = json({ error: "Ugyldig forespørsel." }, 400);
    if (data === null || !["kick", "undo"].includes(data.action)) return bad;
    if (data.action === "kick" && (!["home", "away"].includes(data.side) || typeof data.made !== "boolean" || typeof data.rid !== "string" || !RID_RE.test(data.rid))) return bad;
    // Valgfri «count» ved angre: antall spark appen viste. Stemmer det ikke, angres ingenting (et angre-trykk
    // som sendes på nytt etter tidsavbrudd skal ikke fjerne to spark).
    const count = data.action === "undo" && data.count !== undefined && data.count !== null ? data.count : null;
    if (count !== null && (!Number.isInteger(count) || count < 0 || count > 999)) return bad;
    const meta = await readMeta(env);
    const current = await loadState(env, now, meta);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.kind !== "playoff") return json({ error: PEN_MSG.league }, 409);
    const key = "pens:" + m.id, raw = meta.pensRaw[m.id] ?? null;
    const rec = meta.pens[m.id] || { kicks: [], undone: [] };
    const seen = (r) => !!r && (r.kicks.some((k) => k.rid === data.rid) || r.undone.includes(data.rid));
    let next;
    if (data.action === "kick") {
      if (seen(rec)) return json(current);
      const problem = kickProblem(m, rec.kicks, data.side);
      if (problem) return json({ error: problem }, 409);
      next = { kicks: [...rec.kicks, { side: data.side, made: data.made, rid: data.rid }], undone: rec.undone };
    } else {
      if (m.status !== "live") return json({ error: m.status === "finished" ? PEN_MSG.finished : PEN_MSG.notStarted }, 409);
      if (!rec.kicks.length) return json({ error: PEN_MSG.none }, 409);
      if (count !== null && count !== rec.kicks.length) return json({ error: PEN_MSG.changed }, 409);
      next = { kicks: rec.kicks.slice(0, -1), undone: [...rec.undone, rec.kicks[rec.kicks.length - 1].rid].slice(-50) };
    }
    // Tilfeldig «n»: hver skrevet verdi er unik, så BUMP_REV_IF øker revisjonen bare når nettopp denne ble lagret.
    const value = JSON.stringify({ ...next, n: hex(crypto.getRandomValues(new Uint8Array(6))) });
    // Kampen må fortsatt pågå med uavgjort stilling i det øyeblikket vi skriver (et Avslutt eller mål imellom stopper det).
    const liveTied = `EXISTS (SELECT 1 FROM scores WHERE id = ? AND status = 'live' AND hs = aws AND EXISTS (SELECT 1 FROM meta WHERE key = 'seeding'))`;
    const stmt = raw === null
      ? env.DB.prepare(`INSERT OR IGNORE INTO meta(key, value) SELECT ?, ? WHERE ${liveTied}`).bind(key, value, m.id)
      : env.DB.prepare(`UPDATE meta SET value = ? WHERE key = ? AND value = ? AND ${liveTied}`).bind(value, key, raw, m.id);
    const [result] = await env.DB.batch([stmt, env.DB.prepare(BUMP_REV_IF).bind(key, value)]);
    if (result.meta.changes === 1) return json(await loadState(env, now));
    // Noen andre endret kampen eller straffene imellom: svar ut fra slik det er nå.
    const meta2 = await readMeta(env);
    const after = await loadState(env, now, meta2);
    const m2 = after.matches.find((x) => x.id === m.id);
    const rec2 = meta2.pens[m.id] || { kicks: [], undone: [] };
    if (data.action === "kick") {
      if (seen(rec2)) return json(after);
      return json({ error: kickProblem(m2, rec2.kicks, data.side) || PEN_MSG.changed }, 409);
    }
    if (m2.status !== "live") return json({ error: m2.status === "finished" ? PEN_MSG.finished : PEN_MSG.notStarted }, 409);
    return json({ error: rec2.kicks.length ? PEN_MSG.changed : PEN_MSG.none }, 409);
  }

  // Myntkast for helt like lag før sluttspillet: kast (forslag) → godkjenn, eller nødutgang
  // (fast rekkefølge) så lenge ingen har kastet. Utfallet trekkes her, aldri hos klienten.
  if (path === "/api/tiebreak" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["flip", "approve", "fallback"].includes(data.action) || typeof data.key !== "string") {
      return json({ error: "Ugyldig forespørsel." }, 400);
    }
    const meta = await readMeta(env);
    const current = await loadState(env, now, meta);
    const verdict = tieVerdict(current, data.action, data.key);
    if (verdict.done) return json(current);
    if (verdict.error) return json({ error: verdict.error }, 409);
    const g = verdict.group, by = s.user || null, at = osloNow(now), nonce = hex(crypto.getRandomValues(new Uint8Array(6)));
    let value, stmt;
    if (data.action === "approve") {
      const { n: _n, ...dec } = meta.ties[g.key];
      value = JSON.stringify({ ...dec, status: "approved", approvedBy: by, approvedAt: at, n: nonce });
      // Betinget på nøyaktig den lagrede verdien: to som godkjenner samtidig gir én endring.
      stmt = env.DB.prepare("UPDATE meta SET value=? WHERE key=? AND value=? AND NOT EXISTS (SELECT 1 FROM meta WHERE key='seeding')").bind(value, "tie:" + g.key, meta.tieRaw[g.key]);
    } else {
      const flip = data.action === "flip";
      const order = flip ? drawOrder(g.teams) : [...g.teams];
      value = JSON.stringify({ order, kind: flip ? (order.length === 2 ? "coin" : "lodd") : "fixed", status: flip ? "proposed" : "approved", by, at,
        approvedBy: flip ? null : by, approvedAt: flip ? null : at, n: nonce });
      // OR IGNORE: bare det første kastet (eller nødutgangen) for gruppen kan lagres.
      stmt = env.DB.prepare("INSERT OR IGNORE INTO meta(key,value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='seeding')").bind("tie:" + g.key, value);
    }
    // Revisjonen økes i samme transaksjon, men bare når nettopp denne verdien ble lagret.
    const [result] = await env.DB.batch([stmt, env.DB.prepare(BUMP_REV_IF).bind("tie:" + g.key, value)]);
    const after = await loadState(env, now);
    if (result.meta.changes === 1) return json(after);
    const again = tieVerdict(after, data.action, data.key);
    if (again.done) return json(after);
    return json({ error: again.error || "Noe ble endret samtidig. Prøv igjen." }, 409);
  }

  return json({ error: "Ukjent handling." }, 404);
}

const TIE_MSG = {
  pending: "Myntkast må godkjennes først.",
  phase: "Myntkast kan bare brukes når seriespillet er ferdig og sluttspillet ikke er låst.",
  unknown: "Ingen myntkast trengs for disse lagene.",
  notFlipped: "Kast myntet først.",
  flipped: "Myntkastet er allerede kastet.",
};
// Er handlingen allerede utført (svar 200 med tilstanden), ulovlig nå (409) eller klar til å utføres?
function tieVerdict(state, action, key) {
  const g = state.ties.find((t) => t.key === key);
  if (g) {
    if (action === "flip" && g.status !== "pending") return { done: true };
    if (action === "approve" && g.status === "approved") return { done: true };
    if (action === "fallback" && g.status === "approved" && g.kind === "fixed") return { done: true };
    if (action === "fallback" && g.status !== "pending") return { error: TIE_MSG.flipped };
  }
  if (!leagueFinished(state.matches) || state.seeded) return { error: TIE_MSG.phase };
  if (!g) return { error: TIE_MSG.unknown };
  if (action === "approve" && g.status === "pending") return { error: TIE_MSG.notFlipped };
  return { group: g };
}

async function readJsonBody(request) {
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim() !== "application/json") return null;
  // Rask avvisning av store kropper før de leses inn i minnet. Lengden sjekkes også under.
  if (Number(request.headers.get("Content-Length") || 0) > 4096) return null;
  let raw;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  // Checked on the actual bytes read, not the Content-Length header, which a
  // chunked request can omit entirely.
  if (raw.length < 1 || raw.length > 4096) return null;
  try {
    const data = JSON.parse(raw);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const now = new Date();
  // Lokal maskin eller lokalt nett (mobil på samme wifi under testing). Slike adresser kan
  // ikke nås via Cloudflare, så i drift er cookien alltid Secure.
  const local = isLocalHost(url);
  cookieSecure = url.protocol === "http:" && local ? "" : "; Secure";

  if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname, now);

  // html_handling is "none", so "/" matches no literal asset file and would
  // otherwise 404 — rewrite it to /index.html ourselves instead of relying on
  // platform auto-mapping. The gate check then decides which page it becomes.
  let target = url.pathname;
  if (target === "/") target = "/index.html";
  if (target === "/index.html" && !(await allowed(env, request, now))) target = "/gate.html";

  const page = target === "/index.html" || target === "/gate.html";
  let res;
  if (target !== url.pathname) {
    const rewritten = new URL(url);
    rewritten.pathname = target;
    res = await env.ASSETS.fetch(new Request(rewritten, request));
  } else res = await env.ASSETS.fetch(request);
  return page ? withPageHeaders(res) : res;
}

// D1 kan svare «overloaded», tidsavbrudd eller miste forbindelsen når mange skriver samtidig.
// Det er forbigående: svar 503 med Retry-After, så appen prøver igjen i stedet for å gi opp.
function transientError(err) {
  const msg = String((err && err.message) || err);
  // Feil i databaseoppsettet (manglende tabell eller kolonne, f.eks. glemt schema.sql eller migrering)
  // går ikke over av seg selv. De skal ikke se ut som «travel database» som appen prøver på nytt i det uendelige.
  if (/no such (table|column)|has no column|SQLITE_ERROR/i.test(msg)) return false;
  return /D1|overload|timed? ?out|timeout|network connection lost|reset|busy|locked|storage/i.test(msg);
}

export default {
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error(err);
      if (err instanceof ConfigError) return json({ error: "Serveren er ikke ferdig satt opp. Kontakt arrangøren." }, 503);
      if (/no such (table|column)|has no column/i.test(String(err && err.message))) return json({ error: "Databasen er ikke satt opp riktig. Kontakt arrangøren." }, 500);
      if (transientError(err)) return json({ error: "Databasen er travel akkurat nå. Prøv igjen om et øyeblikk." }, 503, { "Retry-After": "2" });
      return json({ error: "Serverfeil. Prøv igjen." }, 500);
    }
  },
};
