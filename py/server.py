"""Backend for mus/web: serves grandparent/parent/track data from Postgres + S3."""

from __future__ import annotations

import logging
import math
import re
import sys
import uuid
from collections.abc import Callable, Generator
from contextlib import asynccontextmanager
from typing import Any

import psycopg2
import psycopg2.extras
import uvicorn
from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi import Form as FastAPIForm
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import Request
from psycopg2 import pool as pg_pool
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ingest import embed_query, project_grandparent, project_user
from profile_catalog import top_catalog_artists_for_profile_url

log = logging.getLogger(__name__)


# ── Config ──────────────────────────────────────────────────────────────────────


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    s3_bucket: str
    postgres_url: str
    aws_default_region: str = "us-east-1"
    cdn_base: str | None = None


settings = Settings()

S3_BASE = (
    settings.cdn_base
    or f"https://{settings.s3_bucket}.s3.{settings.aws_default_region}.amazonaws.com"
)

_db_pool: pg_pool.ThreadedConnectionPool | None = None


def _postgres_dsn(url: str) -> str:
    """Append libpq TCP keepalive params to reduce idle SSL drops (e.g. Neon + App Runner)."""
    if "keepalives=" in url.lower():
        return url
    sep = "&" if "?" in url else "?"
    return (
        f"{url}{sep}"
        "keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=5"
    )


def _safe_rollback(conn: psycopg2.extensions.connection) -> None:
    if getattr(conn, "closed", 1) != 0:
        return
    try:
        conn.rollback()
    except psycopg2.Error:
        pass


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _db_pool
    _db_pool = pg_pool.ThreadedConnectionPool(
        minconn=2,
        maxconn=20,
        dsn=_postgres_dsn(settings.postgres_url),
    )
    try:
        yield
    finally:
        _db_pool.closeall()


# ── App ─────────────────────────────────────────────────────────────────────────

app = FastAPI(title="mus API", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(psycopg2.Error)
async def _psycopg2_error_handler(request: Request, exc: psycopg2.Error) -> JSONResponse:
    log.exception("psycopg2 error on %s", request.url.path)
    msg = str(exc).strip().split("\n", 1)[0]
    return JSONResponse(status_code=500, content={"detail": msg})


# ── Schemas ─────────────────────────────────────────────────────────────────────


class ReprojectRequest(BaseModel):
    model_config = {"populate_by_name": True}

    grandparent_id: str = Field(alias="grandparentId")


class ReprojectUserRequest(BaseModel):
    model_config = {"populate_by_name": True}

    user_id: str = Field(alias="userId")


# ── Dependencies ────────────────────────────────────────────────────────────────


def _conn_from_pool_or_url(
    postgres_url: str,
) -> tuple[psycopg2.extensions.connection, Callable[[], None]]:
    """Pooled connection when app is up; otherwise a one-off (e.g. tests)."""
    if _db_pool is not None:
        c = _db_pool.getconn()

        def release() -> None:
            _, exc_val, _ = sys.exc_info()
            _safe_rollback(c)
            broken = (c.closed != 0) or (
                exc_val is not None
                and isinstance(
                    exc_val, (psycopg2.OperationalError, psycopg2.InterfaceError)
                )
            )
            try:
                _db_pool.putconn(c, close=broken)
            except Exception:
                pass

        return c, release
    c = psycopg2.connect(_postgres_dsn(postgres_url))
    return c, lambda: c.close()


def get_db() -> Generator[psycopg2.extensions.connection, None, None]:
    """Yield a pooled connection (or one-off if pool not ready)."""
    if _db_pool is not None:
        conn = _db_pool.getconn()
        try:
            yield conn
        finally:
            _, exc_val, _ = sys.exc_info()
            _safe_rollback(conn)
            broken = (conn.closed != 0) or (
                exc_val is not None
                and isinstance(
                    exc_val, (psycopg2.OperationalError, psycopg2.InterfaceError)
                )
            )
            try:
                _db_pool.putconn(conn, close=broken)
            except Exception:
                pass
        return
    conn = psycopg2.connect(_postgres_dsn(settings.postgres_url))
    try:
        yield conn
    finally:
        conn.close()


# ── Helpers ─────────────────────────────────────────────────────────────────────


def s3_url(key: str | None) -> str | None:
    if not key:
        return None
    if key.startswith(("http://", "https://")):
        return key
    if key.startswith("s3://"):
        key = key.split("/", 3)[-1]
    return f"{S3_BASE}/{key}"


def _l2_normalize(vec: list[float]) -> list[float]:
    if not vec:
        return vec
    s = math.sqrt(sum(x * x for x in vec))
    if s <= 0:
        return vec
    return [x / s for x in vec]


def _top_artists_by_popularity(conn, limit: int) -> list[dict[str, Any]]:
    """Ready artist grandparents ordered by monthly_listeners (picker fallback)."""
    lim = min(max(limit, 1), 80)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        f"""
        WITH top_gps AS (
            SELECT id, name, cover_s3, monthly_listeners
            FROM grandparents
            WHERE status = 'ready' AND type = 'artist'
            ORDER BY monthly_listeners DESC NULLS LAST
            LIMIT {lim}
        ),
        gc AS (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
              AND p2.grandparent_id IN (SELECT id FROM top_gps)
            GROUP BY p2.grandparent_id
        )
        SELECT gp.id, gp.name, COALESCE(gp.cover_s3, gc.cover_s3) AS cover_s3
        FROM top_gps gp
        LEFT JOIN gc ON gc.grandparent_id = gp.id
        ORDER BY gp.monthly_listeners DESC NULLS LAST
        """,
    )
    rows = cur.fetchall()
    cur.close()
    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "cover": s3_url(r["cover_s3"]),
        }
        for r in rows
    ]


