#!/usr/bin/env python3
"""
Full pipeline per worker:
  search → download → WAV (80s 16kHz mono, ffmpeg_sem)
  → asyncio.gather(S3 audio upload, S3 cover upload, Gemini embedding)
  → batch Postgres write (every 100 songs or 30 s)
  → cleanup
"""

import asyncio
import io
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path

import aiobotocore.session as aio_boto
import asyncpg
import requests
import yt_dlp
from google import genai
from google.genai import types
from PIL import Image


# ── env ────────────────────────────────────────────────────────────────────────
def _load_env_key(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return None
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == key:
            return v.strip()
    return None


def _load_proxies(filename: str) -> list[str]:
    proxy_file = Path(__file__).resolve().parent.parent / filename
    if not proxy_file.is_file():
        return []
    proxies = []
    for line in proxy_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        host, port, user, pwd = line.split(":")
        proxies.append(f"http://{user}:{pwd}@{host}:{port}")
    return proxies


PG_URL = _load_env_key("POSTGRES_URL") or ""
GCP_PROJECT = _load_env_key("GOOGLE_CLOUD_PROJECT") or "sitescroll"
AWS_KEY = _load_env_key("aws_access_key_id")
AWS_SECRET = _load_env_key("aws_secret_access_key")

US_PROXY_IPS = {
    "9.142.40.203",
    "9.142.215.3",
    "138.226.88.249",
    "9.142.34.159",
    "45.56.183.205",
    "192.53.70.229",
    "192.46.190.109",
    "192.53.66.38",
    "9.142.218.133",
    "192.46.185.132",
}


def _load_us_proxies() -> list[str]:
    proxies = []
    for line in _load_proxies("proxies.txt"):
        # line is http://user:pw@host:port — extract host
        host = line.split("@")[1].split(":")[0]
        if host in US_PROXY_IPS:
            proxies.append(line)
    return proxies


# ── constants ──────────────────────────────────────────────────────────────────
BUCKET = "mus-media"
S3_PREFIX = "audio"
TMP_DIR = Path(__file__).resolve().parent / "tmp"
EMBEDDING_MODEL = "gemini-embedding-2-preview"
GCP_LOCATION = "us-central1"

AUDIO_DURATION = 80  # seconds to clip
COVER_SIZE = 256  # px, square JPEG
CPU_CORES = 16  # max concurrent FFmpeg processes
BATCH_SIZE = 100  # DB rows per flush
BATCH_TIMEOUT = 30.0  # flush even if batch not full
WORKERS_PER_PROXY = 8
GEMINI_RPM = 35  # stay under 100k tokens/min ÷ ~2560 tokens/track ≈ 39/min

PROXIES = _load_us_proxies()
NUM_WORKERS = len(PROXIES) * WORKERS_PER_PROXY
NUM_DL = None
POLL_INTERVAL = 3
MAX_RETRIES = 3
REAP_INTERVAL = 60
REAP_TIMEOUT = 10  # minutes


_log_dir = Path(__file__).resolve().parent / "logs" / "dl"
_log_dir.mkdir(parents=True, exist_ok=True)
_handler = RotatingFileHandler(
    _log_dir / "dl.log", maxBytes=50 * 1024 * 1024, backupCount=2
)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_handler, logging.StreamHandler()])
log = logging.getLogger(__name__)

ffmpeg_sem = threading.Semaphore(CPU_CORES)
_gemini = genai.Client(vertexai=True, project=GCP_PROJECT, location=GCP_LOCATION)


class EmbeddingError(Exception):
    pass


class RateLimiter:
    """Token-bucket rate limiter for async code."""

    def __init__(self, rate: int, period: float = 60.0) -> None:
        self._rate = rate
        self._period = period
        self._tokens = 0.0  # start empty to avoid startup burst
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            self._tokens = min(
                self._rate,
                self._tokens + (now - self._last) * self._rate / self._period,
            )
            self._last = now
            if self._tokens < 1:
                wait = (1 - self._tokens) * self._period / self._rate
                await asyncio.sleep(wait)
                self._tokens = 0.0
            else:
                self._tokens -= 1


_gemini_limiter: RateLimiter  # initialised in run()


