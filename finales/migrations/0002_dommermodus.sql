-- Kjør én gang på en database som ble laget med den gamle schema.sql:
--   npx wrangler d1 execute konfaction --remote --file=migrations/0002_dommermodus.sql
-- (Nye databaser trenger ikke dette; schema.sql har allerede kolonnene.)
ALTER TABLE scores ADD COLUMN updated_by TEXT;
ALTER TABLE scores ADD COLUMN updated_at TEXT;
INSERT OR IGNORE INTO meta(key, value) VALUES ('rev', '0');