# ── Routes ──────────────────────────────────────────────────────────────────────


@app.get("/api/entities", tags=["data"])
def api_entities(q: str = "", limit: int = 20, conn=Depends(get_db)):
    """Returns grandparents with their parents nested. Searches by name when q is provided."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    if q.strip():
        gp_filter = "AND name ILIKE %s"
        gp_params = (f"%{q.strip()}%",)
        limit_clause = ""
    else:
        gp_filter = ""
        gp_params = ()
        lim = min(max(limit, 1), 500)
        limit_clause = f"LIMIT {lim}"
    cur.execute(
        f"""
        WITH top_gps AS (
            SELECT id, name, type, cover_s3, created_at, monthly_listeners
            FROM grandparents
            WHERE status = 'ready' {gp_filter}
            ORDER BY monthly_listeners DESC NULLS LAST
            {limit_clause}
        ),
        gp_covers AS (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
              AND p2.grandparent_id IN (SELECT id FROM top_gps)
            GROUP BY p2.grandparent_id
        ),
        p_covers AS (
            SELECT pt.parent_id, MIN(t.cover_s3) AS cover_s3
            FROM parent_tracks pt
            JOIN tracks t ON t.id = pt.track_id
            JOIN parents p ON p.id = pt.parent_id
            WHERE t.cover_s3 IS NOT NULL
              AND p.grandparent_id IN (SELECT id FROM top_gps)
            GROUP BY pt.parent_id
        )
        SELECT gp.id, gp.name, gp.type,
               COALESCE(gp.cover_s3, gc.cover_s3) AS cover_s3,
               p.id AS parent_id, p.name AS parent_name,
               p.type AS parent_type,
               COALESCE(p.cover_s3, pc.cover_s3) AS parent_cover_s3
        FROM top_gps gp
        LEFT JOIN gp_covers gc ON gc.grandparent_id = gp.id
        LEFT JOIN parents p ON p.grandparent_id = gp.id AND p.status = 'ready'
          AND EXISTS (SELECT 1 FROM parent_tracks ptx WHERE ptx.parent_id = p.id)
        LEFT JOIN p_covers pc ON pc.parent_id = p.id
        ORDER BY gp.monthly_listeners DESC NULLS LAST, p.created_at
    """,
        gp_params,
    )
    rows = cur.fetchall()
    cur.close()

    gp_map: dict[str, dict] = {}
    for r in rows:
        gid = str(r["id"])
        if gid not in gp_map:
            gp_map[gid] = {
                "id": gid,
                "name": r["name"],
                "type": r["type"],
                "cover": s3_url(r["cover_s3"]),
                "children": [],
            }
        if r["parent_id"]:
            gp_map[gid]["children"].append(
                {
                    "id": str(r["parent_id"]),
                    "name": r["parent_name"],
                    "type": r["parent_type"],
                    "cover": s3_url(r["parent_cover_s3"]),
                }
            )

    return {"entities": list(gp_map.values())}


@app.get("/api/artists", tags=["data"])
def api_artists(
    q: str = "",
    limit: int = 15,
    conn=Depends(get_db),
):
    """
    Flat list of artist grandparents for search / add-artist UIs.
    Lighter than /api/entities (no parent/album fan-out).
    """
    qstrip = q.strip()
    if qstrip:
        gp_filter = "AND name ILIKE %s"
        gp_params: tuple[Any, ...] = (f"%{qstrip}%",)
        lim = min(max(limit, 1), 80)
        limit_clause = f"LIMIT {lim}"
    else:
        gp_filter = ""
        gp_params = ()
        lim = min(max(limit, 1), 500)
        limit_clause = f"LIMIT {lim}"

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        f"""
        WITH top_gps AS (
            SELECT id, name, cover_s3, monthly_listeners
            FROM grandparents
            WHERE status = 'ready' AND type = 'artist' {gp_filter}
            ORDER BY monthly_listeners DESC NULLS LAST
            {limit_clause}
        ),
        gc AS (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
              AND p2.grandparent_id IN (SELECT id FROM top_gps)
            GROUP BY p2.grandparent_id
        )
        SELECT gp.id, gp.name, COALESCE(gp.cover_s3, gc.cover_s3) AS cover_s3
        FROM top_gps gp
        LEFT JOIN gc ON gc.grandparent_id = gp.id
        ORDER BY gp.monthly_listeners DESC NULLS LAST
        """,
        gp_params,
    )
    rows = cur.fetchall()
    cur.close()

    artists = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "cover": s3_url(r["cover_s3"]),
        }
        for r in rows
    ]
    return {"artists": artists}


NN_SUGGEST_POOL = 10


@app.get("/api/artists/suggested", tags=["data"])
def api_artists_suggested(
    user_id: str = Query(..., alias="userId"),
    limit: int = Query(10, ge=1, le=20),
    conn=Depends(get_db),
):
    """
    Suggested artists for the add-artist picker: mean embedding of the user's on-canvas
    artist grandparents, then the **10** nearest by vector distance, **re-ordered by
    popularity** (monthly_listeners). Returns up to `limit` rows. Falls back to pure
    popularity when the user has no embeddable artists yet.
    """
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="userId is required")
    lim = min(max(limit, 1), 20)

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT gp.id::text, gp.embedding::text AS emb_text
        FROM user_grandparents ug
        JOIN grandparents gp ON gp.id = ug.grandparent_id
        WHERE ug.user_id = %s
          AND gp.type = 'artist'
          AND gp.status = 'ready'
          AND gp.embedding IS NOT NULL
        """,
        (uid,),
    )
    emb_rows = cur.fetchall()
    vectors: list[list[float]] = []
    exclude_ids: list[str] = []
    for r in emb_rows:
        v = _parse_halfvec_text(r.get("emb_text"))
        if len(v) < 2:
            continue
        exclude_ids.append(str(r["id"]))
        vectors.append(v)

    if not vectors:
        cur.close()
        return {
            "artists": _top_artists_by_popularity(conn, lim),
            "personalized": False,
        }

    dim = len(vectors[0])
    if not all(len(v) == dim for v in vectors):
        log.warning("artists/suggested: mismatched embedding dimensions; using popularity")
        cur.close()
        return {
            "artists": _top_artists_by_popularity(conn, lim),
            "personalized": False,
        }

    mean = [
        sum(vectors[i][j] for i in range(len(vectors))) / len(vectors)
        for j in range(dim)
    ]
    mean = _l2_normalize(mean)
    emb_str = "[" + ",".join(f"{v:.8g}" for v in mean) + "]"

    cur.execute(
        f"""
        WITH gc AS (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
            GROUP BY p2.grandparent_id
        ),
        nn AS (
            SELECT g.id, g.name, g.cover_s3 AS gp_cover, g.monthly_listeners
            FROM grandparents g
            WHERE g.status = 'ready'
              AND g.type = 'artist'
              AND g.embedding IS NOT NULL
              AND g.id <> ALL(%s::uuid[])
            ORDER BY g.embedding <=> %s::halfvec
            LIMIT {NN_SUGGEST_POOL}
        )
        SELECT n.id, n.name, COALESCE(n.gp_cover, gc.cover_s3) AS cover_s3
        FROM nn n
        LEFT JOIN gc ON gc.grandparent_id = n.id
        ORDER BY n.monthly_listeners DESC NULLS LAST
        LIMIT %s
        """,
        (exclude_ids, emb_str, lim),
    )
    rows = cur.fetchall()
    cur.close()

    artists = [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "cover": s3_url(r["cover_s3"]),
        }
        for r in rows
    ]
    return {"artists": artists, "personalized": True}


