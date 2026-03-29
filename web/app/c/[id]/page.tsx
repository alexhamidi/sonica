"use client";

import Image from "next/image";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Canvas } from "../../components/Canvas";
import Player from "../../components/Player";
import { CanvasControls, CoverMode } from "../../components/CanvasControls";
import { Nav } from "../../components/Nav";
import { Track } from "../../components/TrackTile";
import { Plus, Check } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

interface Entity {
  id: string;
  name: string;
  cover: string | null;
  type?: string;
}

export default function ExplorePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlistCovers, setPlaylistCovers] = useState<(string | null)[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [projection, setProjection] = useState("umap");
  const [availableProjections, setAvailableProjections] = useState<string[]>([
    "umap",
  ]);
  const [coverMode, setCoverMode] = useState<CoverMode>("playlist");
  const [grandparentId, setGrandparentId] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [adding, setAdding] = useState(false);
  const gridSize = 8000;

  const [searchInput, setSearchInput] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Entity[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API}/api/entity/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        setTracks(data.tracks);
        setPlaylistCovers(
          data.playlists.map((p: { cover: string | null }) => p.cover),
        );
        if (data.grandparentId) setGrandparentId(data.grandparentId);
        const first = (data.tracks as Track[]).find(
          (t) => Object.keys(t.projections).length > 0,
        );
        if (first) {
          const projs = Object.keys(first.projections);
          setAvailableProjections(projs);
          setProjection(projs[0]);
        }
      })
      .catch(() => {});
  }, [id]);

  const handleAddToCanvas = async () => {
    if (!grandparentId || added || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/me/grandparents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grandparentId }),
      });
      if (res.status === 401) {
        router.push("/canvas");
        return;
      }
      if (res.ok) setAdded(true);
    } finally {
      setAdding(false);
    }
  };

  useEffect(() => {
    fetch(`${API}/api/entities`)
      .then((r) => r.json())
      .then((d) => setSuggestions(d.entities ?? []))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    return q
      ? suggestions.filter((s) => s.name.toLowerCase().includes(q))
      : suggestions;
  }, [suggestions, searchInput]);

  const handleSelect = (entity: Entity) => {
    setSearchInput("");
    setSearchFocused(false);
    router.push(`/c/${entity.id}`);
  };

  const handleTrackClick = useCallback((track: Track) => {
    setCurrentTrack((prev) => (prev?.index === track.index ? null : track));
  }, []);

  const showDropdown = searchFocused && filtered.length > 0;

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-black text-white">
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <Canvas
          tracks={tracks}
          currentTrack={currentTrack}
          onTrackClick={handleTrackClick}
          playlistCovers={playlistCovers}
          playlistOnlyCovers={playlistCovers}
          artistCovers={[]}
          gridSize={gridSize}
          coverMode={coverMode}
          projection={projection}
        />

        <div className="absolute top-3 left-3 z-10 pointer-events-auto">
          <Nav />
        </div>

        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-[400px] pointer-events-auto">
          <div
            className="relative flex items-center rounded-xl px-3 py-2"
            style={{
              background: "rgba(0,0,0,0.6)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "rgba(0,0,0,0.3) 0px 2px 4px",
            }}
          >
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchInput("");
                  searchRef.current?.blur();
                }
                if (e.key === "Enter" && filtered.length > 0)
                  handleSelect(filtered[0]);
              }}
              placeholder="search artists, playlists..."
              className="w-full bg-transparent text-xs outline-none text-white placeholder-white/20"
            />
            {showDropdown && (
              <div
                className="absolute top-full left-0 right-0 mt-2 rounded-xl overflow-hidden z-20"
                style={{
                  backgroundColor: "rgb(14,14,18)",
                  border: "1px solid rgb(36,36,42)",
                  boxShadow: "0 16px 40px rgba(0,0,0,0.7)",
                }}
              >
                {filtered.slice(0, 10).map((s) => (
                  <button
                    key={s.id}
                    onMouseDown={() => handleSelect(s)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/5"
                  >
                    {s.cover ? (
                      <div className="relative h-7 w-7 flex-shrink-0 rounded overflow-hidden">
                        <Image
                          src={s.cover}
                          alt=""
                          fill
                          sizes="28px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="h-7 w-7 flex-shrink-0 rounded bg-zinc-800" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-xs text-white">{s.name}</p>
                      {s.type && (
                        <p className="text-[10px] text-white/30 capitalize">
                          {s.type}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="absolute top-3 right-3 z-10 pointer-events-auto flex items-center gap-2">
          {grandparentId && (
            <button
              onClick={handleAddToCanvas}
              disabled={adding}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors"
              style={{
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(12px)",
                border: `1px solid ${added ? "rgba(99,102,241,0.6)" : "rgba(255,255,255,0.08)"}`,
                color: added ? "rgb(165,168,255)" : "rgba(255,255,255,0.7)",
              }}
            >
              {added ? <Check size={12} /> : <Plus size={12} />}
              {added ? "added" : "add to canvas"}
            </button>
          )}
          <CanvasControls
            availableProjections={availableProjections}
            projection={projection}
            onProjectionChange={setProjection}
            coverMode={coverMode}
            onCoverModeChange={setCoverMode}
          />
        </div>
      </div>

      {currentTrack ? (
        <footer className="relative z-50 w-full flex-shrink-0">
          <Player track={currentTrack} />
        </footer>
      ) : null}
    </div>
  );
}
