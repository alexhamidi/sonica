"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

const DEMO_QUERY =
  "\"instrumental synthwave, electronic beat, arpeggiated bassline, analog synths, dark atmospheric mood\"";

const chipStyle = {
  backgroundColor: "rgb(28, 28, 32)",
  border: "1px solid rgb(48, 48, 50)",
} as const;

/** Public file name has spaces — encode for a valid URL. */
const ALEPH_MP3 = encodeURI("/GESAFFELSTEIN - ALEPH.mp3");

/** Landing preview only; full file stays in /public unchanged. */
const PREVIEW_MAX_SEC = 30;

export function LandingSearchDemo() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      if (audio.currentTime >= PREVIEW_MAX_SEC) {
        audio.pause();
        audio.currentTime = 0;
        setPlaying(false);
      }
    };
    audio.addEventListener("timeupdate", onTime);
    return () => audio.removeEventListener("timeupdate", onTime);
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      if (a.currentTime >= PREVIEW_MAX_SEC) a.currentTime = 0;
      a.play().then(() => setPlaying(true)).catch(() => {});
    }
  }, [playing]);

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5">
      <div
        className="min-w-0 flex-1 rounded-lg p-1.5"
        style={chipStyle}
      >
        <p
          className=" text-[11px] leading-snug text-white/72 italic"
          style={{ fontFamily: "var(--font-nunito, ui-sans-serif)" }}
        >
          {DEMO_QUERY}
        </p>
      </div>

      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="shrink-0 text-white/30"
        aria-hidden
      >
        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" />
      </svg>

      <div
        role="button"
        tabIndex={0}
        aria-label={playing ? "Pause Aleph preview" : "Play Aleph preview"}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-white/30"
        style={chipStyle}
      >
        <div className="pointer-events-none relative h-8 w-8 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10">
          <Image
            src="/aleph-cover.png"
            alt=""
            fill
            sizes="32px"
            className="object-cover"
            draggable={false}
          />
        </div>
        <div className="pointer-events-none min-w-0 w-[4rem]">
          <p
            className="truncate text-[11px] font-semibold leading-tight text-white"
            style={{ fontFamily: "var(--font-nunito, ui-sans-serif)" }}
          >
            Aleph
          </p>
          <p
            className="truncate text-[9px] font-medium leading-tight text-white/40"
            style={{ fontFamily: "var(--font-nunito, ui-sans-serif)" }}
          >
            Gesaffelstein
          </p>
        </div>
        <div
          className="pointer-events-none flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          aria-hidden
        >
          {playing ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="white"
            >
              <rect x="5.5" y="4" width="5" height="16" rx="2.5" />
              <rect x="13.5" y="4" width="5" height="16" rx="2.5" />
            </svg>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="white"
              style={{ marginLeft: "1px" }}
            >
              <path d="M8.25 6.35c0-1.12 1.22-1.82 2.2-1.26l8.55 5.05c.98.58.98 2.04 0 2.62l-8.55 5.05c-.98.56-2.2-.14-2.2-1.26V6.35z" />
            </svg>
          )}
        </div>
        <audio
          ref={audioRef}
          src={ALEPH_MP3}
          preload="metadata"
          onEnded={() => setPlaying(false)}
        />
      </div>
    </div>
  );
}
