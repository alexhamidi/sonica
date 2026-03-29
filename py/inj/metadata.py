#!/usr/bin/env python3
"""
Fetch Spotify metadata using embed endpoint + partner API + album pages.
Artist → Albums (via partner API) → Tracks (via album page scraping).
"""

import base64
import csv
import itertools
import json
import re
import threading
import time
from pathlib import Path
from queue import Queue

import requests

IN_FILE = Path(__file__).parent.parent / "data" / "test_spotify_artists.csv"
OUT_FILE = Path(__file__).parent.parent / "data" / "spotify_metadata_full.csv"

WORKERS = 20
WORKERS_PER_PROXY = 2
RATE_DELAY = 0.05

US_PROXY_IPS = {
    "9.142.40.203",
    "9.142.215.3",
    "138.226.88.249",
    "9.142.34.159",
    "45.56.183.205",
    "192.53.70.229",
    "192.46.190.109",
    "192.53.66.38",
    "9.142.218.133",
    "192.46.185.132",
}


def load_proxies():
    proxies_file = Path(__file__).resolve().parent.parent.parent / "proxies.txt"
    proxies = []
    for line in proxies_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        host, port, user, pwd = line.split(":")
        if host not in US_PROXY_IPS:
            continue
        proxies.append(f"http://{user}:{pwd}@{host}:{port}")
    return proxies


PROXIES = load_proxies()
NUM_WORKERS = min(len(PROXIES) * WORKERS_PER_PROXY, WORKERS)

SEARCH_HASH = "dea90d34a7ee20d54354f1bf3171a65c36b9f242401494d56451d468d516125e"
PARTNER_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "app-platform": "WebPlayer",
    "spotify-app-version": "1.2.49.454",
}

_proxy_cycle = itertools.cycle(PROXIES)
_proxy_lock = threading.Lock()


def next_proxy():
    with _proxy_lock:
        return next(_proxy_cycle)


def get_token(artist_id: str, proxy: str):
    """Get token from embed endpoint."""
    try:
        r = requests.get(
            f"https://open.spotify.com/embed/artist/{artist_id}",
            headers={"User-Agent": "Mozilla/5.0"},
            proxies={"http": proxy, "https": proxy},
            timeout=5,
        )
        m = re.search(
            r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL
        )
        if not m:
            return None
        data = json.loads(m.group(1))
        return data["props"]["pageProps"]["state"]["settings"]["session"]["accessToken"]
    except Exception:
        return None


def get_albums(artist_name: str, token: str, proxy: str) -> list:
    """Get albums via partner API with metadata."""
    try:
        r = requests.get(
            "https://api-partner.spotify.com/pathfinder/v1/query",
            params={
                "operationName": "searchSuggestions",
                "variables": json.dumps(
                    {
                        "query": f"{artist_name} album",
                        "limit": 50,
                        "numberOfTopResults": 50,
                        "offset": 0,
                    }
                ),
                "extensions": json.dumps(
                    {"persistedQuery": {"version": 1, "sha256Hash": SEARCH_HASH}}
                ),
            },
            headers={"Authorization": f"Bearer {token}", **PARTNER_HEADERS},
            proxies={"http": proxy, "https": proxy},
            timeout=5,
        )
        if r.status_code != 200:
            return []

        items = (
            r.json()
            .get("data", {})
            .get("searchV2", {})
            .get("topResultsV2", {})
            .get("itemsV2", [])
        )
        albums = []
        for item in items:
            d = item.get("item", {}).get("data", {})
            if d.get("__typename") == "Album" and len(albums) < 10:
                uri = d.get("uri", "")
                album_id = uri.split(":")[-1] if ":" in uri else None
                albums.append(
                    {
                        "name": d.get("name", "?"),
                        "id": album_id,
                        "release_year": d.get("date", {}).get("year"),
                        "cover_url": (
                            d.get("coverArt", {}).get("sources", [{}])[0].get("url")
                            if d.get("coverArt", {}).get("sources")
                            else None
                        ),
                    }
                )
        return albums
    except Exception:
        return []


