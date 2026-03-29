"""bench_search.py — embed a text query and return top-5 nearest tracks with timing."""

import os
import sys
import time

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
POSTGRES_URL = os.environ["POSTGRES_URL"]
GEMINI_PROJECT_ID = os.getenv("GEMINI_PROJECT_ID", "sitescroll")
GEMINI_LOCATION = os.getenv("GEMINI_LOCATION", "us-central1")
EMBEDDING_MODEL = "gemini-embedding-2-preview"

client = genai.Client(vertexai=True, project=GEMINI_PROJECT_ID, location=GEMINI_LOCATION)


def run(query: str, k: int = 5) -> None:
    print(f"query : {query!r}")
    print(f"model : {EMBEDDING_MODEL}\n")

    t0 = time.perf_counter()
    result = client.models.embed_content(
        model=EMBEDDING_MODEL, contents=[types.Part(text=query)]
    )
    emb = result.embeddings[0].values
    t_embed = time.perf_counter() - t0
    print(f"embed : {t_embed * 1000:.0f} ms  ({len(emb)}-dim)")

    emb_str = "[" + ",".join(f"{v:.8g}" for v in emb) + "]"

    t1 = time.perf_counter()
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT t.id, t.title, t.artist,
               (t.embedding <=> %s::halfvec) AS distance
        FROM tracks t
        WHERE t.embedding IS NOT NULL
        ORDER BY t.embedding <=> %s::halfvec
        LIMIT %s
        """,
        (emb_str, emb_str, k),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    t_search = time.perf_counter() - t1

    print(f"search: {t_search * 1000:.0f} ms  ({k} results)\n")
    print(f"{'dist':>6}  {'artist':<28}  title")
    print("-" * 64)
    for r in rows:
        print(
            f"{r['distance']:6.4f}  {(r['artist'] or '')[:28]:<28}  {r['title'] or ''}"
        )

    print(f"\ntotal : {(t_embed + t_search) * 1000:.0f} ms")


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "hypertechno"
    run(q)
