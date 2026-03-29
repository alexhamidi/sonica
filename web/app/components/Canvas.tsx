"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { TrackTile, Track } from "./TrackTile";
import { CoverMode } from "./CanvasControls";

const TILE = 176;
const MIN_Z = 0.06;
const MAX_Z = 5;
const DRAG_THRESHOLD = 8;
const INTERACTION_END_MS = 300;
const WHEEL_IDLE_MS = 150;

export type CanvasHandle = {
  focusTrack: (trackIndex: number, projection: string, zoom?: number) => void;
  /** Pan to center the track at the current zoom (no zoom change) — for tour navigation. */
  focusTrackTour: (
    trackIndex: number,
    projection: string,
    zoom?: number,
  ) => void;
};

interface CanvasProps {
  tracks: Track[];
  currentTrack: Track | null;
  onTrackClick: (track: Track) => void;
  /** Per-source images for artist cover mode (aligned with track.sourceIndex). */
  artistCovers: (string | null)[];
  gridSize: number;
  coverMode: CoverMode;
  projection: string;
  /** When set, tiles not in this set are dimmed. */
  highlightIndices?: Set<number>;
}

function preloadThenAssignCover(img: HTMLImageElement, url: string) {
  if (!url || img.dataset.loadedSrc === url) return;
  const pre = new Image();
  const commit = () => {
    img.src = url;
    img.dataset.loadedSrc = url;
    img.style.opacity = "1";
  };
  pre.onload = commit;
  pre.onerror = commit;
  pre.src = url;
  if (pre.complete && pre.naturalWidth > 0) commit();
}

function isSearchSourcedTrack(track: Track): boolean {
  return track.sourceQueryKind != null && track.sourceQueryKind !== "";
}

