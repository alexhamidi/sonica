"""Spotify public-profile scrape → top artists that exist as ready grandparents."""

from __future__ import annotations

import base64
import json
import os
import re
from collections import Counter

import psycopg2
import requests


def user_id_from_profile_url(url: str) -> str:
    m = re.search(r"/user/([a-zA-Z0-9]+)", url)
    if not m:
        raise ValueError(f"Cannot parse user id from: {url}")
    return m.group(1)


def fetch_user_public_playlist_ids(user_id: str) -> tuple[str, list[str]]:
    r = requests.get(
        f"https://open.spotify.com/user/{user_id}",
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=15,
    )
    r.raise_for_status()
    m = re.search(
        r'<script[^>]*id="initialState"[^>]*>(.*?)</script>', r.text, re.DOTALL
    )
    if not m:
        raise RuntimeError(f"Could not find initialState for user/{user_id}")

    data = json.loads(base64.b64decode(m.group(1).strip()))
    user_uri = f"spotify:user:{user_id}"
    user_obj = ((data.get("entities") or {}).get("items") or {}).get(user_uri)
    if not user_obj:
        raise RuntimeError(
            f"User {user_id} missing from page state (invalid id or profile unavailable)"
        )

    display_name = user_obj.get("name") or user_id
    p2 = user_obj.get("publicPlaylistsV2") or {}
    ids: list[str] = []
    for item in p2.get("items") or []:
        pdata = item.get("data") or {}
        u = pdata.get("uri") or ""
        if "playlist:" in u:
            ids.append(u.split("playlist:")[-1])
    return display_name, ids


def fetch_playlist_tracks(playlist_id: str) -> tuple[str, list[dict]]:
    url = f"https://open.spotify.com/embed/playlist/{playlist_id}"
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    m = re.search(
        r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL
    )
    if not m:
        raise RuntimeError(f"Could not find __NEXT_DATA__ for playlist/{playlist_id}")
    entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
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
                {"title": title, "artist": artist, "spotify_id": spotify_id}
            )
    return name, tracks


def _names_from_embed_subtitle(subtitle: str) -> list[str]:
    s = subtitle.strip()
    if not s:
        return []
    parts = re.split(r"\s*(?:,|，|·|&|\sfeat\.|\sft\.)+\s*", s, flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


def _ready_artist_name_index(conn) -> dict[str, tuple[str, str, str]]:
    """lower(name) -> (grandparent_id, spotify_id, display_name)."""
    out: dict[str, tuple[str, str, str]] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, spotify_id, name
            FROM grandparents
            WHERE status = 'ready' AND type = 'artist' AND name IS NOT NULL
            """
        )
        for gp_id, spotify_id, name in cur.fetchall():
            key = (name or "").strip().lower()
            sid = str(spotify_id) if spotify_id else ""
            if key and key not in out:
                out[key] = (gp_id, sid, (name or "").strip())
    return out


def top_catalog_artists_for_profile_url(
    profile_url: str,
    *,
    limit: int = 5,
    postgres_url: str | None = None,
) -> tuple[str, list[dict]]:
    """
    Returns (spotify_profile_display_name, rows) where each row has:
        grandparent_id, spotify_id, name, track_count
    """
    url = postgres_url or os.environ.get("POSTGRES_URL")
    if not url:
        raise RuntimeError("POSTGRES_URL is not set")

    uid = user_id_from_profile_url(profile_url)
    display_name, playlist_ids = fetch_user_public_playlist_ids(uid)

    conn = psycopg2.connect(url)
    try:
        by_name = _ready_artist_name_index(conn)
    finally:
        conn.close()

    seen_track_keys: set[str] = set()
    catalog_hits: Counter[str] = Counter()
    meta: dict[str, tuple[str, str]] = {}  # gp_id -> (spotify_id, name)

    for pl_id in playlist_ids:
        try:
            _pl_name, tracks = fetch_playlist_tracks(pl_id)
        except Exception:
            continue
        for t in tracks:
            tid = t.get("spotify_id")
            key = tid if tid else f"{t.get('title', '')}|{t.get('artist', '')}"
            if key in seen_track_keys:
                continue
            seen_track_keys.add(key)

            for raw_name in _names_from_embed_subtitle(t.get("artist") or ""):
                row = by_name.get(raw_name.lower())
                if not row:
                    continue
                gp_id, sid, gname = row
                meta[gp_id] = (sid, gname)
                catalog_hits[gp_id] += 1

    ranked = catalog_hits.most_common()
    out: list[dict] = []
    for gp_id, c in ranked[:limit]:
        sid, gname = meta.get(gp_id, ("", ""))
        out.append(
            {
                "grandparent_id": gp_id,
                "spotify_id": sid,
                "name": gname,
                "track_count": c,
            }
        )
    return display_name, out
