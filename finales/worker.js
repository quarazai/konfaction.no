// KonfAction: Cloudflare Worker port of server.py.
// Stateless HMAC-signed cookie instead of an in-memory sessions map — Workers
// don't keep a single long-lived process, so server.py's SESSIONS dict has no
// equivalent here and isn't needed: everything a session held (admin, public,
// gate question index, csrf, expiry) fits in the cookie itself.
import CONFIG from "./config/tournament.json";

const GATE_QUESTIONS = [
  ["Hva er hovedtemaet i 1. Korinterbrev 13?", ["kjærlighet", "kjærligheten"]],
  // Goliat kommer først i kapittel 17, men godtas fortsatt så ingen blir stoppet av det.
  ["Nevn en av hovedpersonene i 1. Samuelsbok 16.", ["david", "samuel", "isai", "saul", "goliat"]],
  ["Hvem er hovedpersonen i 1. Mosebok 6?", ["noa", "noah"]],
  ["Hva heter dronningen i Esters bok 1?", ["vasti"]],
  ["Nevn en profet i Dommerne 4.", ["deborah", "debora"]],
];

const ENTRY_PASSWORD = "siuuuuuuu";
const GATE_OPEN = "2026-10-09T00:00:00";
const GATE_CLOSE = "2026-10-10T08:30:00";

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; " +
  "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Gratisplanen hos Cloudflare gir 10 ms CPU per forespørsel. 600 000 runder
