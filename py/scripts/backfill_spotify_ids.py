#!/usr/bin/env python3
"""
For all artist grandparents with seed: spotify_ids, search Spotify for the
real artist ID and update the DB.
"""

from __future__ import annotations

import json
import os
import re
import time

import psycopg2
import psycopg2.errors
import psycopg2.extras
import requests
from dotenv import load_dotenv

load_dotenv()

POSTGRES_URL = os.environ["POSTGRES_URL"]
SEARCH_HASH = "dea90d34a7ee20d54354f1bf3171a65c36b9f242401494d56451d468d516125e"
PARTNER_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "app-platform": "WebPlayer",
    "spotify-app-version": "1.2.49.454",
}


def get_token() -> str:
    r = requests.get(
        "https://open.spotify.com/embed/artist/3hteYQFiMFbJY7wS0xDymP",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL)
    return json.loads(m.group(1))["props"]["pageProps"]["state"]["settings"]["session"][
        "accessToken"
    ]


def search_artist(name: str, token: str) -> tuple[str | None, str | None, int]:
    r = requests.get(
        "https://api-partner.spotify.com/pathfinder/v1/query",
        params={
            "operationName": "searchSuggestions",
            "variables": json.dumps(
                {
                    "query": name,
                    "limit": 5,
                    "numberOfTopResults": 5,
                    "offset": 0,
                    "includeAuthors": True,
                }
            ),
            "extensions": json.dumps(
                {"persistedQuery": {"version": 1, "sha256Hash": SEARCH_HASH}}
            ),
        },
        headers={"Authorization": f"Bearer {token}", **PARTNER_HEADERS},
    )
    if not r.ok:
        return None, None, r.status_code
    items = (
        r.json()
        .get("data", {})
        .get("searchV2", {})
        .get("topResultsV2", {})
        .get("itemsV2", [])
    )
    for item in items:
        d = item.get("item", {}).get("data", {})
        if d.get("__typename") == "Artist":
            found_name = d.get("profile", {}).get("name", "")
            spotify_id = d.get("uri", "").split(":")[-1]
            return spotify_id, found_name, 200
    return None, None, 200


def run():
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT id, name, spotify_id FROM grandparents
        WHERE type = 'artist' AND spotify_id LIKE 'seed:%'
        ORDER BY name
    """)
    rows = cur.fetchall()
    print(f"Found {len(rows)} artists to backfill")

    token = get_token()
    updated = skipped = failed = 0

    for i, row in enumerate(rows):
        name = row["name"]
        gp_id = str(row["id"])

        if i % 20 == 0 and i > 0:
            token = (
                get_token()
            )  # refresh token frequently to avoid silent rate limiting

        spotify_id, found_name, status = search_artist(name, token)

        if status != 200:
            print(f"  HTTP {status}: {name} — refreshing token")
            token = get_token()
            time.sleep(2)
            spotify_id, found_name, status = search_artist(name, token)

        if not spotify_id:
            failed += 1
            continue

        try:
            cur.execute(
                "UPDATE grandparents SET spotify_id = %s WHERE id = %s",
                (spotify_id, gp_id),
            )
            conn.commit()
            updated += 1
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            skipped += 1
            continue

        if i % 100 == 0:
            print(f"  [{i}/{len(rows)}] {name!r} → {spotify_id} ({found_name!r})")

        time.sleep(0.1)

    cur.close()
    conn.close()
    print(
        f"\nDone — updated: {updated}, skipped (conflict): {skipped}, failed: {failed}"
    )


if __name__ == "__main__":
    run()
