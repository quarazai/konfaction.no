#!/bin/sh
# Starter nettsiden lokalt med samme kode som på Cloudflare (worker.js + lokal D1-database).
# Bruk: sh start-lokalt.sh   (eller: npm run lokal)
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
if [ ! -f .dev.vars ]; then
  echo "Første gang: lag en lokal admininnlogging (gjelder bare på denne maskinen)."
  python3 setup_admin_cloudflare.py --dev-vars
fi
if [ ! -d .wrangler/state/v3/d1 ]; then
  echo "Første gang: lager lokal database ..."
  npx wrangler d1 execute konfaction --local --file=schema.sql
  npx wrangler d1 execute konfaction --local --file=seed.sql
fi
IP=$(ipconfig getifaddr en0 2>/dev/null || true)
echo ""
echo "  PC:     http://localhost:8787"
[ -n "$IP" ] && echo "  Mobil:  http://$IP:8787   (samme wifi)"
echo "  Passord på forsiden: siuuuuuuu   ·   Stopp med Ctrl+C"
echo ""
npx wrangler dev --ip 0.0.0.0 --port 8787
