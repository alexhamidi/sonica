"use client";

import { useLayoutEffect, useRef, useState } from "react";

export type CoverMode = "album" | "artist" | "hide";

const COVER_MODES: CoverMode[] = ["album", "artist", "hide"];
const COVER_LABELS: Record<CoverMode, string> = {
  album: "album",
  artist: "artist",
  hide: "hide",
};

function SlidingSwitcher<T extends string>({
  options,
  active,
  onChange,
}: {
  options: T[];
  active: T;
  onChange: (v: T) => void;
}) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ind, setInd] = useState({ left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const idx = options.indexOf(active);
    const btn = btnRefs.current[idx];
    if (btn)
      setInd({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
  }, [active, options]);

  return (
    <div
      className="relative flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs"
      style={{
        background: "rgb(14,14,18)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      {ind.ready && (
        <div
          className="absolute rounded"
          style={{
            left: ind.left,
            width: ind.width,
            top: 4,
            bottom: 4,
            background: "white",
            transition:
              "left 0.18s cubic-bezier(0.4,0,0.2,1), width 0.18s cubic-bezier(0.4,0,0.2,1)",
          }}
        />
      )}
      {options.map((opt, i) => (
        <button
          key={opt}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          onClick={() => onChange(opt)}
          className="relative z-10 rounded px-2 py-0.5 font-mono uppercase outline-none focus:outline-none"
          style={{
            color: active === opt ? "black" : "rgba(255,255,255,0.4)",
            transition: "color 0.18s ease",
          }}
        >
          {COVER_LABELS[opt as CoverMode] ?? opt}
        </button>
      ))}
    </div>
  );
}

const PROJECTIONS = ["umap", "pca", "tsne"];

interface ProjectionSwitcherProps {
  projection: string;
  onChange: (p: string) => void;
}

export function ProjectionSwitcher({
  projection,
  onChange,
}: ProjectionSwitcherProps) {
  return (
    <SlidingSwitcher
      options={PROJECTIONS}
      active={projection}
      onChange={onChange}
    />
  );
}

interface CoverSwitcherProps {
  coverMode: CoverMode;
  onChange: (mode: CoverMode) => void;
}

export function CoverSwitcher({ coverMode, onChange }: CoverSwitcherProps) {
  return (
    <SlidingSwitcher
      options={COVER_MODES}
      active={coverMode}
      onChange={onChange}
    />
  );
}

interface CanvasControlsProps {
  projection: string;
  onProjectionChange: (p: string) => void;
  coverMode: CoverMode;
  onCoverModeChange: (mode: CoverMode) => void;
}

export function CanvasControls({
  projection,
  onProjectionChange,
  coverMode,
  onCoverModeChange,
}: CanvasControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <ProjectionSwitcher
        projection={projection}
        onChange={onProjectionChange}
      />
      <CoverSwitcher coverMode={coverMode} onChange={onCoverModeChange} />
    </div>
  );
}
