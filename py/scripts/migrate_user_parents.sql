-- Migration: add user_parents table, migrate data, drop disabled_children/active
-- Run once against the existing database.

BEGIN;

-- 1. Create user_parents join table
CREATE TABLE IF NOT EXISTS user_parents (
    user_id    text NOT NULL,
    parent_id  uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, parent_id)
);

CREATE INDEX IF NOT EXISTS user_parents_user_id_idx ON user_parents (user_id);
CREATE INDEX IF NOT EXISTS user_parents_parent_id_idx ON user_parents (parent_id);

-- 2. Migrate existing data: for each user_grandparent, create user_parents rows
--    for all parents under that grandparent EXCEPT those in disabled_children.
INSERT INTO user_parents (user_id, parent_id)
SELECT ug.user_id, p.id
FROM user_grandparents ug
JOIN parents p ON p.grandparent_id = ug.grandparent_id
WHERE NOT (COALESCE(ug.disabled_children, '[]'::jsonb) @> to_jsonb(p.id::text))
ON CONFLICT DO NOTHING;

-- 3. Drop obsolete columns
ALTER TABLE user_grandparents DROP COLUMN IF EXISTS disabled_children;
ALTER TABLE user_grandparents DROP COLUMN IF EXISTS active;

COMMIT;