def _resolve_covers_for_grandparent_ids(conn, ids: list[str]) -> dict[str, str | None]:
    if not ids:
        return {}
    placeholders = ",".join(["%s"] * len(ids))
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        f"""
        SELECT gp.id::text, COALESCE(gp.cover_s3, gc.cover_s3) AS cover_s3
        FROM grandparents gp
        LEFT JOIN (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
            GROUP BY p2.grandparent_id
        ) gc ON gc.grandparent_id = gp.id
        WHERE gp.id IN ({placeholders})
        """,
        ids,
    )
    m = {str(r["id"]): s3_url(r["cover_s3"]) for r in cur.fetchall()}
    cur.close()
    return m


@app.get("/api/resolve", tags=["data"])
def api_resolve(url: str = "", conn=Depends(get_db)):
    """
    Home paste: Spotify **user profile** URL only → top 10 catalog artists (from public
    playlists on the profile page, matched to ready artist grandparents).
    """
    raw = (url or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="url required")
    if "/user/" not in raw:
        raise HTTPException(
            status_code=400,
            detail="Only open.spotify.com/user/… profile links are supported here",
        )

    try:
        display_name, rows = top_catalog_artists_for_profile_url(
            raw, limit=10, postgres_url=settings.postgres_url
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        log.exception("resolve profile failed")
        raise HTTPException(
            status_code=502, detail="Could not read that Spotify profile"
        ) from e

    if not rows:
        return {
            "name": display_name,
            "type": "spotify_profile",
            "entities": [],
        }

    ids = [r["grandparent_id"] for r in rows]
    cover_map = _resolve_covers_for_grandparent_ids(conn, ids)
    entities = []
    for r in rows:
        gid = r["grandparent_id"]
        entities.append(
            {
                "name": r["name"],
                "cover": cover_map.get(gid),
                "trackCount": r["track_count"],
                "url": gid,
            }
        )
    return {"name": display_name, "type": "spotify_profile", "entities": entities}


@app.get("/api/artist-neighbors", tags=["data"])
def api_artist_neighbors(
    grandparent_id: str = Query(..., alias="grandparentId"),
    exclude: str = "",
    pool: int = Query(10, ge=3, le=50, description="nearest-N by embedding before popularity pick"),
    k: int = Query(3, ge=1, le=20, description="return top-k by monthly_listeners within the pool"),
    conn=Depends(get_db),
):
    """Nearest `pool` by embedding, then top `k` by monthly_listeners (composite)."""
    pool_n = min(max(pool, 3), 50)
    kid = min(max(k, 1), 20)
    exclude_ids = [x.strip() for x in exclude.split(",") if x.strip()]
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        f"""
        WITH ref AS (
            SELECT id, embedding FROM grandparents
            WHERE id = %s::uuid AND embedding IS NOT NULL
        ),
        candidates AS (
            SELECT g.id, g.name, g.cover_s3, g.monthly_listeners
            FROM grandparents g
            CROSS JOIN ref
            WHERE g.status = 'ready'
              AND g.type = 'artist'
              AND g.embedding IS NOT NULL
              AND g.id <> ref.id
              AND g.id <> ALL(%s::uuid[])
            ORDER BY g.embedding <=> ref.embedding
            LIMIT {pool_n}
        ),
        nbs AS (
            SELECT id, name, cover_s3, monthly_listeners
            FROM candidates
            ORDER BY monthly_listeners DESC NULLS LAST
            LIMIT {kid}
        ),
        gp_covers AS (
            SELECT p2.grandparent_id, MIN(t.cover_s3) AS cover_s3
            FROM parents p2
            JOIN parent_tracks pt ON pt.parent_id = p2.id
            JOIN tracks t ON t.id = pt.track_id
            WHERE t.cover_s3 IS NOT NULL
              AND p2.grandparent_id IN (SELECT id FROM nbs)
            GROUP BY p2.grandparent_id
        )
        SELECT n.id, n.name, COALESCE(n.cover_s3, gc.cover_s3) AS cover_s3
        FROM nbs n
        LEFT JOIN gp_covers gc ON gc.grandparent_id = n.id
        ORDER BY n.monthly_listeners DESC NULLS LAST
        """,
        (grandparent_id, exclude_ids),
    )
    rows = cur.fetchall()
    cur.close()
    return {
        "artists": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "cover": s3_url(r["cover_s3"]),
            }
            for r in rows
        ]
    }