# ── sync helpers (run in thread pool) ─────────────────────────────────────────
def _download_sync(
    track_id: str,
    artist: str,
    title: str,
    proxy: str | None,
    cover_url: str | None = None,
) -> tuple[bytes, bytes | None] | None:
    """
    Phase 1: metadata via assigned proxy (no semaphore).
    Phase 2: download + WAV conversion direct/no-proxy (ffmpeg_sem).
    Returns (wav_bytes, cover_jpeg_bytes | None) or None on failure.
    """
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = TMP_DIR / f"{track_id}.wav"

    # Resume: file already converted from a previous partial run
    if wav_path.exists():
        wav_bytes = wav_path.read_bytes()
        cover_bytes = _fetch_spotify_cover(cover_url) if cover_url else None
        wav_path.unlink(missing_ok=True)
        return wav_bytes, cover_bytes

    # Phase 1 — metadata via assigned proxy
    try:
        with yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "proxy": proxy,
                "match_filter": yt_dlp.utils.match_filter_func("duration < 480"),
            }
        ) as ydl:
            info = ydl.extract_info(f"scsearch1:{title} - {artist}", download=False)
    except yt_dlp.utils.DownloadError as e:
        log.warning("metadata failed [%s - %s]: %s", artist, title, e)
        return None
    except Exception as e:
        log.warning("metadata error [%s - %s]: %s", artist, title, e)
        return None

    if not info or not info.get("entries"):
        log.warning("no results [%s - %s]", artist, title)
        return None

    webpage_url = info["entries"][0]["webpage_url"]

    # Phase 2 — download + FFmpeg direct, CPU-bounded by semaphore
    with ffmpeg_sem:
        try:
            with yt_dlp.YoutubeDL(
                {
                    "format": "bestaudio/best",
                    "outtmpl": str(TMP_DIR / f"{track_id}.%(ext)s"),
                    "quiet": True,
                    "no_warnings": True,
                    "retries": 0,
                    "proxy": None,
                    "download_ranges": lambda _, __: [
                        {"start_time": 0, "end_time": AUDIO_DURATION}
                    ],
                    "force_keyframes_at_cuts": True,
                    "writethumbnail": True,
                    "postprocessors": [
                        {"key": "FFmpegExtractAudio", "preferredcodec": "wav"}
                    ],
                    "postprocessor_args": {"ffmpeg": ["-ac", "1", "-ar", "16000"]},
                }
            ) as ydl:
                ydl.download([webpage_url])
        except yt_dlp.utils.DownloadError as e:
            log.warning("download failed [%s - %s]: %s", artist, title, e)
            return None
        except Exception as e:
            log.warning("download error [%s - %s]: %s", artist, title, e)
            return None

    if not wav_path.exists():
        log.warning("wav missing after download [%s - %s]", artist, title)
        return None

    wav_bytes = wav_path.read_bytes()
    cover_bytes = _fetch_spotify_cover(cover_url) if cover_url else None
    wav_path.unlink(missing_ok=True)
    return wav_bytes, cover_bytes


def _fetch_spotify_cover(cover_url: str | None) -> bytes | None:
    """Download Spotify cover URL, resize to COVER_SIZE×COVER_SIZE, return JPEG bytes."""
    if not cover_url:
        return None
    try:
        r = requests.get(cover_url, timeout=5)
        if r.status_code != 200:
            return None
        with Image.open(io.BytesIO(r.content)) as img:
            img = img.convert("RGB").resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        log.warning("spotify cover fetch failed %s: %s", cover_url[:50], e)
        return None


def _read_cover(track_id: str) -> bytes | None:
    """Find yt-dlp thumbnail, resize to COVER_SIZE×COVER_SIZE, return JPEG bytes."""
    for ext in (".jpg", ".jpeg", ".webp", ".png"):
        p = TMP_DIR / f"{track_id}{ext}"
        if not p.exists():
            continue
        try:
            with Image.open(p) as img:
                img = img.convert("RGB").resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
            return buf.getvalue()
        except Exception as e:
            log.warning("cover resize failed %s: %s", track_id, e)
        finally:
            p.unlink(missing_ok=True)
    return None


