#!/bin/sh
# Sletter alle lokale resultater og nominasjoner (bare på denne maskinen, ikke på Cloudflare).
set -e
cd "$(dirname "$0")"
npx wrangler d1 execute konfaction --local --command "UPDATE scores SET hs=NULL,aws=NULL,status='auto',winner=NULL,started_at=NULL,updated_by=NULL,updated_at=NULL,version=0; DELETE FROM meta WHERE key='seeding'; DELETE FROM nominations; DELETE FROM attempts; UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='rev';"
echo "Lokale resultater er nullstilt."
