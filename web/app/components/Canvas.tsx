"use client";

import { useCallback, useEffect, useRef } from "react";
import { TrackTile, Track } from "./TrackTile";
import { CoverMode } from "./CanvasControls";

const TILE = 176;
const MIN_Z = 0.06;
const MAX_Z = 5;
const DRAG_THRESHOLD = 8;

interface CanvasProps {
  tracks: Track[];
  currentTrack: Track | null;
  onTrackClick: (track: Track) => void;
  playlistCovers: (string | null)[];
  playlistOnlyCovers: (string | null)[];
  artistCovers: (string | null)[];
  gridSize: number;
  coverMode: CoverMode;
  projection: string;
}

export function Canvas({
  tracks,
  currentTrack,
  onTrackClick,
  playlistCovers,
  playlistOnlyCovers,
  artistCovers,
  gridSize,
  coverMode,
  projection,
}: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const vpSize = useRef({ w: 0, h: 0 });
  const camRef = useRef({ x: 0, y: 0, z: 0.4 });
  const dragRef = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    panned: boolean;
  } | null>(null);

  const cameraInitRef = useRef(false);
  const imgMapRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const imgCallbacksRef = useRef<
    Map<number, (el: HTMLImageElement | null) => void>
  >(new Map());
  const trackLookupRef = useRef<Map<number, Track>>(new Map());
  const coverModeRef = useRef(coverMode);
  coverModeRef.current = coverMode;
  const playlistCoversRef = useRef(playlistCovers);
  playlistCoversRef.current = playlistCovers;
  const playlistOnlyCoversRef = useRef(playlistOnlyCovers);
  playlistOnlyCoversRef.current = playlistOnlyCovers;
  const artistCoversRef = useRef(artistCovers);
  artistCoversRef.current = artistCovers;

  const getCoverUrl = useCallback((track: Track) => {
    if (coverModeRef.current === "playlist") {
      return playlistOnlyCoversRef.current[track.playlistIndex] || "";
    }
    if (coverModeRef.current === "album") {
      return track.cover || "";
    }
    if (coverModeRef.current === "artist") {
      return artistCoversRef.current[track.playlistIndex] || "";
    }
    return "";
  }, []);

  useEffect(() => {
    const map = new Map<number, Track>();
    tracks.forEach((t) => map.set(t.index, t));
    trackLookupRef.current = map;
  }, [tracks]);

  // Eager-load all covers; re-run when cover source changes
  useEffect(() => {
    imgMapRef.current.forEach((img, idx) => {
      const track = trackLookupRef.current.get(idx);
      if (!track) return;
      const url = getCoverUrl(track);
      if (!url || img.dataset.loadedSrc === url) return;
      img.dataset.loadedSrc = url;
      img.src = url;
      img.style.opacity = "0";
      img.onload = () => {
        img.style.opacity = "1";
      };
      if (img.complete && img.naturalWidth > 0) img.style.opacity = "1";
    });
  }, [tracks, coverMode, playlistCovers, playlistOnlyCovers, artistCovers, getCoverUrl]);

  const registerImg = useCallback((idx: number) => {
    if (!imgCallbacksRef.current.has(idx)) {
      imgCallbacksRef.current.set(idx, (el: HTMLImageElement | null) => {
        if (el) {
          imgMapRef.current.set(idx, el);
          const track = trackLookupRef.current.get(idx);
          if (track) {
            const url = getCoverUrl(track);
            if (url) {
              el.dataset.loadedSrc = url;
              el.src = url;
              el.onload = () => {
                el.style.opacity = "1";
              };
              if (el.complete && el.naturalWidth > 0) el.style.opacity = "1";
            }
          }
        } else {
          imgMapRef.current.delete(idx);
        }
      });
    }
    return imgCallbacksRef.current.get(idx)!;
  }, []);

  const drawDots = useCallback((c: { x: number; y: number; z: number }) => {
    const canvas = bgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const spacing = 120 * c.z;
    ctx.clearRect(0, 0, w, h);
    if (spacing < 5) return;
    const r = Math.min(2.5, Math.max(0.8, c.z * 1.8));
    const ox = ((c.x % spacing) + spacing) % spacing;
    const oy = ((c.y % spacing) + spacing) % spacing;
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    for (let x = ox - spacing; x < w + spacing; x += spacing)
      for (let y = oy - spacing; y < h + spacing; y += spacing) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    ctx.fill();
  }, []);

  const resizeCanvas = useCallback(() => {
    const canvas = bgRef.current;
    const vp = viewportRef.current;
    if (!canvas || !vp) return;
    const dpr = window.devicePixelRatio || 1;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);
    drawDots(camRef.current);
  }, [drawDots]);

  const applyCamera = useCallback(
    (c: { x: number; y: number; z: number }) => {
      camRef.current = c;
      if (innerRef.current)
        innerRef.current.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`;
      drawDots(c);
    },
    [drawDots],
  );

  useEffect(() => {
    if (cameraInitRef.current) return;
    const vp = viewportRef.current;
    if (!vp || tracks.length === 0) return;
    cameraInitRef.current = true;
    const { clientWidth: vw, clientHeight: vh } = vp;
    vpSize.current = { w: vw, h: vh };
    const total = gridSize + TILE;
    const fz = Math.min(vw / total, vh / total) * 0.9;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, fz));
    applyCamera({ x: (vw - total * z) / 2, y: (vh - total * z) / 2, z });
  }, [tracks.length, gridSize, applyCamera]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    resizeCanvas();
    const ro = new ResizeObserver(([e]) => {
      vpSize.current = { w: e.contentRect.width, h: e.contentRect.height };
      resizeCanvas();
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [resizeCanvas]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const c = camRef.current;
      if (
        e.ctrlKey ||
        e.metaKey ||
        (Math.abs(e.deltaX) < 2 && Math.abs(e.deltaY) > 1)
      ) {
        const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        const nz = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
        const k = nz / c.z;
        applyCamera({ z: nz, x: mx - (mx - c.x) * k, y: my - (my - c.y) * k });
      } else {
        applyCamera({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyCamera]);

  const setCursor = useCallback((grabbing: boolean) => {
    if (viewportRef.current)
      viewportRef.current.style.cursor = grabbing ? "grabbing" : "grab";
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const c = camRef.current;
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      ox: c.x,
      oy: c.y,
      panned: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.panned) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.panned = true;
        setCursor(true);
      }
      applyCamera({ ...camRef.current, x: d.ox + dx, y: d.oy + dy });
    },
    [applyCamera, setCursor],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setCursor(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* */
      }
      if (d && !d.panned) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const tile = el?.closest("[data-track-index]");
        if (tile instanceof HTMLElement) {
          const idx = parseInt(tile.dataset.trackIndex ?? "", 10);
          if (!Number.isNaN(idx)) {
            const track = tracksRef.current.find((t) => t.index === idx);
            if (track?.mp3) onTrackClick(track);
          }
        }
      }
    },
    [onTrackClick],
  );

  const total = gridSize + TILE;

  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full min-h-0 overflow-hidden touch-none select-none cursor-grab"
      style={{ touchAction: "none", backgroundColor: "#0a0a0a" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas ref={bgRef} className="absolute inset-0 pointer-events-none" />
      <div
        ref={innerRef}
        className="absolute left-0 top-0 origin-top-left will-change-transform"
      >
        <div className="relative" style={{ width: total, height: total }}>
          {tracks.map((track) => {
            const coords = track.projections?.[projection];
            if (!coords) return null;
            const effectiveCoverMode =
              coverMode === "playlist" && !playlistOnlyCovers[track.playlistIndex]
                ? "hide"
                : coverMode;
            return (
              <TrackTile
                key={track.index}
                track={track}
                isPlaying={currentTrack?.index === track.index}
                left={coords[0] * gridSize}
                top={coords[1] * gridSize}
                tileSize={TILE}
                coverMode={effectiveCoverMode}
                onImgMount={registerImg(track.index)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