def _embed_sync(wav_bytes: bytes) -> list[float]:
    """Call Gemini embedding API. Retries on 429, 500, and other transient errors."""
    attempt = 0
    while True:
        try:
            result = _gemini.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=[types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav")],
            )
            return result.embeddings[0].values
        except Exception as e:
            err_str = str(e)
            is_retryable = (
                "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "500" in err_str
            )

            if is_retryable and attempt < 10:  # max 10 retries
                wait = min(60, 5 * (2**attempt))  # 5, 10, 20, 40, 60, 60, ...
                if "500" in err_str:
                    log.warning(
                        "gemini 500, retrying in %ds (attempt %d)", wait, attempt + 1
                    )
                else:
                    log.warning(
                        "gemini rate limit, retrying in %ds (attempt %d)",
                        wait,
                        attempt + 1,
                    )
                time.sleep(wait)
                attempt += 1
            else:
                raise EmbeddingError(str(e)) from e


# ── batch writer ───────────────────────────────────────────────────────────────
class BatchWriter:
    """
    Thread-safe async batch writer. Workers call add(); a background coroutine
    also flushes every BATCH_TIMEOUT seconds to avoid long stalls at end-of-run.
    """

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool
        self._queue: list[tuple[str, str, str | None, str]] = []
        self._lock = asyncio.Lock()
        self._last = time.monotonic()

    async def add(
        self, track_id: str, audio_s3: str, cover_s3: str | None, embedding: list[float]
    ) -> None:
        emb_str = "[" + ",".join(f"{v:.8g}" for v in embedding) + "]"
        async with self._lock:
            self._queue.append((track_id, audio_s3, cover_s3, emb_str))
            if len(self._queue) >= BATCH_SIZE:
                await self._flush()

    async def flush(self) -> None:
        async with self._lock:
            await self._flush()

    async def _flush(self) -> None:
        if not self._queue:
            return
        batch, self._queue = self._queue, []
        self._last = time.monotonic()
        try:
            async with self._pool.acquire() as conn:
                await conn.executemany(
                    """UPDATE tracks
                       SET status='complete', audio_s3=$2, cover_s3=$3,
                           embedding=$4, error=NULL
                       WHERE id=$1::uuid""",
                    batch,
                )
            log.info("batch: flushed %d rows", len(batch))
        except Exception as e:
            log.error("batch flush failed: %s", e)

    async def run_timer(self) -> None:
        while True:
            await asyncio.sleep(BATCH_TIMEOUT)
            async with self._lock:
                if self._queue and time.monotonic() - self._last >= BATCH_TIMEOUT:
                    await self._flush()


# ── workers ────────────────────────────────────────────────────────────────────
async def reaper(pool: asyncpg.Pool) -> None:
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        try:
            async with pool.acquire() as conn:
                n = await conn.fetchval(
                    """WITH reclaimed AS (
                           UPDATE tracks SET status='queued', claimed_at=NULL
                           WHERE status='downloading'
                             AND claimed_at < NOW() - ($1 || ' minutes')::INTERVAL
                           RETURNING id
                       ) SELECT COUNT(*) FROM reclaimed""",
                    str(REAP_TIMEOUT),
                )
            if n:
                log.warning("reaper: reclaimed %d stuck rows", n)
        except Exception as e:
            log.error("reaper error: %s", e)


