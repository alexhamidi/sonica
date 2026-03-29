-- Migration: flatten entities into grandparents + parents tables
-- Run once against the existing database.

BEGIN;

-- 1. Create grandparents (was: entities WHERE parent_id IS NULL)
CREATE TABLE grandparents (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    spotify_id text UNIQUE,
    name       text NOT NULL,
    type       text NOT NULL,
    cover_s3   text,
    status     text NOT NULL DEFAULT 'ready',
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO grandparents (id, spotify_id, name, type, cover_s3, status, created_at)
SELECT id, spotify_id, name, type, cover_s3, status, created_at
FROM entities
WHERE parent_id IS NULL;

-- 2. Create parents (was: entities WHERE parent_id IS NOT NULL)
CREATE TABLE parents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grandparent_id uuid NOT NULL REFERENCES grandparents(id) ON DELETE CASCADE,
    spotify_id     text UNIQUE,
    name           text NOT NULL,
    type           text NOT NULL,
    cover_s3       text,
    status         text NOT NULL DEFAULT 'ready',
    created_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO parents (id, grandparent_id, spotify_id, name, type, cover_s3, status, created_at)
SELECT id, parent_id, spotify_id, name, type, cover_s3, status, created_at
FROM entities
WHERE parent_id IS NOT NULL;

-- 3a. Drop old FK so we can freely re-point entity_id
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_entity_id_fkey;

-- 3b. For tracks pointing directly at grandparents (artists), create a
--     synthetic "Top Tracks" parent under each such grandparent, then
--     re-point those tracks to the new parent.
INSERT INTO parents (grandparent_id, name, type, cover_s3, status, created_at)
SELECT DISTINCT
    gp.id,
    'Top Tracks',
    'top_tracks',
    gp.cover_s3,
    'ready',
    gp.created_at
FROM tracks t
JOIN grandparents gp ON gp.id = t.entity_id;

-- Re-point those tracks to the newly created parent
UPDATE tracks t
SET entity_id = p.id
FROM parents p
WHERE p.grandparent_id = t.entity_id
  AND p.type = 'top_tracks';

-- 3c. Rename column and add new FK
ALTER TABLE tracks RENAME COLUMN entity_id TO parent_id;
ALTER TABLE tracks ADD CONSTRAINT tracks_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE;

-- 4. Rename entity_tracks → parent_tracks
ALTER TABLE entity_tracks RENAME TO parent_tracks;
ALTER TABLE parent_tracks RENAME COLUMN entity_id TO parent_id;
ALTER TABLE parent_tracks DROP CONSTRAINT IF EXISTS entity_tracks_entity_id_fkey;
ALTER TABLE parent_tracks DROP CONSTRAINT IF EXISTS entity_tracks_track_id_fkey;
ALTER TABLE parent_tracks ADD CONSTRAINT parent_tracks_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE;
ALTER TABLE parent_tracks ADD CONSTRAINT parent_tracks_track_id_fkey
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE;

-- 5. Fix user_grandparents FK to point at grandparents table
ALTER TABLE user_grandparents DROP CONSTRAINT IF EXISTS user_grandparents_grandparent_id_fkey;
ALTER TABLE user_grandparents ADD CONSTRAINT user_grandparents_grandparent_id_fkey
    FOREIGN KEY (grandparent_id) REFERENCES grandparents(id) ON DELETE CASCADE;

-- 6. Drop the old entities table
DROP TABLE entities;

COMMIT;
