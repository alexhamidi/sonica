#!/usr/bin/env python3
"""
Async download worker for mus using deemix (Deezer).

Pipeline:
  claim user_queued track → deemix download → WAV (80s 16kHz mono)
  → S3 upload + Gemini embedding (parallel)
  → batch Postgres write → finalize grandparent
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path

import aiobotocore.session as aio_boto
import asyncpg
import google.auth
import google.auth.transport.requests
import requests
from deezer import Deezer, TrackFormats
from deemix import generateDownloadObject
from deemix.downloader import Downloader
from deemix.settings import load as load_settings
from dotenv import load_dotenv
from PIL import Image

load_dotenv(Path(__file__).parent / ".env")

# ── config ─────────────────────────────────────────────────────────────────────

PG_URL = os.environ["POSTGRES_URL"]
GCP_PROJECT = os.getenv("GEMINI_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT", "sitescroll")
GCP_LOCATION = os.getenv("GEMINI_LOCATION", "us-central1")
AWS_KEY = os.getenv("aws_access_key_id") or os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET = os.getenv("aws_secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY", "")
S3_BUCKET = os.environ["S3_BUCKET"]

_arl_file = Path(__file__).resolve().parent.parent / "personal" / "arls.txt"
DEEZER_ARLS = _arl_file.read_text().splitlines() if _arl_file.exists() else []
DEEZER_ARLS = [arl.strip() for arl in DEEZER_ARLS if arl.strip()]
if not DEEZER_ARLS:
    DEEZER_ARLS = [os.environ["DEEZER_ARL"]]

EMBEDDING_MODEL = "gemini-embedding-2-preview"
AUDIO_DURATION = 80
COVER_SIZE = 256
CPU_CORES = 4
BATCH_SIZE = 100
BATCH_TIMEOUT = 30.0
DOWNLOAD_WORKERS = 20
EMBED_WORKERS = 12
BITRATE = TrackFormats.MP3_128
POLL_INTERVAL = 3
MAX_RETRIES = 3
REAP_INTERVAL = 60
REAP_TIMEOUT = 10
EMBED_QUEUE_SIZE = DOWNLOAD_WORKERS * 2

TMP_DIR = Path(__file__).resolve().parent / "tmp"

# ── logging ────────────────────────────────────────────────────────────────────

_log_dir = Path(__file__).parent / "logs"
_log_dir.mkdir(exist_ok=True)
_handler = RotatingFileHandler(
    _log_dir / "dl.log", maxBytes=50 * 1024 * 1024, backupCount=2
)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_handler, logging.StreamHandler()])
log = logging.getLogger(__name__)

# ── shared resources ───────────────────────────────────────────────────────────

ffmpeg_sem = threading.Semaphore(CPU_CORES)

_google_creds, _ = google.auth.default(
    scopes=["https://www.googleapis.com/auth/cloud-platform"]
)
_google_auth_req = google.auth.transport.requests.Request()
_EMBED_URL = (
    f"https://{GCP_LOCATION}-aiplatform.googleapis.com/v1beta1"
    f"/projects/{GCP_PROJECT}/locations/{GCP_LOCATION}"
    f"/publishers/google/models/{EMBEDDING_MODEL}:embedContent"
)

_thread_local = threading.local()
_login_lock = threading.Lock()


# ── data types ─────────────────────────────────────────────────────────────────


class EmbeddingError(Exception):
    pass


@dataclass(slots=True)
class DownloadedTrack:
    track_id: str
    artist: str
    title: str
    retry_count: int
    wav_bytes: bytes
    cover_bytes: bytes | None


class _SilentListener:
    @classmethod
    def send(cls, key, value=None):
        pass


# ── proxy loading ──────────────────────────────────────────────────────────────


def _load_proxy_urls() -> list[str]:
    proxy_file = Path(__file__).resolve().parent / "proxies.txt"
    if not proxy_file.exists():
        return []
    proxies: list[str] = []
    for raw in proxy_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":")
        if len(parts) == 4:
            host, port, user, password = parts
            proxies.append(f"socks5h://{user}:{password}@{host}:{port}")
        elif len(parts) == 2:
            proxies.append(f"socks5h://{line}")
    return proxies


DEEZER_PROXIES = _load_proxy_urls()


# ── sync helpers ───────────────────────────────────────────────────────────────


def _get_dz(worker_id: int) -> Deezer:
    if not getattr(_thread_local, "dz", None):
        with _login_lock:
            if not getattr(_thread_local, "dz", None):
                arl = DEEZER_ARLS[worker_id % len(DEEZER_ARLS)]
                last_error: Exception | None = None
                attempts = max(1, min(3, len(DEEZER_PROXIES) or 1))
                for attempt in range(attempts):
                    dz = Deezer()
                    if DEEZER_PROXIES:
                        proxy_idx = (worker_id + attempt) % len(DEEZER_PROXIES)
                        proxy_url = DEEZER_PROXIES[proxy_idx]
                        dz.session.proxies.update({"http": proxy_url, "https": proxy_url})
                        dz.session.trust_env = False
                    try:
                        if dz.login_via_arl(arl):
                            _thread_local.dz = dz
                            return dz
                        last_error = RuntimeError("ARL login returned false")
                    except Exception as e:
                        last_error = e
                    time.sleep(1)
                raise RuntimeError(
                    f"ARL {worker_id % len(DEEZER_ARLS)} login failed "
                    f"after {attempts} attempts: {last_error}"
                )
    return _thread_local.dz



def _download_sync(
    worker_id: int,
    track_id: str,
    deezer_id: int,
    cover_url: str | None = None,
) -> tuple[bytes, bytes | None] | None:
    """Download via deemix. Returns (wav_bytes, cover_bytes) or None on failure."""
    out_dir = TMP_DIR / f"dx_{track_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory() as config_dir:
            settings = load_settings(Path(config_dir))
            settings["downloadLocation"] = str(out_dir)

            dz = _get_dz(worker_id)
            url = f"https://www.deezer.com/track/{deezer_id}"
            obj = generateDownloadObject(dz, url, BITRATE, listener=_SilentListener)
            Downloader(dz, obj, settings, _SilentListener).start()

        files = list(out_dir.glob("*.mp3")) + list(out_dir.glob("*.flac"))
        if not files:
            log.warning("deemix produced no file deezer_id=%s track=%s", deezer_id, track_id)
            return None

        with ffmpeg_sem:
            proc = subprocess.run(
                [
                    "ffmpeg", "-y", "-i", str(files[0]),
                    "-map", "a:0", "-vn", "-sn", "-dn",
                    "-t", str(AUDIO_DURATION),
                    "-ar", "16000", "-ac", "1",
                    "-f", "wav", "pipe:1",
                ],
                capture_output=True,
                check=True,
            )

        return proc.stdout, _fetch_cover(cover_url)
    except Exception as e:
        log.warning("download failed deezer_id=%s track=%s: %s", deezer_id, track_id, e)
        return None
    finally:
        for f in out_dir.glob("*"):
            f.unlink(missing_ok=True)
        out_dir.rmdir()


def _fetch_cover(cover_url: str | None) -> bytes | None:
    if not cover_url:
        return None
    try:
        r = requests.get(cover_url, timeout=5, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        with Image.open(io.BytesIO(r.content)) as img:
            img = img.convert("RGB").resize((COVER_SIZE, COVER_SIZE), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        log.warning("cover fetch failed: %s", e)
        return None


def _embed_sync(wav_bytes: bytes) -> list[float]:
    """Gemini embedding via REST API. Retries rate limits indefinitely, 5xx up to 10x."""
    attempt = 0
    body = {
        "content": {
            "parts": [{
                "inlineData": {
                    "mimeType": "audio/wav",
                    "data": base64.b64encode(wav_bytes).decode(),
                }
            }]
        }
    }
    while True:
        try:
            _google_creds.refresh(_google_auth_req)
            resp = requests.post(
                _EMBED_URL,
                json=body,
                headers={"Authorization": f"Bearer {_google_creds.token}"},
                timeout=60,
            )
            if resp.status_code == 429:
                wait = min(60, 5 * (2 ** min(attempt, 4)))
                log.warning("gemini rate limit, retrying in %ds", wait)
                time.sleep(wait)
                attempt += 1
                continue
            if resp.status_code >= 500 and attempt < 10:
                wait = min(60, 5 * (2**attempt))
                log.warning("gemini %d, retrying in %ds", resp.status_code, wait)
                time.sleep(wait)
                attempt += 1
                continue
            resp.raise_for_status()
            return resp.json()["embedding"]["values"]
        except (KeyError, ValueError, requests.HTTPError) as e:
            raise EmbeddingError(str(e)) from e


def _finalize_grandparent(grandparent_id: str) -> None:
    """Sync wrapper for finalize_grandparent, run in thread pool executor."""
    try:
        from ingest import finalize_grandparent

        finalize_grandparent(grandparent_id)
    except Exception as e:
        log.error("finalize_grandparent failed for %s: %s", grandparent_id, e)


# ── batch writer ───────────────────────────────────────────────────────────────


class TrackBuffer:
    """
    Accumulates completed track results and bulk-writes to Postgres.
    After each flush, triggers finalize_grandparent for affected grandparents.
    """

    def __init__(self, pool: asyncpg.Pool, loop: asyncio.AbstractEventLoop) -> None:
        self._pool = pool
        self._loop = loop
        self._queue: list[tuple] = []
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
                       SET status = 'ready',
                           audio_s3 = $2,
                           cover_s3 = $3,
                           embedding = $4::halfvec,
                           error = NULL
                       WHERE id = $1::uuid""",
                    batch,
                )
            log.info("buffer: flushed %d rows", len(batch))

            track_ids = [row[0] for row in batch]
            async with self._pool.acquire() as conn:
                gp_rows = await conn.fetch(
                    """SELECT DISTINCT p.grandparent_id::text
                       FROM parent_tracks pt
                       JOIN parents p ON p.id = pt.parent_id
                       WHERE pt.track_id = ANY($1::uuid[])""",
                    track_ids,
                )
            for gp_row in gp_rows:
                asyncio.ensure_future(
                    self._loop.run_in_executor(
                        None, _finalize_grandparent, gp_row["grandparent_id"]
                    )
                )
        except Exception as e:
            log.error("buffer flush failed: %s", e)

    async def run_timer(self) -> None:
        while True:
            await asyncio.sleep(BATCH_TIMEOUT)
            async with self._lock:
                if self._queue and time.monotonic() - self._last >= BATCH_TIMEOUT:
                    await self._flush()


