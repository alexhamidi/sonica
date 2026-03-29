"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { pastelFromId } from "@/lib/pastelFromId";
import { Track } from "./TrackTile";

interface Props {
  track: Track;
  /** Render without outer card — content only, for embedding inside another card. */
  embedded?: boolean;
  /** Canvas: run similar-by-embedding search (requires `track.trackId`). */
  onSearchSimilar?: (track: Track) => void | Promise<void>;
  similarBusy?: boolean;
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

type QueryKind =
  | "similar"
  | "recommended"
  | "text"
  | "audio"
  | "video"
  | "image";

function normalizeQueryKind(k: string | null | undefined): QueryKind {
  if (
    k === "similar" ||
    k === "recommended" ||
    k === "text" ||
    k === "audio" ||
    k === "video" ||
    k === "image"
  )
    return k;
  return "text";
}

const QUERY_KIND_LABEL: Record<QueryKind, string> = {
  similar: "Similar",
  recommended: "Recommended",
  text: "Text",
  audio: "Audio",
  video: "Video",
  image: "Image",
};

export default function Player({
  track,
  embedded,
  onSearchSimilar,
  similarBusy = false,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!track.mp3 || track.isQuery) {
      audio.pause();
      audio.removeAttribute("src");
      setPlaying(false);
      return;
    }
    audio.src = track.mp3;
    setProgress(0);
    setDuration(0);
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  }, [track.index, track.mp3, track.isQuery]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (audioRef.current) setProgress(audioRef.current.currentTime);
      });
    };
    const onDur = () => setDuration(audio.duration);
    const onEnd = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDur);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDur);
      audio.removeEventListener("ended", onEnd);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio
        .play()
        .then(() => setPlaying(true))
        .catch(() => {});
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = (parseFloat(e.target.value) / 100) * duration;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  const swatchId = track.trackId ?? `t-${track.index}`;
  const queryPastel = pastelFromId(swatchId);

  const queryKind = track.isQuery
    ? normalizeQueryKind(track.sourceQueryKind)
    : null;
  const artistLine =
    queryKind !== null
      ? `Search (${QUERY_KIND_LABEL[queryKind]})`
      : track.artist;

  const content = (
    <div
      className="flex items-center gap-2"
      style={{ fontFamily: "var(--font-nunito)" }}
    >
      {/* Cover */}
      <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-lg bg-zinc-800">
        {track.cover ? (
          <Image
            src={track.cover}
            alt={track.title}
            fill
            sizes="32px"
            className="object-cover"
            draggable={false}
          />
        ) : track.isQuery ? (
          <div className="h-full w-full" style={{ background: queryPastel }} />
        ) : null}
      </div>
      {/* Title + artist */}
      <div className="min-w-0 w-24 flex-shrink-0">
        <p className="truncate text-[12px] font-semibold leading-tight text-white">
          {track.title}
        </p>
        <p
          className="truncate text-[10px] font-medium"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          {artistLine}
        </p>
      </div>
      {track.isQuery ? (
        <>
          <div
            className="pointer-events-none flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent"
            aria-hidden
          />
          <span
            className="invisible shrink-0 text-[10px] font-medium tabular-nums select-none"
            style={{ color: "rgba(255,255,255,0.3)" }}
            aria-hidden
          >
            0:00
          </span>
          <div
            className="invisible relative h-[3px] w-24 shrink-0 overflow-hidden rounded-full"
            style={{ background: "rgba(255,255,255,0.08)" }}
            aria-hidden
          />
          <span
            className="invisible shrink-0 text-[10px] font-medium tabular-nums select-none"
            style={{ color: "rgba(255,255,255,0.3)" }}
            aria-hidden
          >
            0:00
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={togglePlay}
            disabled={!track.mp3}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full outline-none ring-0 ring-offset-0 transition-colors hover:bg-white/10 focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
            style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          >
            {playing ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="white"
                aria-hidden
              >
                <rect x="5.5" y="4" width="5" height="16" rx="2.5" />
                <rect x="13.5" y="4" width="5" height="16" rx="2.5" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="white"
                aria-hidden
                style={{ marginLeft: "0px" }}
              >
                <path d="M8.25 6.35c0-1.12 1.22-1.82 2.2-1.26l8.55 5.05c.98.58.98 2.04 0 2.62l-8.55 5.05c-.98.56-2.2-.14-2.2-1.26V6.35z" />
              </svg>
            )}
          </button>
          <span
            className="flex-shrink-0 text-[10px] font-medium tabular-nums"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            {fmt(progress)}
          </span>
          <div
            className="relative h-[3px] w-24 flex-shrink-0 rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${pct}%`, background: "rgba(255,255,255,0.6)" }}
            />
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={pct}
              onChange={seek}
              disabled={!track.mp3 || !duration}
              className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
          </div>
          <span
            className="flex-shrink-0 text-[10px] font-medium tabular-nums"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            {fmt(duration)}
          </span>
        </>
      )}
      <div className="flex flex-shrink-0 items-center gap-3 ml-4">
        {track.spotifyId ? (
          <a
            href={`https://open.spotify.com/track/${encodeURIComponent(track.spotifyId)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in Spotify"
            className="flex-shrink-0 px-1 transition-opacity hover:opacity-100"
            style={{ opacity: 0.7 }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="white"
              aria-hidden
            >
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
          </a>
        ) : null}
        {onSearchSimilar ? (
          <button
            type="button"
            aria-label="Search similar tracks"
            aria-busy={similarBusy}
            disabled={similarBusy || !track.trackId}
            className="flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-semibold leading-none transition-colors enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              color: "rgba(255, 255, 255, 0.45)",
              border: "1px solid rgba(255,255,255,0.12)",
            }}
            onClick={() => void onSearchSimilar(track)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            find similar
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <audio ref={audioRef} preload="auto" />
      {embedded ? (
        content
      ) : (
        <div
          className="w-72 rounded-2xl px-3 pt-3 pb-2.5"
          style={{
            background: "rgb(14,14,18)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "rgba(0,0,0,0.4) 0px 4px 16px",
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