_SEARCHES_ID = "00000000-0000-0000-0000-000000000001"

# Semantic search paths: nearest-N by embedding, then top-k by artist monthly_listeners (recommended / omnibox / similar).
TRACK_REC_POOL = 10
TRACK_REC_K = 5


def _parse_parent_ids_csv(raw: str | None) -> list[str]:
    """Comma-separated parent UUIDs from the client; invalid tokens skipped."""
    if not raw or not str(raw).strip():
        return []
    out: list[str] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(str(uuid.UUID(part)))
        except ValueError:
            continue
    return out


def _authorized_visible_parent_ids(
    cur: Any, user_id: str, requested_parent_ids: list[str]
) -> list[str]:
    """Parents the user owns, are ready, canvas-visible, and in the requested set."""
    if not requested_parent_ids:
        return []
    cur.execute(
        """
        SELECT p.id::text
        FROM user_parents up
        JOIN parents p ON p.id = up.parent_id AND p.status = 'ready'
        WHERE up.user_id = %s
          AND up.canvas_visible = true
          AND p.id = ANY(%s::uuid[])
        ORDER BY p.id
        """,
        (user_id, requested_parent_ids),
    )
    return [str(r["id"]) for r in cur.fetchall()]


def _popularity_pick_tracks_not_in_library(cur: Any, user_id: str, k: int) -> list[str]:
    cur.execute(
        """
        WITH lib AS (
          SELECT DISTINCT pt.track_id AS tid
          FROM parent_tracks pt
          JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
          JOIN user_parents up ON up.parent_id = p.id AND up.user_id = %s
        ),
        scored AS (
          SELECT t.id,
            COALESCE(MAX(gp.monthly_listeners), 0) AS ml
          FROM tracks t
          LEFT JOIN parent_tracks pt ON pt.track_id = t.id
          LEFT JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
          LEFT JOIN grandparents gp ON gp.id = p.grandparent_id
            AND gp.type = 'artist' AND gp.status = 'ready'
          WHERE t.status = 'ready'
            AND (t.is_query = false OR t.is_query IS NULL)
            AND t.embedding IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM lib WHERE lib.tid = t.id)
          GROUP BY t.id
        )
        SELECT id FROM scored
        ORDER BY ml DESC NULLS LAST, id
        LIMIT %s
        """,
        (user_id, k),
    )
    return [str(r["id"]) for r in cur.fetchall()]