// PBKDF2 bruker ~250 ms og kan gi feil 1102 ved innlogging. Hver bruker kan derfor
// ha sitt eget «iter»-felt (setup_admin_cloudflare.py skriver 5 000 som standard).
// Brukere uten feltet (laget med eldre skript) faller tilbake til 600 000.
const PBKDF2_LEGACY_ITERATIONS = 600000;

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
// Lag som er helt like etter alle reglene (også innbyrdes oppgjør) og står i hvert sitt
// sluttspillpar (grense 2|3, 4|5, 6|7, 8|9), avgjøres ved myntkast. Like lag i samme par
// (1|2, 3|4 …) bytter bare hjemme/borte og løses stille med fast rekkefølge.
// decisions: lagrede avgjørelser (nøkkel «Delta|Echo»), bare med når serien er ferdig.
// Returnerer tabellen og gruppene som betyr noe (med eventuell gyldig avgjørelse).
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
  const out = [], groups = [];
  for (let i = 0; i < ordered.length; ) {
    let j = i;
    const same = (x, y) => x.pts === y.pts && x.gd === y.gd && x.gf === y.gf;
    while (j + 1 < ordered.length && same(ordered[j + 1], ordered[i])) j++;
    let cluster = ordered.slice(i, j + 1);
    if (cluster.length > 1) {
      const names = new Set(cluster.map((r) => r.name));
      const mini = Object.fromEntries(cluster.map((r) => [r.name, { pts: 0, gd: 0, gf: 0 }]));
      for (const m of played) {
        if (!names.has(m.home) || !names.has(m.away)) continue;
        for (const [t, gf, ga] of [[m.home, m.hs, m.aws], [m.away, m.aws, m.hs]]) {
          mini[t].gf += gf; mini[t].gd += gf - ga; mini[t].pts += gf > ga ? 2 : gf === ga ? 1 : 0;
        }
      }
      const h2h = (a, b) => mini[b.name].pts - mini[a.name].pts || mini[b.name].gd - mini[a.name].gd || mini[b.name].gf - mini[a.name].gf;
      cluster = cluster.sort((a, b) => h2h(a, b) || a.index - b.index);
      // Lag som fortsatt er like etter innbyrdes oppgjør: en gruppe. Tre like kan bli to like.
      for (let a = 0; a < cluster.length; ) {
        let b = a;
        while (b + 1 < cluster.length && h2h(cluster[a], cluster[b + 1]) === 0) b++;
        const start = out.length + a, end = out.length + b;
        if (b > a && Math.floor(start / 2) !== Math.floor(end / 2)) {
          const run = cluster.slice(a, b + 1);
          const teams = run.map((r) => r.name);
          const key = tieKey(teams);
          const dec = decisions && Object.hasOwn(decisions, key) && validDecision(decisions[key], teams) ? decisions[key] : null;
          groups.push({ key, teams, positions: run.map((_, k) => start + k + 1), decision: dec });
          if (dec) cluster.splice(a, run.length, ...dec.order.map((n) => run.find((r) => r.name === n)));
        }
        a = b + 1;
      }
    }
    out.push(...cluster);
    i = j + 1;
  }
  return { table: out, groups };
}
function leagueFinished(matches) {
  return matches.every((m) => m.kind !== "league" || (m.status === "finished" && m.hs !== null && m.aws !== null));
}
function tieView(key, teams, positions, dec) {
  return {
    key, teams, positions,
    kind: dec ? dec.kind : null,
    status: dec ? dec.status : "pending",
    order: dec ? dec.order : null,
    by: dec ? dec.by ?? null : null,
    at: dec ? dec.at ?? null : null,
    approvedBy: dec ? dec.approvedBy ?? null : null,
    approvedAt: dec ? dec.approvedAt ?? null : null,
  };
}
// Myntkast-listen. Før låsing: alle grupper som betyr noe. Etter låsing: bare grupper som fortsatt
// er helt like og har en avgjørelse (en gruppe som er brutt opp av en rettelse, vises ikke lenger).
function tieList(groups, frozen) {
  return groups.filter((g) => !frozen || g.decision).map((g) => tieView(g.key, g.teams, g.positions, g.decision));
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

// Kampstatus rett fra databasen, brukt til å gi riktig melding etter en konflikt.
async function currentStatus(env, id) {
  const row = await env.DB.prepare("SELECT status FROM scores WHERE id = ?").bind(id).first();
  return row ? effective(row) : null;
}

async function readMeta(env) {
  // Én spørring: revisjon, låst oppsett og myntkast-avgjørelsene («tie:Delta|Echo»).
  const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('rev','seeding') OR key LIKE 'tie:%'").all();
  const map = {}, ties = Object.create(null), tieRaw = Object.create(null);
  for (const r of results) {
    if (!r.key.startsWith("tie:")) map[r.key] = r.value;
    else {
      try {
        ties[r.key.slice(4)] = JSON.parse(r.value);
        tieRaw[r.key.slice(4)] = r.value;
      } catch { /* ødelagt verdi: behandles som ingen avgjørelse */ }
    }
  }
  return { rev: Number(map.rev || 0), seeding: map.seeding || null, ties, tieRaw };
}
// Billig endringsnøkkel: revisjonsnummeret økes ved hver skriving. Klokka endrer ingenting
// lenger, så uendret nummer betyr at ingenting er nytt.
function stateKey(rev) {
  return String(rev);
}
// Sluttspillkamper kan bare få resultat mens oppsettet er låst. Id-ene er tall fra kampoppsettet.
const PLAYOFF_IDS = CONFIG.matches.filter((m) => m.kind === "playoff").map((m) => Number(m.id)).join(",");
const SEEDED_OR_LEAGUE = `(id NOT IN (${PLAYOFF_IDS}) OR EXISTS (SELECT 1 FROM meta WHERE key='seeding'))`;
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
    if (m.kind === "playoff") {
      m.home = seed[m.ranks[0] - 1];
      m.away = seed[m.ranks[1] - 1];
      m.provisional = !frozen;
      if (m.provisional) m.status = "upcoming";
    }
  }
  const ties = leagueDone ? tieList(groups, !!frozen) : [];
  const { matches: _drop, ...config } = CONFIG;
  return { config, matches, table, seeded: !!frozen, ties, tiePending, podium: podium(matches), key: stateKey(meta.rev), serverTime: now.toISOString() };
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

// Tilgangen gjelder bare fasen den ble gitt i: passordet fra før 9. oktober åpner ikke bibelfasen.
async function allowed(env, request, now) {
  const phase = gatePhase(now);
  if (!phase) return true;
  const s = await readSession(env, request);
  return !!(s && (s.admin || s.passed === phase));
}

