#!/usr/bin/env python3
"""
Spotify metadata fetching, DB helpers, and projection computation.

add_to_canvas()         — unified add: resolve grandparent, upsert parents, link user, return pending tasks
ingest_parent()         — fetch tracks for a single parent (album or playlist) and queue for download
finalize_grandparent()  — marks grandparent/parents ready when all tracks complete, triggers projection
project_grandparent()   — recomputes UMAP+PCA for all users who have this grandparent
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
from typing import Dict, List, Optional, Tuple

import boto3
import numpy as np
import psycopg2
import psycopg2.extras
import requests
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image
from sklearn.decomposition import PCA
import umap

load_dotenv()

# ── config ─────────────────────────────────────────────────────────────────────

S3_BUCKET = os.environ["S3_BUCKET"]
POSTGRES_URL = os.environ["POSTGRES_URL"]
GEMINI_PROJECT_ID = os.getenv("GEMINI_PROJECT_ID", "sitescroll")
GEMINI_LOCATION = os.getenv("GEMINI_LOCATION", "us-central1")
EMBEDDING_MODEL = "gemini-embedding-2-preview"
COVER_SIZE = 256
ORPHANS_ID = "00000000-0000-0000-0000-000000000002"

_PROXIES = [
    "http://ynpchsii:hnnja2wzr8m9@82.29.143.182:7896",
    "http://ynpchsii:hnnja2wzr8m9@82.21.35.247:8007",
    "http://ynpchsii:hnnja2wzr8m9@9.142.40.203:6873",
    "http://ynpchsii:hnnja2wzr8m9@150.241.111.253:6757",
    "http://ynpchsii:hnnja2wzr8m9@9.142.215.3:6168",
    "http://ynpchsii:hnnja2wzr8m9@216.98.254.66:6376",
    "http://ynpchsii:hnnja2wzr8m9@136.0.167.109:7112",
    "http://ynpchsii:hnnja2wzr8m9@9.142.198.207:5874",
    "http://ynpchsii:hnnja2wzr8m9@138.226.88.249:7937",
    "http://ynpchsii:hnnja2wzr8m9@9.142.34.159:6830",
    "http://ynpchsii:hnnja2wzr8m9@45.56.183.205:8527",
    "http://ynpchsii:hnnja2wzr8m9@192.53.70.229:5943",
    "http://ynpchsii:hnnja2wzr8m9@138.226.89.36:7224",
    "http://ynpchsii:hnnja2wzr8m9@192.46.190.109:6702",
    "http://ynpchsii:hnnja2wzr8m9@192.53.66.38:6144",
    "http://ynpchsii:hnnja2wzr8m9@9.142.218.133:6797",
    "http://ynpchsii:hnnja2wzr8m9@82.21.33.189:7940",
    "http://ynpchsii:hnnja2wzr8m9@104.253.111.254:6032",
    "http://ynpchsii:hnnja2wzr8m9@31.98.8.172:5850",
    "http://ynpchsii:hnnja2wzr8m9@192.46.185.132:5822",
]
_proxy_index = 0
_proxy_lock = threading.Lock()


def _next_proxy() -> str:
    global _proxy_index
    with _proxy_lock:
        proxy = _PROXIES[_proxy_index % len(_PROXIES)]
        _proxy_index += 1
    return proxy


s3_client = boto3.client("s3")
gemini_client = genai.Client(
    vertexai=True, project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION
)


# ── URL parsing ────────────────────────────────────────────────────────────────


def get_entity_type(url: str) -> str:
    if "/playlist/" in url:
        return "playlist"
    if "/album/" in url:
        return "album"
    if "/artist/" in url:
        return "artist"
    if "/user/" in url:
        return "user"
    raise ValueError(f"Unsupported Spotify URL: {url}")


def get_spotify_id(url: str, entity_type: str) -> str:
    m = re.search(rf"{entity_type}/([a-zA-Z0-9]+)", url)
    if not m:
        raise ValueError(f"Cannot parse {entity_type} id from: {url}")
    return m.group(1)


# ── Spotify scraping ───────────────────────────────────────────────────────────


def _fetch_embed(entity_type: str, entity_id: str) -> dict:
    url = f"https://open.spotify.com/embed/{entity_type}/{entity_id}"
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL)
    if not m:
        raise RuntimeError(
            f"Could not find __NEXT_DATA__ for {entity_type}/{entity_id}"
        )
    return json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]


def fetch_playlist_tracks(playlist_id: str) -> Tuple[str, List[Dict]]:
    entity = _fetch_embed("playlist", playlist_id)
    name = entity.get("name") or "Playlist"
    tracks = []
    for t in entity.get("trackList") or []:
        if t.get("entityType") != "track":
            continue
        title = t.get("title", "").strip()
        artist = t.get("subtitle", "").strip()
        uri = t.get("uri", "")
        spotify_id = uri.split(":")[-1] if uri else None
        if title and artist:
            tracks.append(
                {
                    "title": title,
                    "artist": artist,
                    "spotify_id": spotify_id,
                    "cover_url": None,
                }
            )
    return name, tracks


def fetch_album_tracks(
    album_id: str, proxy: str | None = None
) -> Tuple[str, Optional[str], List[Dict]]:
    """
    Scrape album page initialState for full track listing.
    Returns (album_name, cover_url, tracks).
    """
    proxies = {"http": proxy, "https": proxy} if proxy else None
    r = requests.get(
        f"https://open.spotify.com/album/{album_id}",
        headers={"User-Agent": "Mozilla/5.0"},
        proxies=proxies,
        timeout=10,
    )
    r.raise_for_status()
    m = re.search(
        r'<script[^>]*id="initialState"[^>]*>(.*?)</script>', r.text, re.DOTALL
    )
    if not m:
        return "Album", None, []

    data = json.loads(base64.b64decode(m.group(1).strip()))
    album_uri = f"spotify:album:{album_id}"
    album_obj = data.get("entities", {}).get("items", {}).get(album_uri, {})

    album_name = album_obj.get("name") or "Album"
    sources = (album_obj.get("coverArt") or {}).get("sources") or []
    cover_url = sources[0].get("url") if sources else None
    artist_items = (album_obj.get("artists") or {}).get("items") or []
    album_artist = (
        (artist_items[0].get("profile") or {}).get("name") if artist_items else None
    )

    tracks = []
    for item in (album_obj.get("tracksV2") or {}).get("items") or []:
        track_data = item.get("track") or {}
        track_artist_items = (track_data.get("artists") or {}).get("items") or []
        artist = (
            (track_artist_items[0].get("profile") or {}).get("name")
            if track_artist_items
            else album_artist
        ) or ""
        title = track_data.get("name") or ""
        track_id = track_data.get("id")
        if title and artist:
            tracks.append(
                {
                    "title": title,
                    "artist": artist,
                    "spotify_id": track_id,
                    "cover_url": cover_url,
                    "duration_ms": (track_data.get("duration") or {}).get(
                        "totalMilliseconds"
                    ),
                }
            )
    return album_name, cover_url, tracks


def fetch_artist_albums(artist_id: str) -> Tuple[str, Optional[str], List[Dict]]:
    """
    Returns (artist_name, artist_cover_url, albums).
    Each album: {name, spotify_id, cover_url, tracks: [...]}.
    """
    from name import (
        _fetch_embed_entity,
        _cover_url,
        _fetch_artist_albums as _name_albums,
    )

    entity, token = _fetch_embed_entity("artist", artist_id)
    artist_name = entity.get("name") or "Artist"
    artist_cover = _cover_url(entity)

    try:
        raw_albums = _name_albums(artist_id, token)
    except Exception as e:
        print(f"[ingest] failed to fetch albums for {artist_id}: {e}")
        raw_albums = []

    albums = []
    for album in raw_albums:
        album_id = album["url"].rstrip("/").split("/")[-1].split("?")[0]
        proxy = _next_proxy()
        try:
            album_name, cover_url, tracks = fetch_album_tracks(album_id, proxy)
        except Exception as e:
            print(f"[ingest] failed to fetch tracks for album {album_id}: {e}")
            continue
        if not tracks:
            continue
        albums.append(
            {
                "name": album_name,
                "spotify_id": album_id,
                "cover_url": cover_url or album.get("cover"),
                "tracks": tracks,
            }
        )
    return artist_name, artist_cover, albums


# ── DB helpers ─────────────────────────────────────────────────────────────────


def update_grandparent_status(conn, grandparent_id: str, status: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "UPDATE grandparents SET status = %s WHERE id = %s", (status, grandparent_id)
    )
    conn.commit()
    cur.close()


def update_parent_status(conn, parent_id: str, status: str) -> None:
    cur = conn.cursor()
    cur.execute("UPDATE parents SET status = %s WHERE id = %s", (status, parent_id))
    conn.commit()
    cur.close()


def store_grandparent(conn, spotify_id: str, name: str, gp_type: str) -> str:
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO grandparents (spotify_id, type, name, status)
           VALUES (%s, %s, %s, 'pending')
           ON CONFLICT (spotify_id) DO UPDATE SET name = EXCLUDED.name, status = 'pending'
           RETURNING id""",
        (spotify_id, gp_type, name),
    )
    gp_id = str(cur.fetchone()[0])
    conn.commit()
    cur.close()
    return gp_id