# ── background tasks ───────────────────────────────────────────────────────────


async def reaper(pool: asyncpg.Pool) -> None:
    """Reclaim tracks stuck in 'downloading'/'embedding' for longer than REAP_TIMEOUT minutes."""
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        try:
            async with pool.acquire() as conn:
                n = await conn.fetchval(
                    """WITH reclaimed AS (
                           UPDATE tracks
                           SET status = 'user_queued', claimed_at = NULL
                           WHERE status IN ('downloading', 'embedding')
                             AND claimed_at < NOW() - ($1 || ' minutes')::INTERVAL
                           RETURNING id
                       ) SELECT COUNT(*) FROM reclaimed""",
                    str(REAP_TIMEOUT),
                )
            if n:
                log.warning("reaper: reclaimed %d stuck rows", n)
        except Exception as e:
            log.error("reaper error: %s", e)


# ── workers ────────────────────────────────────────────────────────────────────


async def _mark_failed_or_retry(
    conn, row_id, retry_count: int, error: str | None = None
) -> None:
    new_status = "user_queued" if retry_count + 1 < MAX_RETRIES else "failed"
    err = error if new_status == "failed" else None
    await conn.execute(
        "UPDATE tracks SET status=$1, error=$2, retry_count=retry_count+1, claimed_at=NULL WHERE id=$3",
        new_status, err, row_id,
    )


