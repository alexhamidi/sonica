"""Backend for mus/web: serves grandparent/parent/track data from Postgres + S3."""

from __future__ import annotations

import time
from typing import Any, Generator

import numpy as np
import psycopg2
import psycopg2.extras
import uvicorn
from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi import Form as FastAPIForm
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ingest import add_to_canvas, compute_projections, embed_query, project_grandparent
from name import resolve as resolve_url


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


# ── App ─────────────────────────────────────────────────────────────────────────

app = FastAPI(title="mus API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Schemas ─────────────────────────────────────────────────────────────────────


class AddRequest(BaseModel):
    model_config = {"populate_by_name": True}

    user_id: str = Field(alias="userId")
    grandparent_id: str | None = Field(default=None, alias="grandparentId")
    grandparent_url: str | None = Field(default=None, alias="grandparentUrl")
    parent_urls: list[str] | None = Field(default=None, alias="parentUrls")


# ── Dependencies ────────────────────────────────────────────────────────────────


def get_db() -> Generator[psycopg2.extensions.connection, None, None]:
    """Yield a fresh psycopg2 connection, auto-closed after the request."""
    conn = psycopg2.connect(settings.postgres_url)
    try:
        yield conn
    finally:
        conn.close()


# ── Helpers ─────────────────────────────────────────────────────────────────────

_cache: dict[str, Any] = {"data": None, "ts": 0.0}
CACHE_TTL = 60


def s3_url(key: str | None) -> str | None:
    if not key:
        return None
    if key.startswith(("http://", "https://")):
        return key
    if key.startswith("s3://"):
        key = key.split("/", 3)[-1]
    return f"{S3_BASE}/{key}"


def _build_all(conn) -> dict[str, Any]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT id, name,
               COALESCE(cover_s3, (
                   SELECT t.cover_s3 FROM parents p
                   JOIN parent_tracks pt ON pt.parent_id = p.id
                   JOIN tracks t ON t.id = pt.track_id
                   WHERE p.grandparent_id = grandparents.id AND t.cover_s3 IS NOT NULL
                   LIMIT 1
               )) AS cover_s3
        FROM grandparents
        WHERE status = 'ready'
        ORDER BY created_at
    """)
    gps = cur.fetchall()

    playlists = []
    gp_index: dict[str, int] = {}
    for i, gp in enumerate(gps):
        playlists.append(
            {
                "id": str(gp["id"]),
                "name": gp["name"],
                "cover": s3_url(gp["cover_s3"]),
            }
        )
        gp_index[str(gp["id"])] = i

    cur.execute("""
        SELECT pt.parent_id, t.title, t.artist,
               t.audio_s3, t.cover_s3,
               p.grandparent_id
        FROM parent_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        JOIN parents p ON p.id = pt.parent_id
        JOIN grandparents gp ON gp.id = p.grandparent_id
        WHERE gp.status = 'ready'
          AND p.status = 'ready'
        ORDER BY gp.created_at, t.id
    """)
    rows = cur.fetchall()
    cur.close()

    tracks = []
    for i, row in enumerate(rows):
        tracks.append(
            {
                "index": i,
                "title": row["title"],
                "artist": row["artist"],
                "mp3": s3_url(row["audio_s3"]),
                "cover": s3_url(row["cover_s3"]),
                "playlistIndex": gp_index.get(str(row["grandparent_id"]), 0),
            }
        )

    return {"playlists": playlists, "tracks": tracks}


# ── Routes ──────────────────────────────────────────────────────────────────────


@app.get("/api/all", tags=["data"])
def api_all(conn=Depends(get_db)):
    now = time.monotonic()
    if _cache["data"] is None or now - _cache["ts"] > CACHE_TTL:
        _cache["data"] = _build_all(conn)
        _cache["ts"] = now
    return _cache["data"]


@app.get("/api/entities", tags=["data"])
def api_entities(q: str = "", conn=Depends(get_db)):
    """Returns grandparents with their parents nested. Searches by name when q is provided."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    if q.strip():
        gp_filter = "AND name ILIKE %s"
        gp_params = (f"%{q.strip()}%",)
        limit_clause = ""
    else:
        gp_filter = ""
        gp_params = ()
        limit_clause = "LIMIT 20"
    cur.execute(
        f"""
        WITH top_gps AS (
            SELECT id, name, type, cover_s3, created_at, popularity_rank
            FROM grandparents
            WHERE status = 'ready' {gp_filter}
            ORDER BY popularity_rank ASC NULLS LAST
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
        LEFT JOIN p_covers pc ON pc.parent_id = p.id
        ORDER BY gp.popularity_rank ASC NULLS LAST, p.created_at
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


_SEARCHES_ID = "00000000-0000-0000-0000-000000000001"
SEARCH_RESULTS_LIMIT = 5


@app.post("/api/search", tags=["search"])
def api_search(
    background_tasks: BackgroundTasks,
    user_id: str = FastAPIForm(...),
    text: str | None = FastAPIForm(default=None),
    file: UploadFile | None = File(default=None),
    conn=Depends(get_db),
):
    """
    Semantic search via multimodal embedding + pgvector nearest-neighbor.
    Accepts text or an audio file. Returns top-N matching tracks.
    """
    if not text and not file:
        raise HTTPException(status_code=400, detail="Provide text or a file")

    try:
        if file:
            audio_bytes = file.file.read()
            mime_type = file.content_type or "audio/wav"
            emb = embed_query(audio_bytes=audio_bytes, mime_type=mime_type)
        else:
            emb = embed_query(text=text.strip())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e}")

    emb_str = "[" + ",".join(f"{v:.8g}" for v in emb) + "]"
    label = (text.strip()[:80] if text else None) or (
        file.filename if file else "search"
    )

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        """
        SELECT id
        FROM tracks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> %s::halfvec
        LIMIT %s
    """,
        (emb_str, SEARCH_RESULTS_LIMIT),
    )
    results = cur.fetchall()

    if not results:
        cur.close()
        raise HTTPException(status_code=404, detail="No tracks with embeddings found")

    track_ids = [str(r["id"]) for r in results]

    cur.execute(
        """
        INSERT INTO parents (name, type, status, grandparent_id)
        VALUES (%s, 'search', 'ready', %s)
        RETURNING id
    """,
        (label, _SEARCHES_ID),
    )
    search_parent_id = str(cur.fetchone()["id"])

    for track_id in track_ids:
        cur.execute(
            "INSERT INTO parent_tracks (parent_id, track_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (search_parent_id, track_id),
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
    cur.close()

    background_tasks.add_task(project_grandparent, _SEARCHES_ID)

    return {
        "trackIds": track_ids,
        "searchEntityId": search_parent_id,
    }


@app.get("/api/entity/{entity_id}", tags=["data"])
def api_entity(entity_id: str, conn=Depends(get_db)):
    """Returns tracks for a grandparent or parent entity."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        "SELECT id, name, type, cover_s3 FROM grandparents WHERE id = %s",
        (entity_id,),
    )
    gp = cur.fetchone()

    if gp:
        cur.execute(
            """
            SELECT p.id, p.name, p.cover_s3 FROM parents p
            WHERE p.grandparent_id = %s AND p.status = 'ready'
            ORDER BY p.created_at
        """,
            (entity_id,),
        )
        parents = cur.fetchall()
        parent_ids = [str(p["id"]) for p in parents]
        parent_index = {str(p["id"]): i for i, p in enumerate(parents)}
        playlists = [
            {"id": str(p["id"]), "name": p["name"], "cover": s3_url(p["cover_s3"])}
            for p in parents
        ]
        grandparent_id = entity_id

        if parent_ids:
            cur.execute(
                """
                SELECT t.id, t.title, t.artist, t.audio_s3, t.cover_s3,
                       pt.parent_id
                FROM parent_tracks pt
                JOIN tracks t ON t.id = pt.track_id
                WHERE pt.parent_id = ANY(%s::uuid[])
                ORDER BY pt.parent_id, t.id
            """,
                (parent_ids,),
            )
            rows = cur.fetchall()
        else:
            rows = []
    else:
        cur.execute(
            """
            SELECT p.id, p.name, p.cover_s3, p.grandparent_id,
                   gp.type AS gp_type
            FROM parents p
            JOIN grandparents gp ON gp.id = p.grandparent_id
            WHERE p.id = %s
        """,
            (entity_id,),
        )
        parent = cur.fetchone()
        if not parent:
            cur.close()
            raise HTTPException(status_code=404, detail="Entity not found")

        playlists = [
            {
                "id": str(parent["id"]),
                "name": parent["name"],
                "cover": s3_url(parent["cover_s3"]),
            }
        ]
        parent_index = {str(parent["id"]): 0}
        grandparent_id = str(parent["grandparent_id"])

        if parent["gp_type"] == "searches":
            cur.execute(
                """
                SELECT t.id, t.title, t.artist, t.audio_s3, t.cover_s3,
                       pt.umap_x, pt.umap_y, pt.pca_x, pt.pca_y,
                       pt.parent_id
                FROM parent_tracks pt
                JOIN tracks t ON t.id = pt.track_id
                WHERE pt.parent_id = %s
            """,
                (str(parent["id"]),),
            )
        else:
            cur.execute(
                """
                SELECT t.id, t.title, t.artist, t.audio_s3, t.cover_s3,
                       pt.parent_id
                FROM parent_tracks pt
                JOIN tracks t ON t.id = pt.track_id
                WHERE pt.parent_id = %s
                ORDER BY t.id
            """,
                (str(parent["id"]),),
            )
        rows = cur.fetchall()

    cur.close()

    tracks = []
    for i, row in enumerate(rows):
        projections = {
            algo: [row[f"{algo}_x"], row[f"{algo}_y"]]
            for algo in ("umap", "tsne", "pca")
            if row.get(f"{algo}_x") is not None
        }
        tracks.append(
            {
                "index": i,
                "title": row["title"],
                "artist": row["artist"],
                "mp3": s3_url(row["audio_s3"]),
                "cover": s3_url(row["cover_s3"]),
                "playlistIndex": parent_index.get(str(row["parent_id"]), 0),
                "projections": projections,
            }
        )

    return {"grandparentId": grandparent_id, "playlists": playlists, "tracks": tracks}


@app.post("/api/add", tags=["canvas"])
def api_add(body: AddRequest, background_tasks: BackgroundTasks):
    """Unified add: resolve grandparent + parents, link user, queue ingest as needed."""
    try:
        result, pending_tasks = add_to_canvas(
            user_id=body.user_id,
            grandparent_id=body.grandparent_id,
            grandparent_url=body.grandparent_url,
            parent_urls=body.parent_urls,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    for fn, *args in pending_tasks:
        background_tasks.add_task(fn, *args)

    return result


@app.get("/api/resolve", tags=["data"])
def api_resolve(url: str):
    result = resolve_url(url)
    if not result:
        raise HTTPException(status_code=400, detail="Could not resolve URL")
    return result


@app.get("/health", tags=["ops"])
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002)
