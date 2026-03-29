"use client";

import { memo } from "react";
import { CoverMode } from "./CanvasControls";

export interface Track {
  index: number;
  title: string;
  artist: string;
  mp3: string | null;
  cover: string | null;
  playlistIndex: number;
  projections: Record<string, [number, number]>;
}

export interface TrackTileProps {
  track: Track;
  isPlaying: boolean;
  left: number;
  top: number;
  tileSize?: number;
  coverMode?: CoverMode;
  onImgMount: (el: HTMLImageElement | null) => void;
}

function hideFontSize(title: string, tileSize: number) {
  const availW = tileSize - 24;
  const availH = tileSize - 44; // leave ~20px for artist + gap
  const lineH = 1.15;
  const charW = 0.58; // bold font avg char width ratio
  let size = 52;
  while (size > 12) {
    const charsPerLine = Math.floor(availW / (size * charW));
    const lines = Math.ceil(title.length / Math.max(charsPerLine, 1));
    if (lines * size * lineH <= availH) break;
    size--;
  }
  return size;
}

export const TrackTile = memo(function TrackTile({
  track,
  isPlaying,
  left,
  top,
  tileSize = 176,
  coverMode = "album",
  onImgMount,
}: TrackTileProps) {
  return (
    <div
      data-track-index={track.index}
      className={`absolute overflow-hidden group ${track.mp3 ? "cursor-pointer" : "cursor-default"}`}
      style={{
        left: 0,
        top: 0,
        width: tileSize,
        height: tileSize,
        transform: `translate(${left}px, ${top}px)`,
        transition: "transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
        boxShadow: isPlaying
          ? "inset 0 0 0 2px rgba(255,255,255,0.4)"
          : undefined,
      }}
    >
      {coverMode === "hide" ? (
        <div
          className="absolute inset-0 flex flex-col justify-between p-3"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <p
            className="text-white font-bold overflow-hidden"
            style={{
              fontSize: hideFontSize(track.title, tileSize),
              lineHeight: 1.15,
            }}
          >
            {track.title}
          </p>
          <p className="text-white/40 truncate" style={{ fontSize: 10 }}>
            {track.artist}
          </p>
        </div>
      ) : (
        <>
          <div className="absolute inset-0 bg-zinc-800" />
          <img
            ref={onImgMount}
            alt={track.title}
            draggable={false}
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
            style={{ opacity: 0 }}
          />
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-black/70 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <p className="truncate text-xs font-semibold leading-tight text-white">
              {track.title}
            </p>
            <p className="mt-0.5 truncate text-xs text-zinc-400">
              {track.artist}
            </p>
          </div>
        </>
      )}
    </div>
  );
});