async def download_worker(
    pool: asyncpg.Pool,
    worker_id: int,
    embed_queue: asyncio.Queue[DownloadedTrack],
    download_executor: ThreadPoolExecutor,
) -> None:
    log.info("download worker %d started", worker_id)
    loop = asyncio.get_running_loop()
    row = None

    while True:
        try:
            row = None

            # Claim one queued track
            async with pool.acquire() as conn:
                async with conn.transaction():
                    row = await conn.fetchrow(
                        """SELECT id, artist, title, retry_count, album_cover_url, deezer_id
                           FROM tracks
                           WHERE status = 'user_queued'
                           ORDER BY RANDOM()
                           FOR UPDATE SKIP LOCKED
                           LIMIT 1"""
                    )
                    if row:
                        await conn.execute(
                            "UPDATE tracks SET status='downloading', claimed_at=NOW() WHERE id=$1",
                            row["id"],
                        )

            if not row:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            track_id = str(row["id"])
            artist = row["artist"]
            title = row["title"]
            retry_count = row["retry_count"] or 0
            cover_url = row["album_cover_url"]
            deezer_id = row["deezer_id"]

            if not deezer_id:
                async with pool.acquire() as conn:
                    await _mark_failed_or_retry(
                        conn, row["id"], retry_count, "no deezer_id",
                    )
                continue

            result = await loop.run_in_executor(
                download_executor, _download_sync,
                worker_id, track_id, deezer_id, cover_url,
            )

            if result is None:
                async with pool.acquire() as conn:
                    await _mark_failed_or_retry(
                        conn, row["id"], retry_count,
                        f"deemix download failed after {MAX_RETRIES} attempts",
                    )
                continue

            wav_bytes, cover_bytes = result
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE tracks SET status='embedding' WHERE id=$1", row["id"],
                )
            await embed_queue.put(
                DownloadedTrack(
                    track_id=track_id,
                    artist=artist,
                    title=title,
                    retry_count=retry_count,
                    wav_bytes=wav_bytes,
                    cover_bytes=cover_bytes,
                )
            )
            log.info("download worker %d: queued [%s – %s]", worker_id, artist, title)

        except Exception as e:
            log.error("download worker %d: unexpected error: %s", worker_id, e)
            if row is not None:
                try:
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE tracks SET status='user_queued', claimed_at=NULL WHERE id=$1",
                            row["id"],
                        )
                except Exception as db_err:
                    log.error("download worker %d: failed to reset row: %s", worker_id, db_err)
            await asyncio.sleep(POLL_INTERVAL)