function skipCanvasTile(track: Track): boolean {
  return (
    Boolean(track.isQuery) && track.sourceQueryKind === "recommended"
  );
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  {
    tracks,
    currentTrack,
    onTrackClick,
    artistCovers,
    gridSize,
    coverMode,
    projection,
    highlightIndices,
  },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const camRef = useRef({ x: 0, y: 0, z: 0.4 });
  const dragRef = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    panned: boolean;
  } | null>(null);

  const animRef = useRef<number | null>(null);
  const cameraInitRef = useRef(false);
  const imgMapRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const imgCallbacksRef = useRef<
    Map<number, (el: HTMLImageElement | null) => void>
  >(new Map());
  const trackLookupRef = useRef<Map<number, Track>>(new Map());
  const coverModeRef = useRef(coverMode);
  coverModeRef.current = coverMode;
  const artistCoversRef = useRef(artistCovers);
  artistCoversRef.current = artistCovers;
  const willChangeClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getCoverUrl = useCallback((track: Track) => {
    if (coverModeRef.current === "album") {
      return track.cover || "";
    }
    if (coverModeRef.current === "artist") {
      if (isSearchSourcedTrack(track)) {
        return track.artistCover || track.cover || "";
      }
      return artistCoversRef.current[track.sourceIndex] || "";
    }
    return "";
  }, []);

  useEffect(() => {
    const map = new Map<number, Track>();
    tracks.forEach((t) => map.set(t.index, t));
    trackLookupRef.current = map;
  }, [tracks]);

  // Eager-load covers; preload then swap so toggling cover mode does not zero opacity on all tiles.
  useEffect(() => {
    imgMapRef.current.forEach((img, idx) => {
      const track = trackLookupRef.current.get(idx);
      if (!track) return;
      const url = getCoverUrl(track);
      preloadThenAssignCover(img, url);
    });
  }, [tracks, coverMode, artistCovers, getCoverUrl]);

  const registerImg = useCallback((idx: number) => {
    if (!imgCallbacksRef.current.has(idx)) {
      imgCallbacksRef.current.set(idx, (el: HTMLImageElement | null) => {
        if (el) {
          imgMapRef.current.set(idx, el);
          const track = trackLookupRef.current.get(idx);
          if (track) {
            const url = getCoverUrl(track);
            if (url) preloadThenAssignCover(el, url);
          }
        } else {
          imgMapRef.current.delete(idx);
        }
      });
    }
    return imgCallbacksRef.current.get(idx)!;
  }, []);

  const bumpWillChange = useCallback(() => {
    if (willChangeClearTimerRef.current) {
      clearTimeout(willChangeClearTimerRef.current);
      willChangeClearTimerRef.current = null;
    }
    if (innerRef.current) innerRef.current.style.willChange = "transform";
  }, []);

  const scheduleWillChangeEnd = useCallback(() => {
    if (willChangeClearTimerRef.current)
      clearTimeout(willChangeClearTimerRef.current);
    willChangeClearTimerRef.current = setTimeout(() => {
      willChangeClearTimerRef.current = null;
      if (innerRef.current) innerRef.current.style.willChange = "auto";
    }, INTERACTION_END_MS);
  }, []);

  const applyCamera = useCallback((c: { x: number; y: number; z: number }) => {
    camRef.current = c;
    if (innerRef.current)
      innerRef.current.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`;
  }, []);

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  const smoothCamera = useCallback(
    (target: { x: number; y: number; z: number }, durationMs: number) => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      bumpWillChange();
      const start = { ...camRef.current };
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / durationMs);
        const e = easeOutCubic(t);
        applyCamera({
          x: start.x + (target.x - start.x) * e,
          y: start.y + (target.y - start.y) * e,
          z: start.z + (target.z - start.z) * e,
        });
        if (t < 1) animRef.current = requestAnimationFrame(step);
        else {
          animRef.current = null;
          scheduleWillChangeEnd();
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [applyCamera, bumpWillChange, scheduleWillChangeEnd],
  );

  const targetCameraForTrack = useCallback(
    (trackIndex: number, proj: string, zoom = 0.9) => {
      const track = trackLookupRef.current.get(trackIndex);
      if (!track) return null;
      const coords = track.projections?.[proj];
      if (!coords) return null;
      const vp = viewportRef.current;
      if (!vp) return null;
      const wx = coords[0] * gridSize + TILE / 2;
      const wy = coords[1] * gridSize + TILE / 2;
      const z = Math.min(MAX_Z, Math.max(MIN_Z, zoom));
      return {
        x: vp.clientWidth / 2 - wx * z,
        y: vp.clientHeight / 2 - wy * z,
        z,
      };
    },
    [gridSize],
  );

  const focusTrackAt = useCallback(
    (trackIndex: number, proj: string, zoom = 0.9) => {
      const target = targetCameraForTrack(trackIndex, proj, zoom);
      if (!target) return;
      smoothCamera(target, 500);
    },
    [targetCameraForTrack, smoothCamera],
  );

  const focusTrackTourAt = useCallback(
    (trackIndex: number, proj: string) => {
      const track = trackLookupRef.current.get(trackIndex);
      if (!track) return;
      const coords = track.projections?.[proj];
      if (!coords) return;
      const vp = viewportRef.current;
      if (!vp) return;
      const wx = coords[0] * gridSize + TILE / 2;
      const wy = coords[1] * gridSize + TILE / 2;
      const z = camRef.current.z;
      const target = {
        x: vp.clientWidth / 2 - wx * z,
        y: vp.clientHeight / 2 - wy * z,
        z,
      };
      smoothCamera(target, 500);
    },
    [gridSize, smoothCamera],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusTrack: (trackIndex: number, proj: string, zoom?: number) => {
        focusTrackAt(trackIndex, proj, zoom ?? 0.9);
      },
      focusTrackTour: (trackIndex: number, proj: string, _zoom?: number) => {
        focusTrackTourAt(trackIndex, proj);
      },
    }),
    [focusTrackAt, focusTrackTourAt],
  );

  useEffect(() => {
    if (cameraInitRef.current) return;
    const vp = viewportRef.current;
    if (!vp || tracks.length === 0) return;
    cameraInitRef.current = true;
    const { clientWidth: vw, clientHeight: vh } = vp;
    const total = gridSize + TILE;
    const fz = Math.min(vw / total, vh / total) * 0.9;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, fz));
    applyCamera({ x: (vw - total * z) / 2, y: (vh - total * z) / 2, z });
  }, [tracks.length, gridSize, applyCamera]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      bumpWillChange();
      if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = setTimeout(() => {
        wheelIdleTimerRef.current = null;
        scheduleWillChangeEnd();
      }, WHEEL_IDLE_MS);
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
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelIdleTimerRef.current) {
        clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = null;
      }
    };
  }, [applyCamera, bumpWillChange, scheduleWillChangeEnd]);

  const setCursor = useCallback((grabbing: boolean) => {
    if (viewportRef.current)
      viewportRef.current.style.cursor = grabbing ? "grabbing" : "grab";
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bumpWillChange();
      if (wheelIdleTimerRef.current) {
        clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = null;
      }
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const c = camRef.current;
      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        ox: c.x,
        oy: c.y,
        panned: false,
      };
    },
    [bumpWillChange],
  );

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
      scheduleWillChangeEnd();
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
    [onTrackClick, projection, focusTrackAt, scheduleWillChangeEnd],
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
      <div ref={innerRef} className="absolute left-0 top-0 origin-top-left">
        <div className="relative" style={{ width: total, height: total }}>
          {tracks.map((track) => {
            if (skipCanvasTile(track)) return null;
            const coords = track.projections?.[projection];
            if (!coords) return null;
            const artistModeUrl = isSearchSourcedTrack(track)
              ? track.artistCover || track.cover
              : artistCovers[track.sourceIndex];
            const effectiveCoverMode =
              coverMode === "artist" && !artistModeUrl ? "hide" : coverMode;
            const dimmed =
              highlightIndices !== undefined &&
              highlightIndices.size > 0 &&
              !highlightIndices.has(track.index);
            return (
              <div
                key={track.index}
                style={{
                  opacity: dimmed ? 0.07 : 1,
                  transition: "opacity 0.15s ease",
                }}
              >
                <TrackTile
                  track={track}
                  isPlaying={currentTrack?.index === track.index}
                  left={coords[0] * gridSize}
                  top={coords[1] * gridSize}
                  tileSize={TILE}
                  coverMode={effectiveCoverMode}
                  onImgMount={registerImg(track.index)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
