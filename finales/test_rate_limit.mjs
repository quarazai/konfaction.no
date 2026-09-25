// Self-check for the /api/state limiter in worker.js (and its twin,
// state_rate_limited() in server.py). Duplicated here, not imported, because
// worker.js does a top-level `import CONFIG from "./config/tournament.json"`
// that only wrangler's bundler resolves -- plain node can't load the file.
// Keep this in sync with the `stateHits`/`stateRateLimited`/STATE_LIMIT_PER_MIN
// block in worker.js.
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

const total = STATE_LIMIT_PER_MIN + 5;
let blocked = 0;
for (let i = 0; i < total; i++) if (stateRateLimited("1.2.3.4")) blocked++;
console.assert(blocked === 5, `expected 5 blocked (${total}-${STATE_LIMIT_PER_MIN}), got ${blocked}`);
console.assert(!stateRateLimited("9.9.9.9"), "a fresh IP must not be affected by another IP's hits");
console.log(blocked === 5 ? "OK" : "FAIL");
