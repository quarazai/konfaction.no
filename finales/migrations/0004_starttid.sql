-- Kjør én gang på en database som ble laget før dommeren måtte starte kampen selv:
--   npx wrangler d1 execute konfaction --remote --file=migrations/0004_starttid.sql
-- (Nye databaser trenger ikke dette; schema.sql har allerede kolonnen.)
-- Lagrer når dommeren trykket «Start kampen», så nedtellingen følger det faktiske avsparket.
ALTER TABLE scores ADD COLUMN started_at INTEGER;
