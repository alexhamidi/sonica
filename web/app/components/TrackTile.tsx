"use client";

import { memo } from "react";
import { pastelFromId, pastelStrokeFromId } from "@/lib/pastelFromId";
import { CoverMode } from "./CanvasControls";

export interface Track {
  index: number;
  /** Database track UUID when present (canvas payload). */
  trackId?: string;
  title: string;
  artist: string;
  /** Spotify track id when ingested from Spotify; opens open.spotify.com/track/… */
  spotifyId?: string | null;
  mp3: string | null;
  cover: string | null;
  /** Index into per-source cover arrays (e.g. artist image per source). */
  sourceIndex: number;
  projections: Record<string, [number, number]>;
  sourceEntityId?: string;
  isQuery?: boolean;
  /** Parent `query_kind` when source is a search (similar | recommended | text | …). */
  sourceQueryKind?: string | null;
  /** Catalog artist grandparent cover when this track is also under an artist parent (canvas API). */
  artistCover?: string | null;
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
  if (track.isQuery) {
    const swatchId = track.trackId ?? `q-${track.index}`;
    const pastel = pastelFromId(swatchId);
    const stroke = pastelStrokeFromId(swatchId);
    return (
      <div
        data-track-index={track.index}
        className="absolute overflow-hidden"
        style={{
          left: 0,
          top: 0,
          width: tileSize,
          height: tileSize,
          transform: `translate(${left}px, ${top}px)`,
          transition: "transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
          border: `1.5px solid ${stroke}`,
          background: `color-mix(in srgb, ${pastel} 22%, rgb(24, 24, 27))`,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${stroke} 35%, transparent), 0 0 20px color-mix(in srgb, ${pastel} 18%, transparent)`,
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{ background: pastel }}
        />
        <img
          ref={onImgMount}
          alt={track.title}
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
          style={{ opacity: 0 }}
        />
        <div
          className="pointer-events-none absolute inset-0 flex flex-col justify-end p-3"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.78) 0%, transparent 58%)",
          }}
        >
          <p className="truncate text-xs font-semibold leading-tight text-white">
            {track.title}
          </p>
        </div>
        <div className="absolute top-2 right-2 pointer-events-none opacity-90">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle
              cx="11"
              cy="11"
              r="7"
              stroke="white"
              strokeOpacity="0.55"
              strokeWidth="2"
            />
            <path
              d="M20 20l-3-3"
              stroke="white"
              strokeOpacity="0.55"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div
      data-track-index={track.index}
      className="absolute cursor-pointer overflow-hidden group"
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
