"""
One-time migration: create user_tracks table.
Run with: python migrate_auth.py
"""

import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

conn = psycopg2.connect(os.environ["POSTGRES_URL"])
conn.autocommit = True
cur = conn.cursor()

cur.execute("""
    CREATE TABLE IF NOT EXISTS user_tracks (
        user_id         TEXT        NOT NULL,
        track_id        UUID        NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        source_entity_id UUID       NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, track_id)
    );
""")

cur.execute("CREATE INDEX IF NOT EXISTS user_tracks_user_id ON user_tracks(user_id);")

print("user_tracks table ready")
cur.close()
conn.close()