def store_parent(
    conn, spotify_id: str, name: str, parent_type: str, grandparent_id: str
) -> str:
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO parents (spotify_id, type, name, status, grandparent_id)
           VALUES (%s, %s, %s, 'pending', %s)
           ON CONFLICT (spotify_id) DO UPDATE
               SET name = EXCLUDED.name, status = 'pending', grandparent_id = EXCLUDED.grandparent_id
           RETURNING id""",
        (spotify_id, parent_type, name, grandparent_id),
    )
    parent_id = str(cur.fetchone()[0])
    conn.commit()
    cur.close()
    return parent_id


def link_user_to_grandparent(conn, user_id: str, grandparent_id: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO user_grandparents (user_id, grandparent_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (user_id, grandparent_id),
    )
    conn.commit()
    cur.close()


def queue_track(conn, parent_id: str, track: Dict) -> str | None:
    """
    Ensure a track exists (deduplicated by deezer_id) and link it to the parent.
    Returns the track id, or None if the track couldn't be created.
    """
    cur = conn.cursor()
    deezer_id = track.get("deezer_id")
    track_id = None

    if deezer_id:
        cur.execute("SELECT id, status FROM tracks WHERE deezer_id = %s", (deezer_id,))
        existing = cur.fetchone()
        if existing:
            track_id = str(existing[0])
            if existing[1] == "queued":
                cur.execute(
                    "UPDATE tracks SET status = 'user_queued' WHERE id = %s",
                    (existing[0],),
                )

    if not track_id:
        cur.execute(
            """INSERT INTO tracks (title, artist, spotify_id, album_cover_url, isrc, deezer_id, status)
               VALUES (%s, %s, %s, %s, %s, %s, 'user_queued')
               ON CONFLICT DO NOTHING
               RETURNING id""",
            (
                track["title"],
                track["artist"],
                track.get("spotify_id"),
                track.get("cover_url"),
                track.get("isrc"),
                deezer_id,
            ),
        )
        row = cur.fetchone()
        if row:
            track_id = str(row[0])
        elif deezer_id:
            cur.execute("SELECT id FROM tracks WHERE deezer_id = %s", (deezer_id,))
            track_id = str(cur.fetchone()[0])

    if track_id:
        cur.execute(
            "INSERT INTO parent_tracks (parent_id, track_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (parent_id, track_id),
        )
    conn.commit()
    cur.close()
    return track_id


# ── Deezer ID resolution ──────────────────────────────────────────────────────


def resolve_track_ids(tracks: List[Dict]) -> List[Dict]:
    """
    Resolve deezer_id for each track via the Deezer search API (artist + title).
    Uses proxy rotation to avoid rate limits. Mutates and returns the tracks list.
    """
    import time

    todo = [t for t in tracks if not t.get("deezer_id")]
    if not todo:
        return tracks

    proxy_idx = 0
    resolved = 0
    for track in todo:
        artist = track.get("artist", "")
        title = track.get("title", "")
        if not artist or not title:
            continue

        proxy = _PROXIES[proxy_idx % len(_PROXIES)]
        proxy_idx += 1
        try:
            resp = requests.get(
                "https://api.deezer.com/search",
                params={"q": f'artist:"{artist}" track:"{title}"'},
                headers={"User-Agent": "Mozilla/5.0"},
                proxies={"http": proxy, "https": proxy},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("data"):
                    track["deezer_id"] = data["data"][0]["id"]
                    isrc = data["data"][0].get("isrc")
                    if isrc:
                        track["isrc"] = isrc
                    resolved += 1
            elif resp.status_code == 429:
                time.sleep(2)
        except Exception:
            pass

    print(f"[ingest] resolved {resolved}/{len(todo)} Deezer IDs via search")
    return tracks


# ── Cover helpers ──────────────────────────────────────────────────────────────


def _fetch_spotify_cover(cover_url: str | None) -> Optional[bytes]:
    if not cover_url:
        return None
    try:
        r = requests.get(cover_url, timeout=5, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            return None
        with Image.open(io.BytesIO(r.content)) as img:
            img = img.convert("RGB").resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        print(f"[ingest] cover fetch failed: {e}")
        return None


def _store_remote_cover(conn, table: str, row_id: str, cover_url: str) -> None:
    """Download, resize, upload to S3, set cover_s3 on the row."""
    cover_bytes = _fetch_spotify_cover(cover_url)
    if not cover_bytes:
        return
    try:
        key = f"covers/{row_id}.jpg"
        s3_client.put_object(
            Bucket=S3_BUCKET, Key=key, Body=cover_bytes, ContentType="image/jpeg"
        )
        cur = conn.cursor()
        cur.execute(
            f"UPDATE {table} SET cover_s3 = %s WHERE id = %s AND cover_s3 IS NULL",
            (key, row_id),
        )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"[ingest] cover upload failed for {row_id}: {e}")


# ── Projections ───────────────────────────────────────────────────────────────


def _normalize(coords: np.ndarray) -> np.ndarray:
    lo, hi = coords.min(axis=0), coords.max(axis=0)
    rng = hi - lo
    rng[rng == 0] = 1
    return (coords - lo) / rng


def compute_projections(embeddings: np.ndarray) -> Dict[str, np.ndarray]:
    from sklearn.preprocessing import normalize as sk_normalize

    n = len(embeddings)
    if n < 2:
        placeholder = np.array([[0.5, 0.5]] * n)
        return {"umap": placeholder, "pca": placeholder}

    # L2-normalize: cosine similarity == euclidean on unit sphere, faster for UMAP
    normed = sk_normalize(embeddings, norm="l2")

    result: Dict[str, np.ndarray] = {}
    try:
        reducer = umap.UMAP(
            n_components=2,
            n_neighbors=min(15, n - 1),
            min_dist=0.1,
            metric="euclidean",
            n_jobs=-1,
        )
        result["umap"] = _normalize(reducer.fit_transform(normed))
    except Exception as e:
        print(f"UMAP failed: {e}")
    try:
        result["pca"] = _normalize(PCA(n_components=2).fit_transform(normed))
    except Exception as e:
        print(f"PCA failed: {e}")
    try:
        from sklearn.manifold import TSNE

        result["tsne"] = _normalize(
            TSNE(
                n_components=2, perplexity=min(30, n - 1), random_state=42, n_jobs=-1
            ).fit_transform(normed)
        )
    except Exception as e:
        print(f"t-SNE failed: {e}")
    return result


# ── Per-user projection ────────────────────────────────────────────────────────


def project_grandparent(grandparent_id: str) -> None:
    """
    Full recompute of UMAP+PCA for every user who has projected=false for this grandparent.
    Projects over the user's entire ready track set, replacing old coordinates.
    """
    conn = psycopg2.connect(POSTGRES_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT status FROM grandparents WHERE id = %s::uuid",
            (grandparent_id,),
        )
        gp = cur.fetchone()
        if not gp or gp["status"] != "ready":
            return

        cur.execute(
            "SELECT user_id::text FROM user_grandparents WHERE grandparent_id = %s AND projected = false",
            (grandparent_id,),
        )
        users = [r["user_id"] for r in cur.fetchall()]

        for user_id in users:
            cur.execute(
                """SELECT DISTINCT t.id::text, t.embedding::text
                   FROM user_parents up
                   JOIN parents p ON p.id = up.parent_id AND p.status = 'ready'
                   JOIN parent_tracks pt ON pt.parent_id = p.id
                   JOIN tracks t ON t.id = pt.track_id
                   WHERE up.user_id::text = %s
                     AND t.status IN ('complete', 'ready')
                     AND t.embedding IS NOT NULL""",
                (user_id,),
            )
            rows = cur.fetchall()
            if not rows:
                continue

            ids = [r["id"] for r in rows]
            embeddings = np.array(
                [list(map(float, r["embedding"].strip("[]").split(","))) for r in rows],
                dtype=np.float32,
            )
            projections = compute_projections(embeddings)
            umap_coords = projections.get("umap")
            pca_coords = projections.get("pca")
            tsne_coords = projections.get("tsne")

            cur.execute(
                "DELETE FROM user_track_projections WHERE user_id = %s::uuid",
                (user_id,),
            )
            psycopg2.extras.execute_values(
                cur,
                """INSERT INTO user_track_projections (user_id, track_id, umap_x, umap_y, pca_x, pca_y, tsne_x, tsne_y)
                   VALUES %s""",
                [
                    (
                        user_id,
                        track_id,
                        round(float(umap_coords[i, 0]), 6)
                        if umap_coords is not None
                        else None,
                        round(float(umap_coords[i, 1]), 6)
                        if umap_coords is not None
                        else None,
                        round(float(pca_coords[i, 0]), 6)
                        if pca_coords is not None
                        else None,
                        round(float(pca_coords[i, 1]), 6)
                        if pca_coords is not None
                        else None,
                        round(float(tsne_coords[i, 0]), 6)
                        if tsne_coords is not None
                        else None,
                        round(float(tsne_coords[i, 1]), 6)
                        if tsne_coords is not None
                        else None,
                    )
                    for i, track_id in enumerate(ids)
                ],
                template="(%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s)",
            )
            cur.execute(
                """UPDATE user_grandparents ug SET projected = true
                   FROM grandparents gp
                   WHERE ug.grandparent_id = gp.id
                     AND ug.user_id::text = %s
                     AND gp.status = 'ready'""",
                (user_id,),
            )
            conn.commit()
            print(f"[ingest] projected {len(ids)} tracks for user {user_id[:8]}")

        cur.close()
    finally:
        conn.close()


def finalize_grandparent(grandparent_id: str) -> None:
    """
    Mark parents/grandparent ready once all their tracks are complete,
    then trigger projection for any users who have this grandparent.
    """
    conn = psycopg2.connect(POSTGRES_URL)
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE parents SET status = 'ready'
               WHERE grandparent_id = %s::uuid
                 AND status != 'ready'
                 AND NOT EXISTS (
                     SELECT 1 FROM parent_tracks pt
                     JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.parent_id = parents.id
                       AND t.status IN ('user_queued', 'downloading', 'embedding')
                 )
                 AND EXISTS (
                     SELECT 1 FROM parent_tracks pt
                     JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.parent_id = parents.id
                       AND t.status IN ('complete', 'ready')
                 )""",
            (grandparent_id,),
        )
        cur.execute(
            """UPDATE grandparents SET status = 'ready'
               WHERE id = %s::uuid
                 AND status != 'ready'
                 AND NOT EXISTS (
                     SELECT 1 FROM parents p WHERE p.grandparent_id = %s::uuid
                       AND p.status NOT IN ('ready', 'error')
                 )
                 AND EXISTS (SELECT 1 FROM parents p WHERE p.grandparent_id = %s::uuid)""",
            (grandparent_id, grandparent_id, grandparent_id),
        )
        conn.commit()
        cur.close()
    finally:
        conn.close()

    try:
        project_grandparent(grandparent_id)
    except Exception as e:
        print(f"[ingest] project_grandparent failed for {grandparent_id}: {e}")


