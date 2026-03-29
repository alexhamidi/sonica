#!/usr/bin/env python3
"""
Recompute UMAP + PCA projections for all tracks with embeddings.
Uses PCA pre-reduction (→50 dims) before UMAP for speed.
Writes umap_x, umap_y, pca_x, pca_y back to the tracks table.

Usage:
    python reproject.py [--dry-run]
"""

import argparse
import os
import sys
import time

import numpy as np
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from sklearn.decomposition import PCA
import umap

load_dotenv()

POSTGRES_URL = os.environ["POSTGRES_URL"]
PCA_PREREDUCE_DIMS = 50  # pre-reduce before UMAP
BATCH_SIZE = 1000  # rows per UPDATE batch


def _normalize(coords: np.ndarray) -> np.ndarray:
    """Normalize to [0, 1] per axis."""
    mn = coords.min(axis=0)
    mx = coords.max(axis=0)
    rng = mx - mn
    rng[rng == 0] = 1
    return (coords - mn) / rng


def main(dry_run: bool = False):
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    print("Fetching track IDs + embeddings...")
    t0 = time.time()
    cur.execute("""
        SELECT id, embedding::text
        FROM tracks
        WHERE embedding IS NOT NULL
        ORDER BY id
    """)
    rows = cur.fetchall()
    print(f"  {len(rows)} tracks fetched in {time.time() - t0:.1f}s")

    if not rows:
        print("No tracks with embeddings found.")
        sys.exit(0)

    track_ids = [str(r["id"]) for r in rows]
    embeddings = np.array(
        [[float(v) for v in r["embedding"].strip("[]").split(",")] for r in rows],
        dtype=np.float32,
    )
    print(f"  Embedding matrix: {embeddings.shape}")

    # ── PCA 2D (final) ──────────────────────────────────────────────────────────
    print("Running PCA (2D)...")
    t0 = time.time()
    pca2 = PCA(n_components=2, random_state=42)
    pca_coords = _normalize(pca2.fit_transform(embeddings))
    print(f"  Done in {time.time() - t0:.1f}s")

    # ── PCA pre-reduction for UMAP ──────────────────────────────────────────────
    pre_dims = min(PCA_PREREDUCE_DIMS, embeddings.shape[1], len(rows) - 1)
    print(f"Running PCA pre-reduction ({pre_dims} dims)...")
    t0 = time.time()
    pca_pre = PCA(n_components=pre_dims, random_state=42)
    reduced = pca_pre.fit_transform(embeddings)
    print(
        f"  Done in {time.time() - t0:.1f}s  (explained variance: {pca_pre.explained_variance_ratio_.sum():.1%})"
    )

    # ── UMAP ────────────────────────────────────────────────────────────────────
    print("Running UMAP...")
    t0 = time.time()
    n_neighbors = min(15, len(rows) - 1)
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        min_dist=0.1,
        random_state=42,
        low_memory=True,
    )
    umap_coords = _normalize(reducer.fit_transform(reduced))
    print(f"  Done in {time.time() - t0:.1f}s")

    if dry_run:
        print("Dry run — skipping DB writes.")
        return

    # ── Write back ───────────────────────────────────────────────────────────────
    print("Writing to DB...")
    t0 = time.time()
    cur2 = conn.cursor()
    batch = []
    for i, tid in enumerate(track_ids):
        batch.append(
            (
                round(float(umap_coords[i, 0]), 6),
                round(float(umap_coords[i, 1]), 6),
                round(float(pca_coords[i, 0]), 6),
                round(float(pca_coords[i, 1]), 6),
                tid,
            )
        )
        if len(batch) == BATCH_SIZE:
            psycopg2.extras.execute_batch(
                cur2,
                """
                UPDATE tracks SET umap_x=%s, umap_y=%s, pca_x=%s, pca_y=%s WHERE id=%s::uuid
            """,
                batch,
            )
            conn.commit()
            print(f"  {i + 1}/{len(track_ids)}")
            batch = []

    if batch:
        psycopg2.extras.execute_batch(
            cur2,
            """
            UPDATE tracks SET umap_x=%s, umap_y=%s, pca_x=%s, pca_y=%s WHERE id=%s::uuid
        """,
            batch,
        )
        conn.commit()

    cur.close()
    cur2.close()
    conn.close()
    print(f"  Done in {time.time() - t0:.1f}s. {len(track_ids)} tracks updated.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    main(dry_run=args.dry_run)
