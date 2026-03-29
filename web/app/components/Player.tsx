"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Track } from "./TrackTile";

interface Props {
  track: Track;
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Player({ track }: Props) {
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
    if (!track.mp3) {
      audio.pause();
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
  }, [track.index, track.mp3]);

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

  return (
    <>
      <audio ref={audioRef} preload="auto" />
      <div
        className="relative h-[72px] w-full"
        style={{
          background: "rgba(18,18,18,0.96)",
          backdropFilter: "blur(16px)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="flex h-full items-center gap-4 px-5">
          <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-md bg-zinc-800">
            {track.cover ? (
              <Image
                src={track.cover}
                alt={track.title}
                fill
                sizes="44px"
                className="object-cover"
                draggable={false}
              />
            ) : null}
          </div>
          <div className="min-w-0 w-40 flex-shrink-0">
            <p className="truncate text-sm font-medium leading-tight text-white">
              {track.title}
            </p>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {track.artist}
            </p>
          </div>
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-black"
          >
            {playing ? (
              <svg
                className="h-4 w-4 text-white"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg
                className="h-4 w-4 text-white"
                fill="currentColor"
                viewBox="0 0 24 24"
                style={{ marginLeft: "2px" }}
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="w-8 flex-shrink-0 text-right text-xs text-zinc-600">
              {fmt(progress)}
            </span>
            <div className="group relative h-1 flex-1">
              <div className="absolute inset-0 rounded-full bg-zinc-700" />
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white"
                style={{ width: `${pct}%` }}
              />
              <input
                type="range"
                min="0"
                max="100"
                step="0.1"
                value={pct}
                onChange={seek}
                className="absolute inset-0 w-full cursor-pointer opacity-0"
              />
            </div>
            <span className="w-8 flex-shrink-0 text-xs text-zinc-600">
              {fmt(duration)}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