# ── Embedding ─────────────────────────────────────────────────────────────────


def embed_query(
    text: str | None = None,
    audio_bytes: bytes | None = None,
    mime_type: str = "audio/wav",
) -> List[float]:
    if text:
        part = types.Part(text=text)
    elif audio_bytes:
        part = types.Part.from_bytes(data=audio_bytes, mime_type=mime_type)
    else:
        raise ValueError("Provide text or audio_bytes")
    result = gemini_client.models.embed_content(model=EMBEDDING_MODEL, contents=[part])
    return result.embeddings[0].values


# ── Entry points ───────────────────────────────────────────────────────────────


def _ensure_user_grandparent(conn, user_url: str, user_id: str) -> str:
    uid = get_spotify_id(user_url, "user")
    cur = conn.cursor()
    cur.execute("SELECT id FROM grandparents WHERE spotify_id = %s", (uid,))
    row = cur.fetchone()
    cur.close()
    if row:
        return str(row[0])
    display_name, avatar_url = uid, None
    try:
        from name import _fetch_user_playlists

        display_name, avatar_url, _ = _fetch_user_playlists(uid)
    except Exception:
        pass
    gp_id = store_grandparent(conn, uid, display_name, "user")
    if avatar_url:
        _store_remote_cover(conn, "grandparents", gp_id, avatar_url)
    return gp_id