def _track_embedding_from_id(cur: Any, track_id: str) -> list[float]:
    cur.execute(
        "SELECT embedding::text AS emb_text FROM tracks WHERE id = %s::uuid LIMIT 1",
        (track_id,),
    )
    row = cur.fetchone()
    if not row:
        return []
    return _parse_halfvec_text(row.get("emb_text"))


def _worker_embed_search_track_ids(
    postgres_url: str,
    file_bytes: bytes | None,
    mime_type: str,
    text_val: str | None,
) -> tuple[list[str], list[float]]:
    """Embedding + vector search: top TRACK_REC_POOL by distance, then top TRACK_REC_K by popularity."""
    if file_bytes:
        emb = embed_query(audio_bytes=file_bytes, mime_type=mime_type or "application/octet-stream")
    else:
        emb = embed_query(text=(text_val or "").strip())
    emb_str = "[" + ",".join(f"{v:.8g}" for v in emb) + "]"
    c, release = _conn_from_pool_or_url(postgres_url)
    try:
        cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            f"""
            WITH nn AS (
              SELECT t.id
              FROM tracks t
              WHERE t.embedding IS NOT NULL
                AND t.status = 'ready'
                AND (t.is_query = false OR t.is_query IS NULL)
              ORDER BY t.embedding <=> %s::halfvec
              LIMIT {TRACK_REC_POOL}
            ),
            pop AS (
              SELECT n.id,
                COALESCE(MAX(gp.monthly_listeners), 0) AS ml
              FROM nn n
              LEFT JOIN parent_tracks pt ON pt.track_id = n.id
              LEFT JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
              LEFT JOIN grandparents gp ON gp.id = p.grandparent_id
                AND gp.type = 'artist' AND gp.status = 'ready'
              GROUP BY n.id
            )
            SELECT n.id
            FROM nn n
            JOIN pop p ON p.id = n.id
            ORDER BY p.ml DESC NULLS LAST, n.id
            LIMIT {TRACK_REC_K}
            """,
            (emb_str,),
        )
        rows = cur.fetchall()
        return [str(r["id"]) for r in rows], emb
    finally:
        release()


def _parse_halfvec_text(emb_raw: object) -> list[float]:
    """Parse halfvec/vector ::text from Postgres (comma or space separated)."""
    if emb_raw is None:
        return []
    s = emb_raw if isinstance(emb_raw, str) else str(emb_raw)
    inner = s.strip().strip("[]")
    if not inner:
        return []
    parts = [p for p in re.split(r"[\s,]+", inner) if p]
    return [float(p) for p in parts]


