-- Run against POSTGRES_URL if /api/artists (and similar) return 500 with
-- "column ... monthly_listeners does not exist".

ALTER TABLE grandparents
  ADD COLUMN IF NOT EXISTS monthly_listeners integer;

UPDATE grandparents
SET monthly_listeners = 0
WHERE monthly_listeners IS NULL;