def get_songs(album_id: str, proxy: str) -> tuple:
    """Get tracks from album page with metadata. Extracts artist monthly listeners."""
    try:
        r = requests.get(
            f"https://open.spotify.com/album/{album_id}",
            headers={"User-Agent": "Mozilla/5.0"},
            proxies={"http": proxy, "https": proxy},
            timeout=10,
        )

        m = re.search(
            r'<script[^>]*id="initialState"[^>]*>(.*?)</script>', r.text, re.DOTALL
        )
        if not m:
            return [], {}

        content = m.group(1)
        decoded = base64.b64decode(content)
        data = json.loads(decoded)

        album_uri = f"spotify:album:{album_id}"
        album_obj = data.get("entities", {}).get("items", {}).get(album_uri, {})

        # Extract album metadata
        album_meta = {
            "release_year": album_obj.get("date", {}).get("year"),
            "total_tracks": len(album_obj.get("tracksV2", {}).get("items", [])),
            "cover_url": (
                album_obj.get("coverArt", {}).get("sources", [{}])[0].get("url")
                if album_obj.get("coverArt", {}).get("sources")
                else None
            ),
        }

        # Extract artist monthly listeners from album artists
        artists = album_obj.get("artists", {}).get("items", [])
        artist_monthly_listeners = None
        if artists:
            artist_monthly_listeners = (
                artists[0].get("stats", {}).get("monthlyListeners")
            )

        tracksv2 = album_obj.get("tracksV2", {})
        songs = []
        for track_item in tracksv2.get("items", []):
            track_data = track_item.get("track", {})
            songs.append(
                {
                    "id": track_data.get("id", "?"),
                    "name": track_data.get("name", "?"),
                    "duration_ms": track_data.get("duration", {}).get(
                        "totalMilliseconds"
                    ),
                }
            )

        album_meta["artist_monthly_listeners"] = artist_monthly_listeners
        return songs, album_meta
    except Exception:
        return [], {}


_stats = {"processed": 0, "albums": 0, "songs": 0, "failed": 0}
_stats_lock = threading.Lock()
_csv_lock = threading.Lock()


def worker(worker_id, queue):
    """Process artists from queue."""
    token = None
    token_refresh_count = 0

    while True:
        try:
            artist_info = queue.get_nowait()
        except Exception:
            break

        artist_name, spotify_id = artist_info

        # Refresh token periodically
        if token_refresh_count % 20 == 0 or not token:
            proxy = next_proxy()
            token = get_token(spotify_id, proxy)
            token_refresh_count = 0
            if not token:
                with _stats_lock:
                    _stats["failed"] += 1
                queue.task_done()
                continue

        proxy = next_proxy()
        time.sleep(RATE_DELAY)

        # Get albums
        albums = get_albums(artist_name, token, proxy)
        if not albums:
            with _stats_lock:
                _stats["processed"] += 1
            queue.task_done()
            continue

        # Get songs for each album and write to CSV
        rows = []
        for album in albums:
            proxy = next_proxy()
            time.sleep(RATE_DELAY)
            songs, album_meta = get_songs(album["id"], proxy)
            artist_monthly_listeners = album_meta.get("artist_monthly_listeners")
            for song in songs:
                rows.append(
                    [
                        spotify_id,
                        artist_name,
                        artist_monthly_listeners,
                        album["id"],
                        album["name"],
                        album.get("release_year", ""),
                        album.get("cover_url", ""),
                        song["id"],
                        song["name"],
                        song.get("duration_ms", ""),
                    ]
                )
            with _stats_lock:
                _stats["albums"] += 1
                _stats["songs"] += len(songs)

        # Write rows to CSV
        if rows:
            with _csv_lock:
                with OUT_FILE.open("a", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerows(rows)

        with _stats_lock:
            _stats["processed"] += 1
            if _stats["processed"] % 10 == 0:
                print(
                    f"  {_stats['processed']} artists, {_stats['albums']} albums, {_stats['songs']} songs"
                )

        token_refresh_count += 1
        queue.task_done()


def run():
    # Read artists
    artists = []
    with IN_FILE.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            artists.append((row["artist"], row["spotify_id"]))

    print(f"Loaded {len(artists)} artists from {IN_FILE}")

    # Track already-processed artists
    processed_ids = set()
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    if OUT_FILE.exists():
        with OUT_FILE.open() as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row and row.get("artist_id"):
                    processed_ids.add(row["artist_id"])
        print(f"Found {len(processed_ids)} artists already processed")
        # Filter out processed artists
        artists = [(name, sid) for name, sid in artists if sid not in processed_ids]
        print(f"Remaining artists to process: {len(artists)}")
    else:
        # Write fresh header
        with OUT_FILE.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(
                [
                    "artist_id",
                    "artist_name",
                    "artist_monthly_listeners",
                    "album_id",
                    "album_name",
                    "album_release_year",
                    "album_cover_url",
                    "track_id",
                    "track_name",
                    "track_duration_ms",
                ]
            )

    print(f"Starting {NUM_WORKERS} workers\n")

    # Queue artists
    queue = Queue()
    for artist in artists:
        queue.put(artist)

    # Start workers
    threads = []
    for i in range(NUM_WORKERS):
        t = threading.Thread(target=worker, args=(i, queue), daemon=False)
        t.start()
        threads.append(t)

    # Wait for completion
    for t in threads:
        t.join()

    print(f"\n{'=' * 80}")
    print("Complete!")
    print(f"  Artists processed: {_stats['processed']}")
    print(f"  Albums found: {_stats['albums']}")
    print(f"  Songs found: {_stats['songs']}")
    print(f"  Failed: {_stats['failed']}")
    print(f"  Output: {OUT_FILE}")


if __name__ == "__main__":
    run()
