#!/usr/bin/env python3
"""
User-space projection (UMAP / PCA / t-SNE) and query embedding for search.

Used by server.py: POST /api/search (embed_query + project_grandparent),
POST /api/reproject (per-grandparent, e.g. search), and POST /api/reproject-user
(full library for one user — Next.js calls this after POST /api/me/add-bulk).
"""

from __future__ import annotations

import os

import numpy as np
import psycopg2
import psycopg2.extras
import umap
from dotenv import load_dotenv
from google import genai
from google.genai import types
from sklearn.decomposition import PCA

load_dotenv()

POSTGRES_URL = os.environ["POSTGRES_URL"]
GEMINI_PROJECT_ID = os.getenv("GEMINI_PROJECT_ID", "sitescroll")
GEMINI_LOCATION = os.getenv("GEMINI_LOCATION", "us-central1")
EMBEDDING_MODEL = "gemini-embedding-2-preview"

gemini_client = genai.Client(
    vertexai=True, project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION
)


def _normalize(coords: np.ndarray) -> np.ndarray:
    lo, hi = coords.min(axis=0), coords.max(axis=0)
    rng = hi - lo
    rng[rng == 0] = 1
    return (coords - lo) / rng


def compute_projections(embeddings: np.ndarray) -> dict[str, np.ndarray]:
    from sklearn.preprocessing import normalize as sk_normalize

    n = len(embeddings)
    if n < 2:
        placeholder = np.array([[0.5, 0.5]] * n)
        return {"umap": placeholder, "pca": placeholder}

    normed = sk_normalize(embeddings, norm="l2")

    result: dict[str, np.ndarray] = {}
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


def project_user(user_id: str) -> None:
    """
    Recompute UMAP+PCA+t-SNE for one user's entire linked library (all ready tracks with embeddings).
    Clears prior user_track_projections for that user and sets all their user_grandparents to projected.
    """
    conn = psycopg2.connect(POSTGRES_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
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
            cur.execute(
                """UPDATE user_grandparents SET projected = true
                   WHERE user_id::text = %s""",
                (user_id,),
            )
            conn.commit()
            cur.close()
            print(f"[project] user {user_id[:8]}: no embeddable tracks, marked projected")
            return

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
                    round(float(umap_coords[i, 0]), 6) if umap_coords is not None else None,
                    round(float(umap_coords[i, 1]), 6) if umap_coords is not None else None,
                    round(float(pca_coords[i, 0]), 6) if pca_coords is not None else None,
                    round(float(pca_coords[i, 1]), 6) if pca_coords is not None else None,
                    round(float(tsne_coords[i, 0]), 6) if tsne_coords is not None else None,
                    round(float(tsne_coords[i, 1]), 6) if tsne_coords is not None else None,
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
        cur.close()
        print(f"[project] projected {len(ids)} tracks for user {user_id[:8]}")
    finally:
        conn.close()


def project_grandparent(grandparent_id: str) -> None:
    """
    Recompute layout for every user who still has projected=false on this grandparent
    (e.g. after search). Runs a full-library project_user for each such user.
    """
    users: list[str] = []
    conn = psycopg2.connect(POSTGRES_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT status FROM grandparents WHERE id = %s::uuid",
            (grandparent_id,),
        )
        gp = cur.fetchone()
        if gp and gp["status"] == "ready":
            cur.execute(
                "SELECT user_id::text FROM user_grandparents WHERE grandparent_id = %s AND projected = false",
                (grandparent_id,),
            )
            users = [r["user_id"] for r in cur.fetchall()]
        cur.close()
    finally:
        conn.close()

    for uid in users:
        project_user(uid)


def embed_query(
    text: str | None = None,
    audio_bytes: bytes | None = None,
    mime_type: str = "audio/wav",
) -> list[float]:
    if text:
        part = types.Part(text=text)
    elif audio_bytes:
        part = types.Part.from_bytes(data=audio_bytes, mime_type=mime_type)
    else:
        raise ValueError("Provide text or audio_bytes")
    result = gemini_client.models.embed_content(model=EMBEDDING_MODEL, contents=[part])
    return result.embeddings[0].values