def _worker_similar_by_track(
    postgres_url: str,
    user_id: str,
    source_track_id: str,
) -> tuple[list[str], list[float], str]:
    """
    Nearest tracks by embedding to a source track (pool then popularity, like recommended).
    Source must belong to the user's library.
    Results exclude tracks already in the user's library (user_parents + ready parent).
    Returns (similar_track_ids, source_embedding, parent_label). Empty label => not found / no access.
    """
    c, release = _conn_from_pool_or_url(postgres_url)
    try:
        cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # user_parents.user_id is text (Neon Auth ids), not uuid — compare without ::uuid
        cur.execute(
            """
            SELECT t.embedding::text AS emb_text, t.title, t.artist
            FROM tracks t
            INNER JOIN parent_tracks pt ON pt.track_id = t.id
            INNER JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
            INNER JOIN user_parents up ON up.parent_id = p.id AND up.user_id = %s
            WHERE t.id = %s::uuid
              AND t.embedding IS NOT NULL
              AND t.status = 'ready'
            LIMIT 1
            """,
            (user_id, source_track_id),
        )
        row = cur.fetchone()
        if not row:
            return [], [], ""

        nums = _parse_halfvec_text(row.get("emb_text"))
        if not nums:
            raise RuntimeError(
                "Could not parse track embedding (unexpected text format)"
            )

        title = (row.get("title") or "").strip() or "Track"
        artist = (row.get("artist") or "").strip()
        if artist:
            label = f"Similar · {artist} — {title}"
        else:
            label = f"Similar · {title}"
        label = label[:120]

        emb_str = "[" + ",".join(f"{v:.8g}" for v in nums) + "]"
        cur.execute(
            f"""
            WITH nn AS (
              SELECT t.id
              FROM tracks t
              WHERE t.embedding IS NOT NULL
                AND t.id != %s::uuid
                AND t.status = 'ready'
                AND (t.is_query = false OR t.is_query IS NULL)
                AND NOT EXISTS (
                  SELECT 1
                  FROM parent_tracks pt0
                  JOIN parents p0 ON p0.id = pt0.parent_id AND p0.status = 'ready'
                  JOIN user_parents up0 ON up0.parent_id = p0.id AND up0.user_id = %s
                  WHERE pt0.track_id = t.id
                )
              ORDER BY t.embedding <=> %s::halfvec
              LIMIT {TRACK_REC_POOL}
            ),
            pop AS (
              SELECT n.id,
                COALESCE(MAX(gp.monthly_listeners), 0) AS ml
              FROM nn n
              LEFT JOIN parent_tracks pt ON pt.track_id = n.id
              LEFT JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
              LEFT JOIN grandparents gp ON gp.id = p.grandparent_id
                AND gp.type = 'artist' AND gp.status = 'ready'
              GROUP BY n.id
            )
            SELECT n.id
            FROM nn n
            JOIN pop p ON p.id = n.id
            ORDER BY p.ml DESC NULLS LAST, n.id
            LIMIT {TRACK_REC_K}
            """,
            (source_track_id, user_id, emb_str),
        )
        rows = cur.fetchall()
        return [str(r["id"]) for r in rows], nums, label
    finally:
        release()


def _worker_recommended_tracks_for_user(
    postgres_url: str,
    user_id: str,
    requested_parent_ids: list[str],
) -> tuple[list[str], list[float], str]:
    """
    Mean embedding over tracks under **checked (canvas_visible) parents** in
    ``requested_parent_ids`` that belong to the user, then nearest-neighbor +
    popularity pick (same composite as /api/artists/suggested).

    Exclusion for result tracks: not already in the user's library (ready parent
    + user_parents).

    If there are no embeddable tracks under those parents, returns empty ids
    (no global-library mean fallback).
    """
    label = "Recommendations"
    c, release = _conn_from_pool_or_url(postgres_url)
    try:
        cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        parent_ids = _authorized_visible_parent_ids(cur, user_id, requested_parent_ids)
        if not parent_ids:
            return [], [], ""

        cur.execute(
            """
            SELECT DISTINCT ON (t.id) t.embedding::text AS emb_text
            FROM tracks t
            INNER JOIN parent_tracks pt ON pt.track_id = t.id
            INNER JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
            INNER JOIN user_parents up ON up.parent_id = p.id AND up.user_id = %s
            WHERE t.embedding IS NOT NULL
              AND t.status = 'ready'
              AND (t.is_query = false OR t.is_query IS NULL)
              AND p.id = ANY(%s::uuid[])
            ORDER BY t.id
            """,
            (user_id, parent_ids),
        )
        vectors: list[list[float]] = []
        for row in cur.fetchall():
            v = _parse_halfvec_text(row.get("emb_text"))
            if len(v) >= 2:
                vectors.append(v)

        mean: list[float] = []
        if vectors:
            dim = len(vectors[0])
            if all(len(v) == dim for v in vectors):
                mean = _l2_normalize(
                    [
                        sum(vectors[i][j] for i in range(len(vectors)))
                        / len(vectors)
                        for j in range(dim)
                    ]
                )
            else:
                log.warning(
                    "search/recommended: mismatched embedding dimensions; using popularity fallback"
                )
                vectors = []

        if mean:
            emb_str = "[" + ",".join(f"{v:.8g}" for v in mean) + "]"
            cur.execute(
                f"""
                WITH nn AS (
                  SELECT t.id
                  FROM tracks t
                  WHERE t.embedding IS NOT NULL
                    AND t.status = 'ready'
                    AND (t.is_query = false OR t.is_query IS NULL)
                    AND NOT EXISTS (
                      SELECT 1
                      FROM parent_tracks pt0
                      JOIN parents p0 ON p0.id = pt0.parent_id AND p0.status = 'ready'
                      JOIN user_parents up0 ON up0.parent_id = p0.id AND up0.user_id = %s
                      WHERE pt0.track_id = t.id
                    )
                  ORDER BY t.embedding <=> %s::halfvec
                  LIMIT {TRACK_REC_POOL}
                ),
                pop AS (
                  SELECT n.id,
                    COALESCE(MAX(gp.monthly_listeners), 0) AS ml
                  FROM nn n
                  LEFT JOIN parent_tracks pt ON pt.track_id = n.id
                  LEFT JOIN parents p ON p.id = pt.parent_id AND p.status = 'ready'
                  LEFT JOIN grandparents gp ON gp.id = p.grandparent_id
                    AND gp.type = 'artist' AND gp.status = 'ready'
                  GROUP BY n.id
                )
                SELECT n.id
                FROM nn n
                JOIN pop p ON p.id = n.id
                ORDER BY p.ml DESC NULLS LAST, n.id
                LIMIT {TRACK_REC_K}
                """,
                (user_id, emb_str),
            )
            ids = [str(r["id"]) for r in cur.fetchall()]
            if ids:
                return ids, mean, label
            ids_fb = _popularity_pick_tracks_not_in_library(
                cur, user_id, TRACK_REC_K
            )
            if ids_fb:
                return ids_fb, mean, label
            return [], mean, label

        return [], [], ""
    finally:
        release()


