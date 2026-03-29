#!/usr/bin/env python3
"""
migrate_parents.py

One-time migration:
  1. Adds parent_id column to entities (nullable UUID self-reference)
  2. Makes spotify_id nullable (for synthetic parent entities)
  3. Creates a profile parent entity for the known Spotify user
  4. Links all existing playlist entities to that parent

Run with: python migrate_parents.py
"""

import os
import re

import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv()

PROFILE_SPOTIFY_ID = "06cswxeb142s3vyyiq8bgsalw"
PROFILE_URL = f"https://open.spotify.com/user/{PROFILE_SPOTIFY_ID}"


def fetch_profile_name(spotify_id: str) -> str:
    try:
        url = f"https://open.spotify.com/embed/user/{spotify_id}"
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        m = re.search(
            r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL
        )
        if m:
            import json

            data = json.loads(m.group(1))
            name = data["props"]["pageProps"]["state"]["data"]["entity"]["name"]
            if name:
                return name
    except Exception as e:
        print(f"  Could not fetch profile name: {e}")
    return f"profile:{spotify_id}"


def main():
    conn = psycopg2.connect(os.environ["POSTGRES_URL"])
    conn.autocommit = True
    cur = conn.cursor()

    print("1. Adding parent_id column...")
    cur.execute("""
        ALTER TABLE entities
        ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES entities(id);
    """)

    print("2. Making spotify_id nullable...")
    cur.execute("ALTER TABLE entities ALTER COLUMN spotify_id DROP NOT NULL;")
    print("   done")

    print("3. Fetching profile name from Spotify...")
    profile_name = fetch_profile_name(PROFILE_SPOTIFY_ID)
    print(f"   name: {profile_name!r}")

    print("4. Creating profile parent entity (if not exists)...")
    cur.execute(
        """
        INSERT INTO entities (spotify_id, type, name, status)
        VALUES (%s, 'profile', %s, 'ready')
        ON CONFLICT (spotify_id) DO NOTHING
        RETURNING id
    """,
        (PROFILE_SPOTIFY_ID, profile_name),
    )
    row = cur.fetchone()
    if row:
        profile_id = row[0]
        print(f"   created: {profile_id}")
    else:
        cur.execute(
            "SELECT id FROM entities WHERE spotify_id = %s", (PROFILE_SPOTIFY_ID,)
        )
        profile_id = cur.fetchone()[0]
        print(f"   already exists: {profile_id}")

    print("5. Linking existing playlist entities to profile...")
    cur.execute(
        """
        UPDATE entities
        SET parent_id = %s
        WHERE type = 'playlist'
          AND parent_id IS NULL
          AND id != %s
    """,
        (profile_id, profile_id),
    )
    print(f"   updated {cur.rowcount} entities")

    cur.close()
    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
