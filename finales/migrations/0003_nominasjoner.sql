-- Kjør én gang på en database som ble laget før nominasjonene kom med:
--   npx wrangler d1 execute konfaction --remote --file=migrations/0003_nominasjoner.sql
-- Trygg å kjøre flere ganger (IF NOT EXISTS), og rører ikke resultatene.
CREATE TABLE IF NOT EXISTS nominations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  award TEXT NOT NULL,
  team TEXT NOT NULL,
  player TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL
);
