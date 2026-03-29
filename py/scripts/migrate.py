#!/usr/bin/env python3
"""
migrate.py

Migrates all local data/<spotify_id>/ directories into Postgres + S3.
Idempotent — safe to re-run.

Required env vars: POSTGRES_URL, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
"""

import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
import psycopg2
from dotenv import load_dotenv

load_dotenv()

DATA_DIR = Path(__file__).resolve().parent / "data"
S3_BUCKET = os.environ["S3_BUCKET"]
POSTGRES_URL = os.environ["POSTGRES_URL"]

s3_client = boto3.client("s3")

CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp": "application/octet-stream",
}


def upload(local: Path, key: str) -> str:
    ct = CONTENT_TYPES.get(local.suffix.lower(), "application/octet-stream")
    s3_client.upload_file(str(local), S3_BUCKET, key, ExtraArgs={"ContentType": ct})
    return key


def migrate_entity(conn, entity_dir: Path) -> None:
    meta_path = entity_dir / "metadata.json"
    if not meta_path.is_file():
        return

    meta = json.loads(meta_path.read_text())
    spotify_id = meta["id"]
    name = meta.get("name", "Unknown")

    print(f"\n{name} ({spotify_id})")

    cur = conn.cursor()

    # Upsert entity, get its UUID
    cur.execute(
        """
        INSERT INTO entities (spotify_id, type, name, status)
        VALUES (%s, 'playlist', %s, 'processing')
        ON CONFLICT (spotify_id) DO UPDATE SET status = 'processing'
        RETURNING id
        """,
        (spotify_id, name),
    )
    entity_id = cur.fetchone()[0]
    conn.commit()

    # Upload entity cover
    cover_s3 = None
    cover_path = entity_dir / meta["cover"] if meta.get("cover") else None
    if cover_path and cover_path.is_file():
        cover_s3 = upload(cover_path, f"entities/{entity_id}/cover{cover_path.suffix}")
        cur.execute(
            "UPDATE entities SET cover_s3 = %s WHERE id = %s", (cover_s3, entity_id)
        )
        conn.commit()

    # Skip if tracks already loaded
    cur.execute("SELECT COUNT(*) FROM tracks WHERE entity_id = %s", (entity_id,))
    if cur.fetchone()[0] > 0:
        print("  already migrated, skipping")
        cur.execute("UPDATE entities SET status = 'ready' WHERE id = %s", (entity_id,))
        conn.commit()
        cur.close()
        return

    raw_tracks = meta.get("tracks", [])

    # Pre-generate UUIDs so S3 keys are known before DB insert
    track_ids = [str(uuid.uuid4()) for _ in raw_tracks]

    # Upload all track files concurrently
    def upload_track(args):
        i, t, tid = args
        out = {}
        for rel, key_name, required in [
            (t.get("mp3"), f"tracks/{tid}/audio.mp3", True),
            (t.get("cover"), f"tracks/{tid}/cover.jpg", False),
            (t.get("embedding"), f"tracks/{tid}/embedding.mp", False),
        ]:
            if rel:
                p = entity_dir / rel
                if p.is_file():
                    out[key_name] = upload(p, key_name)
        return i, out

    jobs = [(i, t, track_ids[i]) for i, t in enumerate(raw_tracks)]
    uploads = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(upload_track, j): j[0] for j in jobs}
        done = 0
        for fut in as_completed(futures):
            i, result = fut.result()
            uploads[i] = result
            done += 1
            print(f"  [{done}/{len(jobs)}] {raw_tracks[i]['title']}")

    # Insert tracks
    for i, t in enumerate(raw_tracks):
        tid = track_ids[i]
        u = uploads.get(i, {})
        cur.execute(
            """
            INSERT INTO tracks (
                id, entity_id, title, artist,
                audio_s3, cover_s3, embedding_s3,
                umap_x, umap_y, tsne_x, tsne_y, pca_x, pca_y
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                tid,
                entity_id,
                t.get("title", ""),
                t.get("artist", ""),
                u.get(f"tracks/{tid}/audio.mp3"),
                u.get(f"tracks/{tid}/cover.jpg"),
                u.get(f"tracks/{tid}/embedding.mp"),
                t.get("umap_x"),
                t.get("umap_y"),
                t.get("tsne_x"),
                t.get("tsne_y"),
                t.get("pca_x"),
                t.get("pca_y"),
            ),
        )

    cur.execute("UPDATE entities SET status = 'ready' WHERE id = %s", (entity_id,))
    conn.commit()
    cur.close()
    print(f"  done — {len(raw_tracks)} tracks")


def main():
    conn = psycopg2.connect(POSTGRES_URL)
    dirs = [
        d
        for d in sorted(DATA_DIR.iterdir())
        if d.is_dir() and not d.name.startswith(".")
    ]
    print(f"Migrating {len(dirs)} entities...")
    for d in dirs:
        migrate_entity(conn, d)
    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