def _query_kind_from_omni(
    file_bytes: bytes | None,
    mime_type: str,
) -> str:
    if not file_bytes:
        return "text"
    mt = (mime_type or "").lower()
    if mt.startswith("image/"):
        return "image"
    if mt.startswith("video/"):
        return "video"
    if mt.startswith("audio/"):
        return "audio"
    return "text"


def _commit_semantic_search_parent(
    conn,
    *,
    user_id: str,
    label: str,
    track_ids: list[str],
    query_emb: list[float],
    background_tasks: BackgroundTasks,
    query_kind: str,
) -> dict[str, Any]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    search_parent_id: str
    sentinel_id: str | None = None
    try:
        cur.execute(
            """
            INSERT INTO parents (name, type, status, grandparent_id, query_kind)
            VALUES (%s, 'search', 'ready', %s, %s)
            RETURNING id
            """,
            (label, _SEARCHES_ID, query_kind),
        )
        search_parent_id = str(cur.fetchone()["id"])

        if track_ids:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO parent_tracks (parent_id, track_id) VALUES %s ON CONFLICT DO NOTHING",
                [(search_parent_id, tid) for tid in track_ids],
            )

        # Recommended uses a synthetic mean embedding — no query tile on the map or in layout.
        if query_kind != "recommended":
            emb_str = "[" + ",".join(f"{v:.8g}" for v in query_emb) + "]"
            cur.execute(
                """
                INSERT INTO tracks (title, artist, status, embedding, is_query)
                VALUES (%s, '', 'ready', %s::halfvec, true)
                RETURNING id
                """,
                (label, emb_str),
            )
            sentinel_id = str(cur.fetchone()["id"])
            cur.execute(
                "INSERT INTO parent_tracks (parent_id, track_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (search_parent_id, sentinel_id),
            )

        cur.execute(
            "UPDATE grandparents SET status = 'ready' WHERE id = %s",
            (_SEARCHES_ID,),
        )
        cur.execute(
            "INSERT INTO user_grandparents (user_id, grandparent_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (user_id, _SEARCHES_ID),
        )
        cur.execute(
            "UPDATE user_grandparents SET projected = false WHERE user_id = %s AND grandparent_id = %s",
            (user_id, _SEARCHES_ID),
        )
        cur.execute(
            "INSERT INTO user_parents (user_id, parent_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (user_id, search_parent_id),
        )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()

    background_tasks.add_task(project_grandparent, _SEARCHES_ID)

    return {
        "trackIds": track_ids,
        "searchEntityId": search_parent_id,
        "sentinelId": sentinel_id,
    }


