#!/usr/bin/env python3
"""
migrate_orphans.py

Creates an 'orphans' sentinel grandparent entity and migrates all orphaned entities
(entities with no parent and not themselves parents) to have this sentinel as parent.

Also adds the orphans sentinel to user_grandparents for all existing users.
Run with: python migrate_orphans.py
"""

import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

ORPHANS_ID = "00000000-0000-0000-0000-000000000002"
ORPHANS_NAME = "Orphaned Playlists"
ORPHANS_TYPE = "orphans"


def main():
    conn = psycopg2.connect(os.environ["POSTGRES_URL"])
    conn.autocommit = True
    cur = conn.cursor()

    print("1. Updating entities type constraint to include 'orphans'...")
    # Drop the existing constraint
    cur.execute("""
        ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_type_check;
    """)
    # Recreate with 'orphans' added
    cur.execute("""
        ALTER TABLE entities ADD CONSTRAINT entities_type_check
        CHECK (type = ANY (ARRAY['playlist', 'profile', 'album', 'artist', 'searches', 'search', 'orphans']));
    """)
    print("   constraint updated")

    print("2. Creating orphans sentinel entity...")
    cur.execute(
        """
        INSERT INTO entities (id, name, type, status)
        VALUES (%s, %s, %s, 'ready')
        ON CONFLICT (id) DO NOTHING
    """,
        (ORPHANS_ID, ORPHANS_NAME, ORPHANS_TYPE),
    )
    if cur.rowcount > 0:
        print(f"   created: {ORPHANS_ID}")
    else:
        print(f"   already exists: {ORPHANS_ID}")

    print("3. Migrating orphaned entities to sentinel...")
    cur.execute(
        """
        -- Find true orphans: entities with no parent AND not a parent themselves
        UPDATE entities
        SET parent_id = %s
        WHERE parent_id IS NULL
          AND id NOT IN (SELECT DISTINCT parent_id FROM entities WHERE parent_id IS NOT NULL)
          AND id != %s  -- exclude sentinel itself
          AND type != 'searches'  -- keep searches separate
    """,
        (ORPHANS_ID, ORPHANS_ID),
    )
    print(f"   updated {cur.rowcount} orphaned entities")

    print("4. Ensuring orphans sentinel in user_grandparents for all users...")
    # Get all distinct user_ids from user_grandparents (and maybe from auth sessions?)
    cur.execute("SELECT DISTINCT user_id FROM user_grandparents")
    user_ids = [row[0] for row in cur.fetchall()]

    added = 0
    for user_id in user_ids:
        cur.execute(
            """
            INSERT INTO user_grandparents (user_id, grandparent_id)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
        """,
            (user_id, ORPHANS_ID),
        )
        if cur.rowcount > 0:
            added += 1

    print(f"   added orphans sentinel for {added} users (total {len(user_ids)} users)")

    print("5. Adding preference columns to user_grandparents...")
    cur.execute("""
        ALTER TABLE user_grandparents
        ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS expanded BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS disabled_children JSONB DEFAULT '[]'::jsonb;
    """)
    print("   columns added (if not exist)")

    print(
        "6. (Optional) Adding new users in the future will be handled by /api/me/canvas"
    )

    cur.close()
    conn.close()
    print("\nMigration complete.")


if __name__ == "__main__":
    main()