async def dl_worker(
    pool: asyncpg.Pool,
    worker_id: int,
    proxy: str | None,
    s3,
    batch: BatchWriter,
    loop: asyncio.AbstractEventLoop,
    counter: list[int],
    counter_lock: asyncio.Lock,
) -> None:
    log.info("worker %d started", worker_id)

    while True:
        try:
            if NUM_DL is not None:
                async with counter_lock:
                    if counter[0] >= NUM_DL:
                        return
            # ── claim a queued track ───────────────────────────────────────────
            async with pool.acquire() as conn:
                async with conn.transaction():
                    row = await conn.fetchrow("""
                        SELECT id, artist, title, retry_count, album_cover_url FROM tracks
                        WHERE status='queued'
                        ORDER BY artist
                        FOR UPDATE SKIP LOCKED LIMIT 1
                    """)
                    if not row:
                        pass
                    else:
                        await conn.execute(
                            "UPDATE tracks SET status='downloading', claimed_at=NOW() WHERE id=$1",
                            row["id"],
                        )

            if not row:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            if NUM_DL is not None:
                async with counter_lock:
                    counter[0] += 1

            track_id = str(row["id"])
            artist = row["artist"]
            title = row["title"]
            retry_count = row["retry_count"]
            cover_url = row.get("album_cover_url")

            # ── Phase 1+2: search + download + WAV conversion (thread) ─────────
            result = await loop.run_in_executor(
                None, _download_sync, track_id, artist, title, proxy, cover_url
            )

            if result is None:
                new_status = "queued" if retry_count + 1 < MAX_RETRIES else "failed"
                err = (
                    None
                    if new_status == "queued"
                    else f"download failed after {MAX_RETRIES} attempts"
                )
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE tracks SET status=$1, error=$2, retry_count=retry_count+1 WHERE id=$3",
                        new_status,
                        err,
                        row["id"],
                    )
                continue

            wav_bytes, cover_bytes = result

            # ── Phase 3: S3 (audio + cover) and Gemini embedding in parallel ───
            async def _upload_audio() -> str:
                key = f"{S3_PREFIX}/{track_id}/audio.wav"
                await s3.put_object(
                    Bucket=BUCKET, Key=key, Body=wav_bytes, ContentType="audio/wav"
                )
                return key

            async def _upload_cover() -> str | None:
                if not cover_bytes:
                    return None
                key = f"{S3_PREFIX}/{track_id}/cover.jpg"
                await s3.put_object(
                    Bucket=BUCKET, Key=key, Body=cover_bytes, ContentType="image/jpeg"
                )
                return key

            async def _embed() -> list[float]:
                await _gemini_limiter.acquire()
                return await loop.run_in_executor(None, _embed_sync, wav_bytes)

            try:
                audio_s3, cover_s3, embedding = await asyncio.gather(
                    _upload_audio(), _upload_cover(), _embed()
                )
            except EmbeddingError as e:
                log.critical("embedding failed, shutting down: %s", e)
                raise SystemExit(1)
            except Exception as e:
                log.error(
                    "worker %d: pipeline failed [%s - %s]: %s",
                    worker_id,
                    artist,
                    title,
                    e,
                )
                new_status = "queued" if retry_count + 1 < MAX_RETRIES else "failed"
                err = None if new_status == "queued" else str(e)[:200]
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE tracks SET status=$1, error=$2, retry_count=retry_count+1 WHERE id=$3",
                        new_status,
                        err,
                        row["id"],
                    )
                continue

            # ── Phase 4: enqueue for batch DB write ────────────────────────────
            await batch.add(track_id, audio_s3, cover_s3, embedding)
            log.info("worker %d: [%s - %s] done", worker_id, artist, title)

        except Exception as e:
            log.error("worker %d unexpected error: %s", worker_id, e)
            await asyncio.sleep(POLL_INTERVAL)


# ── main ───────────────────────────────────────────────────────────────────────
async def run() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=NUM_WORKERS)
    loop.set_default_executor(executor)

    pool = await asyncpg.create_pool(PG_URL, min_size=2, max_size=NUM_WORKERS + 4)

    global _gemini_limiter
    _gemini_limiter = RateLimiter(rate=GEMINI_RPM)

    batch = BatchWriter(pool)
    boto = aio_boto.get_session()
    counter = [0]
    counter_lock = asyncio.Lock()

    log.info(
        "starting %d workers (%d proxies × %d)",
        NUM_WORKERS,
        len(PROXIES),
        WORKERS_PER_PROXY,
    )

    # assign proxies round-robin across worker groups, matching test_ratelimit.py
    worker_proxies = [PROXIES[i // WORKERS_PER_PROXY] for i in range(NUM_WORKERS)]

    async with boto.create_client(
        "s3",
        aws_access_key_id=AWS_KEY,
        aws_secret_access_key=AWS_SECRET,
    ) as s3:
        try:
            await asyncio.gather(
                reaper(pool),
                batch.run_timer(),
                *[
                    dl_worker(
                        pool,
                        i,
                        worker_proxies[i],
                        s3,
                        batch,
                        loop,
                        counter,
                        counter_lock,
                    )
                    for i in range(NUM_WORKERS)
                ],
            )
        finally:
            await batch.flush()  # drain any remaining rows on exit
            await pool.close()


if __name__ == "__main__":
    asyncio.run(run())