@app.post("/api/search", tags=["search"])
def api_search(
    background_tasks: BackgroundTasks,
    user_id: str = FastAPIForm(...),
    text: str | None = FastAPIForm(default=None),
    file: UploadFile | None = File(default=None),
    conn=Depends(get_db),
):
    """
    Semantic search via multimodal embedding + pgvector: nearest TRACK_REC_POOL by
    distance, then top TRACK_REC_K by artist popularity (same as recommended/similar).
    Accepts text or a file.
    """
    text_stripped = (text or "").strip()
    if not text_stripped and not file:
        raise HTTPException(status_code=400, detail="Provide text or a file")

    file_bytes = file.file.read() if file else None
    mime_type = (file.content_type or "application/octet-stream") if file else ""
    label = (text_stripped[:80] if text_stripped else None) or (
        file.filename if file else "search"
    )
    try:
        track_ids, query_emb = _worker_embed_search_track_ids(
            settings.postgres_url,
            file_bytes,
            mime_type,
            text_stripped if text_stripped else None,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Embedding or search failed: {e}",
        ) from e

    if not track_ids:
        raise HTTPException(status_code=404, detail="No tracks with embeddings found")

    qk = _query_kind_from_omni(file_bytes, mime_type)
    return _commit_semantic_search_parent(
        conn,
        user_id=user_id,
        label=label,
        track_ids=track_ids,
        query_emb=query_emb,
        background_tasks=background_tasks,
        query_kind=qk,
    )


@app.post("/api/search/similar", tags=["search"])
def api_search_similar(
    background_tasks: BackgroundTasks,
    user_id: str = FastAPIForm(...),
    track_id: str = FastAPIForm(...),
    conn=Depends(get_db),
):
    """
    Similar tracks: nearest TRACK_REC_POOL outside the user's library by embedding,
    then top TRACK_REC_K by artist popularity. Creates a search parent like /api/search.
    """
    tid = (track_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="track_id is required")

    try:
        track_ids, query_emb, label = _worker_similar_by_track(
            settings.postgres_url,
            user_id,
            tid,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Similar search failed: {e}",
        ) from e

    if not label:
        raise HTTPException(
            status_code=404,
            detail="Track not in your library, not ready, or has no embedding",
        )
    if not track_ids:
        raise HTTPException(status_code=404, detail="No similar tracks found")

    return _commit_semantic_search_parent(
        conn,
        user_id=user_id,
        label=label,
        track_ids=track_ids,
        query_emb=query_emb,
        background_tasks=background_tasks,
        query_kind="similar",
    )


@app.post("/api/search/recommended", tags=["search"])
def api_search_recommended(
    background_tasks: BackgroundTasks,
    user_id: str = FastAPIForm(...),
    parent_ids: str | None = FastAPIForm(
        default=None,
        description="Comma-separated parent (album) UUIDs for checked, visible albums",
    ),
    conn=Depends(get_db),
):
    """
    Recommendations from the mean embedding of tracks under those parents only
    (must be the user's canvas-visible / checked albums). Result tracks are still
    catalog-wide excluding the full library.
    """
    uid = (user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id is required")

    parsed_parents = _parse_parent_ids_csv(parent_ids)
    if not parsed_parents:
        raise HTTPException(
            status_code=400,
            detail=(
                "parent_ids is required: comma-separated parent ids for checked "
                "albums (visible on the canvas)."
            ),
        )

    try:
        track_ids, query_emb, label = _worker_recommended_tracks_for_user(
            settings.postgres_url,
            uid,
            parsed_parents,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Recommended search failed: {e}",
        ) from e

    if not query_emb or len(query_emb) < 2:
        raise HTTPException(
            status_code=404,
            detail=(
                "No embeddable tracks in the checked albums, or those albums are "
                "not visible for your account."
            ),
        )
    if not track_ids:
        raise HTTPException(
            status_code=404,
            detail="No recommended tracks found outside your library",
        )

    return _commit_semantic_search_parent(
        conn,
        user_id=uid,
        label=label,
        track_ids=track_ids,
        query_emb=query_emb,
        background_tasks=background_tasks,
        query_kind="recommended",
    )


@app.post("/api/reproject", tags=["canvas"])
def api_reproject(body: ReprojectRequest, background_tasks: BackgroundTasks):
    """Recompute layout for users pending on this grandparent (e.g. search parent)."""
    background_tasks.add_task(project_grandparent, body.grandparent_id)
    return {"ok": True}


@app.post("/api/reproject-user", tags=["canvas"])
def api_reproject_user(body: ReprojectUserRequest, background_tasks: BackgroundTasks):
    """Recompute full-library layout for one user (call after bulk or single add from Next.js)."""
    background_tasks.add_task(project_user, body.user_id)
    return {"ok": True}


@app.get("/health", tags=["ops"])
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002)