def ingest_parent(parent_id: str, url: str) -> None:
    """Fetch tracks for a single parent (album or playlist) and queue for download."""
    entity_type = get_entity_type(url)
    spotify_id = get_spotify_id(url, entity_type)

    conn = psycopg2.connect(POSTGRES_URL)
    try:
        update_parent_status(conn, parent_id, "fetching")
        if entity_type == "album":
            name, cover_url, tracks = fetch_album_tracks(spotify_id)
            if cover_url:
                _store_remote_cover(conn, "parents", parent_id, cover_url)
        else:
            name, tracks = fetch_playlist_tracks(spotify_id)
            cover_url = None

        cur = conn.cursor()
        cur.execute("UPDATE parents SET name = %s WHERE id = %s", (name, parent_id))
        conn.commit()
        cur.close()

        tracks = resolve_track_ids(tracks)
        linked = sum(1 for t in tracks if queue_track(conn, parent_id, t))
        with_deezer = sum(1 for t in tracks if t.get("deezer_id"))
        print(f"[ingest] {name}: linked {linked}/{len(tracks)} tracks ({with_deezer} with deezer_id)")
    except Exception as e:
        import traceback

        print(f"[ingest] ingest_parent failed for {parent_id}: {e}")
        traceback.print_exc()
        try:
            update_parent_status(conn, parent_id, "error")
        except Exception:
            pass
    finally:
        conn.close()


