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
// ha sitt eget «iter»-felt (setup_admin_cloudflare.py skriver 10 000 som standard).
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

async function hmacKey(env) {
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
function standings(matches) {
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
  const out = [];
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
      cluster = cluster.sort((a, b) => mini[b.name].pts - mini[a.name].pts || mini[b.name].gd - mini[a.name].gd || mini[b.name].gf - mini[a.name].gf || a.index - b.index);
    }
    out.push(...cluster);
    i = j + 1;
  }
  return out;
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

async function readMeta(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('rev','seeding')").all();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { rev: Number(map.rev || 0), seeding: map.seeding || null };
}
// Billig endringsnøkkel: revisjonsnummeret økes ved hver skriving. Klokka endrer ingenting
// lenger, så uendret nummer betyr at ingenting er nytt.
function stateKey(rev) {
  return String(rev);
}
const BUMP_REV = "INSERT INTO meta(key,value) VALUES('rev','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1";
async function loadState(env, now, meta) {
  meta = meta || (await readMeta(env));
  const { results } = await env.DB.prepare("SELECT * FROM scores").all();
  const scores = new Map(results.map((r) => [r.id, r]));
  const matches = CONFIG.matches.map((base) => {
    const m = { ...base, ...scores.get(base.id) };
    m.status = effective(m);
    m.duration = duration(m);
    return m;
  });
  const table = standings(matches);
  let frozen = meta.seeding ? { value: meta.seeding } : null;
  const leagueDone = matches.every((m) => m.kind !== "league" || (m.status === "finished" && m.hs !== null && m.aws !== null));
  if (!frozen && leagueDone) {
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
  const { matches: _drop, ...config } = CONFIG;
  return { config, matches, table, seeded: !!frozen, podium: podium(matches), key: stateKey(meta.rev), serverTime: now.toISOString() };
}

// -- request handling -------------------------------------------------------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": CSP,
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
      ...extraHeaders,
    },
  });
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
    try { const list = JSON.parse(env.ADMIN_USERS); if (Array.isArray(list) && list.length) return list; } catch (e) { /* faller tilbake */ }
  }
  return [{ username: env.ADMIN_USERNAME || "", salt: env.ADMIN_SALT, hash: env.ADMIN_HASH }];
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
    const cell = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
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
        version=version+1, updated_by=?, updated_at=? WHERE id=? AND version=?`)
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
    // Mål teller bare mens kampen pågår. Sjekken ligger i selve UPDATE-en, så et mål som
    // kommer rett etter at en annen trykket Avslutt, blir avvist i stedet for å snike seg inn.
    const [result] = await env.DB.batch([
      env.DB.prepare(`UPDATE scores SET ${col} = MIN(99, MAX(0, COALESCE(${col},0) + ?)),
        version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'live'`)
        .bind(data.delta, s.user || null, osloNow(now), m.id),
      env.DB.prepare(BUMP_REV),
    ]);
    if (result.meta.changes !== 1) {
      return json({ error: m.status === "finished" ? "Kampen er avsluttet. Åpne den igjen for å endre resultatet." : "Start kampen før du fører mål." }, 409);
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
      stmt = env.DB.prepare("UPDATE scores SET status='live', hs=COALESCE(hs,0), aws=COALESCE(aws,0), started_at=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND status NOT IN ('live','finished')").bind(unix, ...stamp);
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
    if (result.meta.changes !== 1) return json({ error: problem || "Kampen er allerede i gang." }, 409);
    return json(await loadState(env, now));
  }

  // Lås sluttspilloppsettet manuelt (f.eks. når klokka ligger etter) eller lås det opp igjen.
  if (path === "/api/seeding" && request.method === "POST") {
    const data = await readJsonBody(request);
    if (data === null || !["lock", "unlock"].includes(data.action)) return json({ error: "Ugyldig forespørsel." }, 400);
    const current = await loadState(env, now);
    if (data.action === "lock") {
      const seed = JSON.stringify(current.table.map((r) => r.name));
      await env.DB.batch([
        env.DB.prepare("INSERT INTO meta(key,value) VALUES('seeding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(seed),
        env.DB.prepare(BUMP_REV),
      ]);
    } else {
      const started = current.matches.some((x) => x.kind === "playoff" && (x.hs !== null || x.aws !== null));
      if (started) return json({ error: "Sluttspillet har allerede resultater. Fjern dem før du låser opp oppsettet." }, 409);
      await env.DB.batch([env.DB.prepare("DELETE FROM meta WHERE key='seeding'"), env.DB.prepare(BUMP_REV)]);
    }
    return json(await loadState(env, now));
  }

  return json({ error: "Ukjent handling." }, 404);
}

async function readJsonBody(request) {
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim() !== "application/json") return null;
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

  if (target !== url.pathname) {
    const rewritten = new URL(url);
    rewritten.pathname = target;
    return env.ASSETS.fetch(new Request(rewritten, request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      console.error(err);
      return json({ error: "Serverfeil. Prøv igjen." }, 500);
    }
  },
};