async function checkRateLimit(env, ip) {
  const cutoff = Math.floor(Date.now() / 1000) - 300;
  await env.DB.prepare("DELETE FROM attempts WHERE ts < ?").bind(cutoff).run();
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM attempts WHERE ip = ?").bind(ip).first();
  return count < 8;
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
    if (!(await allowed(env, request, now))) return json({ error: "Svar på inngangsspørsmålet for å se turneringen." }, 401);
    const meta = await readMeta(env);
    const since = new URL(request.url).searchParams.get("since");
    const key = stateKey(meta.rev);
    if (since && since === key) return json({ same: true, key, serverTime: now.toISOString() });
    return json(await loadState(env, now, meta));
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
    const cfg = match || users[0];
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
    const rows = [["Runde", "Kamp", "Type", "Start", "Slutt", "Bane", "Hjemme", "Borte", "Mål hjemme", "Mål borte", "Status", "Vinner", "Vunnet på straffer", "Sist endret av", "Sist endret"]];
    for (const m of st.matches) {
      const d = decided(m);
      rows.push([m.kind === "playoff" ? "Sluttspill" : m.round, m.id, m.kind === "playoff" ? `Plass ${m.ranks[1]}–${m.ranks[0]}` : "Serie", m.start, m.end, m.pitch,
        m.home, m.away, m.hs, m.aws, status[m.status], d ? d.winner : "", d && m.hs === m.aws ? "Ja" : "", m.updated_by, m.updated_at ? m.updated_at.replace("T", " ") : ""]);
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
    const current = await loadState(env, now);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.provisional) return json({ error: "Sluttspillet er ikke klart. Fullfør alle seriekampene først." }, 409);
    const { hs, aws, mode, winner } = data;
    const validScore = (v) => v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v <= 99);
    if (!validScore(hs) || !validScore(aws) || !["upcoming", "live", "finished"].includes(mode)) {
      return json({ error: "Bruk hele mål mellom 0 og 99 og en gyldig status." }, 400);
    }
    if (mode !== "upcoming" && (hs == null || aws == null)) return json({ error: "Fyll inn mål for begge lagene." }, 400);
    if (mode === "finished" && m.kind === "playoff" && hs === aws && ![m.home, m.away].includes(winner)) {
      return json({ error: "Uavgjort i sluttspill: velg hvem som vant på straffer." }, 400);
    }
    if (winner !== null && winner !== undefined && (![m.home, m.away].includes(winner) || m.kind !== "playoff" || hs == null || hs !== aws)) {
      return json({ error: "Vinner ved uavgjort må være et av lagene i kampen." }, 400);
    }
    const [result] = await env.DB.batch([
      // «Ikke startet» nullstiller kampen. «Pågår» uten starttid får starttid nå.
      env.DB.prepare(`UPDATE scores SET hs=?, aws=?, status=?, winner=?,
        started_at = CASE WHEN ?='upcoming' THEN NULL WHEN ?='live' AND started_at IS NULL THEN ? ELSE started_at END,
        version=version+1, updated_by=?, updated_at=? WHERE id=? AND version=? AND ${SEEDED_OR_LEAGUE}`)
        .bind(mode === "upcoming" ? null : hs, mode === "upcoming" ? null : aws, mode, mode === "upcoming" ? null : winner ?? null,
          mode, mode, Math.floor(now.getTime() / 1000), s.user || null, osloNow(now), m.id, data.version ?? null),
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
        AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?)`)
        .bind(data.delta, s.user || null, osloNow(now), m.id, rid === null ? null : "g:" + rid),
      env.DB.prepare(BUMP_REV),
    ];
    if (rid !== null) {
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO meta(key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM scores WHERE id = ? AND status = 'live')").bind("g:" + rid, String(unix), m.id),
        env.DB.prepare("DELETE FROM meta WHERE key LIKE 'g:%' AND CAST(value AS INTEGER) < ?").bind(unix - 3600),
      );
    }
    const [result] = await env.DB.batch(stmts);
    if (result.meta.changes !== 1) {
      // Samme trykk er allerede lagret: svar som om det gikk bra, uten å telle det på nytt.
      if (rid !== null && (await env.DB.prepare("SELECT 1 AS hit FROM meta WHERE key = ?").bind("g:" + rid).first())) return json(await loadState(env, now));
      const status = await currentStatus(env, m.id);
      return json({ error: status === "finished" ? "Kampen er avsluttet. Åpne den igjen for å endre resultatet." : "Start kampen før du fører mål." }, 409);
    }
    return json(await loadState(env, now));
  }

  // Start, avslutt, åpne igjen og angre start. Hver handling er én betinget UPDATE,
  // så to dommere som trykker samtidig ikke kan ødelegge for hverandre.
  if (path === "/api/match" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["start", "finish", "reopen", "unstart"].includes(data.action)) return json({ error: "Ugyldig forespørsel." }, 400);
    const current = await loadState(env, now);
    const m = current.matches.find((x) => x.id === data.id);
    if (!m) return json({ error: "Ukjent kamp." }, 404);
    if (m.provisional) return json({ error: "Lås sluttspilloppsettet før kampen startes." }, 409);
    const stamp = [s.user || null, osloNow(now), m.id];
    const unix = Math.floor(now.getTime() / 1000);
    let stmt, problem;
    if (data.action === "start") {
      stmt = env.DB.prepare(`UPDATE scores SET status='live', hs=COALESCE(hs,0), aws=COALESCE(aws,0), started_at=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status NOT IN ('live','finished') AND ${SEEDED_OR_LEAGUE}`).bind(unix, ...stamp);
      problem = m.status === "finished" ? "Kampen er allerede avsluttet." : null;
    } else if (data.action === "finish") {
      // Uavgjort i sluttspill krever vinner (straffer). Stillingen hentes fra databasen, ikke fra klienten.
      const draw = m.kind === "playoff" && m.hs === m.aws;
      const winner = draw ? data.winner : null;
      if (draw && ![m.home, m.away].includes(winner)) return json({ error: "Uavgjort i sluttspill: velg hvem som vant på straffer." }, 400);
      stmt = env.DB.prepare("UPDATE scores SET status='finished', winner=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='live' AND hs IS ? AND aws IS ?").bind(winner, ...stamp, m.hs, m.aws);
      problem = m.status !== "live" ? (m.status === "finished" ? "Kampen er allerede avsluttet." : "Kampen er ikke startet.") : "Stillingen ble endret samtidig. Sjekk resultatet og prøv igjen.";
    } else if (data.action === "reopen") {
      stmt = env.DB.prepare("UPDATE scores SET status='live', winner=NULL, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='finished'").bind(...stamp);
      problem = "Kampen er ikke avsluttet.";
    } else {
      // Angre start: bare mens stillingen er 0–0, så ingen mål kan forsvinne.
      stmt = env.DB.prepare("UPDATE scores SET status='upcoming', hs=NULL, aws=NULL, winner=NULL, started_at=NULL, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status='live' AND hs=0 AND aws=0").bind(...stamp);
      problem = "Start kan bare angres mens stillingen er 0–0.";
    }
    const [result] = await env.DB.batch([stmt, env.DB.prepare(BUMP_REV)]);
    if (result.meta.changes !== 1) {
      // Meldingen bygger på stillingen etter konflikten, ikke den vi leste før: to dommere som
      // trykker Avslutt samtidig skal få «allerede avsluttet», ikke «stillingen ble endret».
      const status = await currentStatus(env, m.id);
      if (status === "finished" && data.action !== "reopen") problem = "Kampen er allerede avsluttet.";
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
      if (current.tiePending) return json({ error: TIE_MSG.pending }, 409);
      const seed = JSON.stringify(current.table.map((r) => r.name));
      const [result] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO meta(key,value) VALUES('seeding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE ${noPlayoffResults}`).bind(seed),
        env.DB.prepare(BUMP_REV),
      ]);
      if (result.meta.changes !== 1) return busy;
    } else {
      const started = current.matches.some((x) => x.kind === "playoff" && (x.hs !== null || x.aws !== null));
      if (started) return busy;
      const [result] = await env.DB.batch([env.DB.prepare(`DELETE FROM meta WHERE key='seeding' AND ${noPlayoffResults}`), env.DB.prepare(BUMP_REV)]);
      if (result.meta.changes !== 1 && current.seeded) return busy;
    }
    return json(await loadState(env, now));
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
