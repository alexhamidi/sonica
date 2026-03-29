import base64
import json
import re

import requests

HEADERS = {"User-Agent": "Mozilla/5.0"}

# Persisted query hash for queryArtistDiscographyAlbums, extracted from the
# Spotify web player bundle (web-player.4e2257d3.js).
_DISCOGRAPHY_HASH = "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599"


def get_url_type(url: str) -> str | None:
    if re.search(r"/playlist/", url):
        return "playlist"
    if re.search(r"/artist/", url):
        return "artist"
    if re.search(r"/user/", url):
        return "user"
    return None


def _fetch_embed_entity(entity_type: str, entity_id: str) -> tuple[dict, str]:
    """Returns (entity_data, access_token) from the Spotify embed page."""
    url = f"https://open.spotify.com/embed/{entity_type}/{entity_id}"
    r = requests.get(url, headers=HEADERS)
    r.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL)
    data = json.loads(m.group(1))["props"]["pageProps"]
    entity = data["state"]["data"]["entity"]
    token = data["state"]["settings"]["session"]["accessToken"]
    return entity, token


def _cover_url(entity: dict) -> str | None:
    """Best cover URL from a Spotify embed entity (playlist or artist)."""
    sources = ((entity.get("coverArt") or {}).get("sources")) or []
    if sources:
        return sources[0].get("url")
    images = ((entity.get("visualIdentity") or {}).get("image")) or []
    if images:
        large = next((i for i in images if (i.get("maxWidth") or 0) >= 600), images[0])
        return large.get("url")
    return None


def _track_count(entity: dict) -> int:
    return sum(
        1 for t in (entity.get("trackList") or []) if t.get("entityType") == "track"
    )


def _fetch_artist_albums(artist_id: str, token: str) -> list[dict]:
    """Fetch albums for an artist via the Spotify partner GraphQL API."""
    r = requests.get(
        "https://api-partner.spotify.com/pathfinder/v1/query",
        params={
            "operationName": "queryArtistDiscographyAlbums",
            "variables": json.dumps(
                {
                    "uri": f"spotify:artist:{artist_id}",
                    "offset": 0,
                    "limit": 20,
                }
            ),
            "extensions": json.dumps(
                {"persistedQuery": {"version": 1, "sha256Hash": _DISCOGRAPHY_HASH}}
            ),
        },
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "Mozilla/5.0",
            "app-platform": "WebPlayer",
            "spotify-app-version": "1.2.49.454",
        },
    )
    r.raise_for_status()
    data = r.json()
    items = (
        data.get("data", {})
        .get("artistUnion", {})
        .get("discography", {})
        .get("albums", {})
        .get("items", [])
    )
    albums = []
    for item in items:
        for release in (item.get("releases") or {}).get("items", []):
            sources = (release.get("coverArt") or {}).get("sources") or []
            cover = next(
                (s["url"] for s in sources if s.get("width", 0) >= 600),
                sources[0]["url"] if sources else None,
            )
            albums.append(
                {
                    "name": release["name"],
                    "cover": cover,
                    "trackCount": (release.get("tracks") or {}).get("totalCount", 0),
                    "url": f"https://open.spotify.com/album/{release['id']}",
                }
            )
    return albums


def _user_avatar(user_entity: dict) -> str | None:
    """Best-effort extraction of avatar URL from a Spotify user entity."""
    # Try various known shapes Spotify uses
    for path in [
        lambda e: e.get("avatar", {}).get("sources"),
        lambda e: (e.get("visuals") or {}).get("avatarImage", {}).get("sources"),
        lambda e: ((e.get("images") or {}).get("items") or [{}])[0].get("sources"),
    ]:
        try:
            sources = path(user_entity) or []
            if sources:
                return sources[0]["url"]
        except Exception:
            pass
    return None


def _fetch_user_playlists(user_id: str) -> tuple[str, str | None, list[dict]]:
    """Returns (display_name, avatar_url, playlists) scraped from the user profile page."""
    r = requests.get(f"https://open.spotify.com/user/{user_id}", headers=HEADERS)
    r.raise_for_status()
    m = re.search(r'<script id="initialState"[^>]*>(.*?)</script>', r.text, re.DOTALL)
    if not m:
        raise ValueError("initialState not found on user page")
    data = json.loads(base64.b64decode(m.group(1).strip()))
    items = data.get("entities", {}).get("items", {})
    user_entity = next(iter(items.values()), {})
    display_name = user_entity.get("name") or user_id
    avatar = _user_avatar(user_entity)

    playlists = []
    for item in (user_entity.get("publicPlaylistsV2") or {}).get("items", []):
        pl = item.get("data") or {}
        uri = pl.get("uri") or item.get("_uri") or ""
        pid = uri.split(":")[-1]
        sources = ((pl.get("images") or {}).get("items") or [{}])[0].get(
            "sources"
        ) or []
        cover = sources[0]["url"] if sources else None
        playlists.append(
            {
                "name": pl.get("name") or "Playlist",
                "cover": cover,
                "trackCount": 0,
                "url": f"https://open.spotify.com/playlist/{pid}",
            }
        )

    return display_name, avatar, playlists


def resolve(url: str) -> dict | None:
    """Returns {name, type, entities: [{name, cover, trackCount, url}]}"""
    url_type = get_url_type(url)
    if not url_type:
        return None

    if url_type == "playlist":
        pid = re.search(r"playlist/([a-zA-Z0-9]+)", url).group(1)
        entity, _ = _fetch_embed_entity("playlist", pid)
        name = entity.get("name") or "Playlist"
        return {
            "name": name,
            "type": "playlist",
            "entities": [
                {
                    "name": name,
                    "cover": _cover_url(entity),
                    "trackCount": _track_count(entity),
                    "url": f"https://open.spotify.com/playlist/{pid}",
                }
            ],
        }

    elif url_type == "user":
        uid = re.search(r"user/([a-zA-Z0-9]+)", url).group(1)
        try:
            display_name, _avatar, playlists = _fetch_user_playlists(uid)
        except Exception:
            return None
        return {
            "name": display_name,
            "type": "user",
            "entities": playlists,
        }

    else:  # artist
        aid = re.search(r"artist/([a-zA-Z0-9]+)", url).group(1)
        entity, token = _fetch_embed_entity("artist", aid)
        name = entity.get("name") or "Artist"

        try:
            albums = _fetch_artist_albums(aid, token)
        except Exception:
            albums = []

        # Fall back to top tracks if albums couldn't be fetched
        if not albums:
            albums = [
                {
                    "name": "Top Tracks",
                    "cover": _cover_url(entity),
                    "trackCount": _track_count(entity),
                    "url": f"https://open.spotify.com/artist/{aid}",
                }
            ]

        return {
            "name": name,
            "type": "artist",
            "entities": albums,
        }


if __name__ == "__main__":
    url = "https://open.spotify.com/artist/3hteYQFiMFbJY7wS0xDymP?si=itfTaQlrTx2VMdTCMhsO5w"
    import pprint

    pprint.pprint(resolve(url))