def link_user_to_parent(conn, user_id: str, parent_id: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO user_parents (user_id, parent_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (user_id, parent_id),
    )
    conn.commit()
    cur.close()


def add_to_canvas(
    user_id: str,
    grandparent_id: str | None = None,
    grandparent_url: str | None = None,
    parent_urls: list[str] | None = None,
) -> tuple[dict, list[tuple]]:
    """
    Unified add: resolve grandparent, upsert parents, link user, queue ingest as needed.
    Returns {"grandparentId": str, "parents": [{"id": str, "status": str}]}.
    """
    conn = psycopg2.connect(POSTGRES_URL)
    try:
        # 1. Resolve grandparent
        if grandparent_id:
            gp_id = grandparent_id
        elif grandparent_url:
            gp_type = get_entity_type(grandparent_url)
            if gp_type == "user":
                gp_id = _ensure_user_grandparent(conn, grandparent_url, user_id)
            elif gp_type == "artist":
                spotify_id = get_spotify_id(grandparent_url, "artist")
                cur = conn.cursor()
                cur.execute(
                    "SELECT id FROM grandparents WHERE spotify_id = %s", (spotify_id,)
                )
                row = cur.fetchone()
                cur.close()
                if row:
                    gp_id = str(row[0])
                else:
                    gp_id = store_grandparent(conn, spotify_id, "Loading...", "artist")
                    try:
                        from name import _fetch_embed_entity, _cover_url

                        entity, _ = _fetch_embed_entity("artist", spotify_id)
                        artist_name = entity.get("name") or "Artist"
                        cur = conn.cursor()
                        cur.execute(
                            "UPDATE grandparents SET name = %s WHERE id = %s",
                            (artist_name, gp_id),
                        )
                        conn.commit()
                        cur.close()
                        if cv := _cover_url(entity):
                            _store_remote_cover(conn, "grandparents", gp_id, cv)
                    except Exception as e:
                        print(f"[ingest] artist metadata prefetch failed: {e}")
            else:
                raise ValueError(f"Unsupported grandparent URL type: {gp_type}")
        else:
            gp_id = ORPHANS_ID

        # 2. Link user to grandparent
        link_user_to_grandparent(conn, user_id, gp_id)

        # 3. Resolve parents
        if parent_urls:
            parent_results = []
            ingest_queue = []

            for url in parent_urls:
                etype = get_entity_type(url)
                if etype not in ("album", "playlist"):
                    raise ValueError(f"Parent URL must be an album or playlist: {url}")
                spotify_id = get_spotify_id(url, etype)

                cur = conn.cursor()
                cur.execute(
                    "SELECT id, status FROM parents WHERE spotify_id = %s",
                    (spotify_id,),
                )
                row = cur.fetchone()
                cur.close()

                if row:
                    pid, status = str(row[0]), row[1]
                else:
                    ptype = "album" if etype == "album" else "playlist"
                    pid = store_parent(conn, spotify_id, "Loading...", ptype, gp_id)
                    status = "pending"
                    try:
                        from name import _fetch_embed_entity, _cover_url

                        entity, _ = _fetch_embed_entity(etype, spotify_id)
                        pname = entity.get("name") or etype.capitalize()
                        cur = conn.cursor()
                        cur.execute(
                            "UPDATE parents SET name = %s WHERE id = %s", (pname, pid)
                        )
                        conn.commit()
                        cur.close()
                        if cv := _cover_url(entity):
                            _store_remote_cover(conn, "parents", pid, cv)
                    except Exception as e:
                        print(f"[ingest] parent metadata prefetch failed: {e}")

                link_user_to_parent(conn, user_id, pid)

                if status in ("user_queued", "downloading", "fetching"):
                    pass
                elif status in ("error", "pending"):
                    ingest_queue.append((pid, url))

                parent_results.append({"id": pid, "status": status})

            pending_tasks = [(ingest_parent, pid, url) for pid, url in ingest_queue]

        else:
            # No parent_urls → add all existing parents under this grandparent
            cur = conn.cursor()
            cur.execute(
                "SELECT id, status FROM parents WHERE grandparent_id = %s", (gp_id,)
            )
            rows = cur.fetchall()
            cur.close()

            parent_results = []
            for row in rows:
                pid, status = str(row[0]), row[1]
                link_user_to_parent(conn, user_id, pid)
                parent_results.append({"id": pid, "status": status})

            pending_tasks = []

        # 4. Trigger projection
        has_ready = any(p["status"] == "ready" for p in parent_results)
        if has_ready:
            cur = conn.cursor()
            cur.execute(
                "UPDATE user_grandparents SET projected = false WHERE user_id = %s AND grandparent_id = %s",
                (user_id, gp_id),
            )
            conn.commit()
            cur.close()
            pending_tasks.append((project_grandparent, gp_id))

        return {"grandparentId": gp_id, "parents": parent_results}, pending_tasks
    finally:
        conn.close()