async def embed_worker(
    pool: asyncpg.Pool,
    worker_id: int,
    s3,
    buffer: TrackBuffer,
    embed_queue: asyncio.Queue[DownloadedTrack],
    embed_executor: ThreadPoolExecutor,
) -> None:
    log.info("embed worker %d started", worker_id)
    loop = asyncio.get_running_loop()

    while True:
        item = await embed_queue.get()
        try:
            async def _upload_audio() -> str:
                key = f"audio/{item.track_id}/audio.wav"
                await s3.put_object(
                    Bucket=S3_BUCKET, Key=key,
                    Body=item.wav_bytes, ContentType="audio/wav",
                )
                return key

            async def _upload_cover() -> str | None:
                if not item.cover_bytes:
                    return None
                key = f"audio/{item.track_id}/cover.jpg"
                await s3.put_object(
                    Bucket=S3_BUCKET, Key=key,
                    Body=item.cover_bytes, ContentType="image/jpeg",
                )
                return key

            async def _embed() -> list[float]:
                return await loop.run_in_executor(
                    embed_executor, _embed_sync, item.wav_bytes
                )

            audio_s3, cover_s3, embedding = await asyncio.gather(
                _upload_audio(), _upload_cover(), _embed()
            )
            await buffer.add(item.track_id, audio_s3, cover_s3, embedding)
            log.info("embed worker %d: done [%s – %s]", worker_id, item.artist, item.title)
        except Exception as e:
            log.error(
                "embed worker %d: pipeline failed [%s – %s]: %s",
                worker_id, item.artist, item.title, e,
            )
            async with pool.acquire() as conn:
                await _mark_failed_or_retry(
                    conn, item.track_id, item.retry_count, str(e)[:200]
                )
        finally:
            embed_queue.task_done()


# ── main ───────────────────────────────────────────────────────────────────────


async def run() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()
    pool = await asyncpg.create_pool(
        PG_URL, min_size=2, max_size=DOWNLOAD_WORKERS + EMBED_WORKERS + 4,
    )

    async with pool.acquire() as conn:
        await conn.execute(
            "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS album_cover_url TEXT"
        )
        await conn.execute(
            "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS deezer_id BIGINT"
        )

    buffer = TrackBuffer(pool, loop)
    embed_queue: asyncio.Queue[DownloadedTrack] = asyncio.Queue(maxsize=EMBED_QUEUE_SIZE)
    download_executor = ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS)
    embed_executor = ThreadPoolExecutor(max_workers=EMBED_WORKERS)

    log.info(
        "starting %d download workers, %d embed workers, %d Deezer ARLs, %d proxies",
        DOWNLOAD_WORKERS, EMBED_WORKERS, len(DEEZER_ARLS), len(DEEZER_PROXIES),
    )

    async with aio_boto.get_session().create_client(
        "s3", aws_access_key_id=AWS_KEY, aws_secret_access_key=AWS_SECRET,
    ) as s3:
        try:
            await asyncio.gather(
                reaper(pool),
                buffer.run_timer(),
                *[
                    download_worker(pool, i, embed_queue, download_executor)
                    for i in range(DOWNLOAD_WORKERS)
                ],
                *[
                    embed_worker(pool, i, s3, buffer, embed_queue, embed_executor)
                    for i in range(EMBED_WORKERS)
                ],
            )
        finally:
            await buffer.flush()
            await pool.close()
            download_executor.shutdown(wait=False, cancel_futures=True)
            embed_executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    asyncio.run(run())
