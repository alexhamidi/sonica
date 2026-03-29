#!/usr/bin/env python3
"""
Projection benchmark: fetch embeddings from 3 random artist grandparents,
run UMAP + PCA with tweakable params, report timing.

Usage:
    python bench_proj.py [--runs N] [--n-neighbors K] [--min-dist D] [--metric M]
"""

import argparse
import os
import time
from pathlib import Path

import numpy as np
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import normalize
import umap

load_dotenv(Path(__file__).parent / ".env")
POSTGRES_URL = os.environ["POSTGRES_URL"]

# ── params ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--runs", type=int, default=3, help="number of timed runs")
parser.add_argument("--n-neighbors", type=int, default=15, help="UMAP n_neighbors")
parser.add_argument("--min-dist", type=float, default=0.1, help="UMAP min_dist")
parser.add_argument("--metric", type=str, default="cosine", help="UMAP metric")
parser.add_argument("--n-components", type=int, default=2, help="output dims")
parser.add_argument("--low-memory", action="store_true", help="UMAP low_memory mode")
args = parser.parse_args()

# ── fetch embeddings ────────────────────────────────────────────────────────────

print("connecting to db...")
conn = psycopg2.connect(POSTGRES_URL)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

cur.execute("""
    SELECT gp.id, gp.name, COUNT(t.id) AS track_count
    FROM grandparents gp
    JOIN parents p ON p.grandparent_id = gp.id
    JOIN parent_tracks pt ON pt.parent_id = p.id
    JOIN tracks t ON t.id = pt.track_id
    WHERE t.embedding IS NOT NULL
    GROUP BY gp.id, gp.name
    HAVING COUNT(t.id) >= 5
    ORDER BY RANDOM()
    LIMIT 10
""")
grandparents = cur.fetchall()

if not grandparents:
    print("no artist grandparents with complete tracks found")
    cur.close()
    conn.close()
    exit(1)

print("\nselected grandparents:")
for gp in grandparents:
    print(f"  {gp['name']} — {gp['track_count']} tracks")

gp_ids = [str(gp["id"]) for gp in grandparents]
cur.execute(
    """
    SELECT t.id::text, t.embedding::text
    FROM parent_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    JOIN parents p ON p.id = pt.parent_id
    WHERE p.grandparent_id = ANY(%s::uuid[])
      AND t.embedding IS NOT NULL
""",
    (gp_ids,),
)
rows = cur.fetchall()
cur.close()
conn.close()

print(f"\nloaded {len(rows)} embeddings — parsing...")
t0 = time.perf_counter()
embeddings = np.array(
    [list(map(float, r["embedding"].strip("[]").split(","))) for r in rows],
    dtype=np.float32,
)
print(f"parse: {time.perf_counter() - t0:.3f}s  shape: {embeddings.shape}")

# L2-normalize for cosine metric (faster than computing cosine directly)
if args.metric == "cosine":
    embeddings = normalize(embeddings, norm="l2")
    effective_metric = "euclidean"
else:
    effective_metric = args.metric

n = len(embeddings)

# ── benchmark ──────────────────────────────────────────────────────────────────


def _norm(coords):
    lo, hi = coords.min(axis=0), coords.max(axis=0)
    rng = hi - lo
    rng[rng == 0] = 1
    return (coords - lo) / rng


umap_times, pca_times = [], []

for run in range(1, args.runs + 1):
    print(f"\n── run {run}/{args.runs} ──────────────────────────────────")

    # PCA
    t0 = time.perf_counter()
    pca = PCA(n_components=args.n_components)
    pca_coords = _norm(pca.fit_transform(embeddings))
    pca_t = time.perf_counter() - t0
    pca_times.append(pca_t)
    print(
        f"  PCA   {pca_t:.3f}s  variance explained: {pca.explained_variance_ratio_.sum():.1%}"
    )

    # UMAP
    t0 = time.perf_counter()
    reducer = umap.UMAP(
        n_components=args.n_components,
        n_neighbors=min(args.n_neighbors, n - 1),
        min_dist=args.min_dist,
        metric=effective_metric,
        low_memory=args.low_memory,
        n_jobs=-1,
        verbose=False,
    )
    umap_coords = _norm(reducer.fit_transform(embeddings))
    umap_t = time.perf_counter() - t0
    umap_times.append(umap_t)
    print(f"  UMAP  {umap_t:.3f}s")

    # t-SNE (Barnes-Hut)
    t0 = time.perf_counter()
    tsne = TSNE(
        n_components=2, method="barnes_hut", perplexity=min(30, n // 3), n_jobs=-1
    )
    tsne_coords = _norm(tsne.fit_transform(embeddings))
    tsne_t = time.perf_counter() - t0
    print(f"  t-SNE {tsne_t:.3f}s")

print(f"\n── summary ({n} tracks, {embeddings.shape[1]}d embeddings) ──────────────")
print(
    f"  params: n_neighbors={args.n_neighbors}  min_dist={args.min_dist}  metric={args.metric}  low_memory={args.low_memory}"
)
print(
    f"  PCA   avg={sum(pca_times) / len(pca_times):.3f}s  min={min(pca_times):.3f}s  max={max(pca_times):.3f}s"
)
print(
    f"  UMAP  avg={sum(umap_times) / len(umap_times):.3f}s  min={min(umap_times):.3f}s  max={max(umap_times):.3f}s"
)
