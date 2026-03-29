"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Canvas } from "../components/Canvas";
import Player from "../components/Player";
import { CanvasControls, CoverMode } from "../components/CanvasControls";
import { Nav } from "../components/Nav";
import { authClient } from "@/lib/auth/client";
import { Plus, Search } from "lucide-react";
import { Track } from "../components/TrackTile";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";
const TRACK_LIMIT = 500;
const NON_DELETABLE_GRANDPARENT_TYPES = new Set(["orphans", "searches"]);
const HIDDEN_EMPTY_GRANDPARENT_TYPES = new Set(["orphans"]);

interface SourceEntity {
  id: string;
  name: string;
  cover: string | null;
  type: string;
  parentId: string | null;
  parentName: string | null;
  parentCover: string | null;
  parentType: string | null;
  /** Ready tracks linked to this parent (from DB; not derived from canvas payload). */
  trackCount: number;
  status: string;
}

interface SearchChildEntity {
  id: string;
  name: string;
  cover: string | null;
  type: string;
}

interface SearchParentEntity {
  id: string;
  name: string;
  cover: string | null;
  type: string;
  children: SearchChildEntity[];
}

interface Grandparent {
  id: string;
  name: string;
  type: string;
  cover: string | null;
  expanded: boolean;
}

export default function CanvasPage() {
  const session = authClient.useSession();
  const router = useRouter();

  const [tracks, setTracks] = useState<(Track & { sourceEntityId: string })[]>(
    [],
  );
  const [entities, setEntities] = useState<SourceEntity[]>([]);
  const [grandparents, setGrandparents] = useState<Grandparent[]>([]);
  const [enabledEntityIds, setEnabledEntityIds] = useState<Set<string>>(
    new Set(),
  );
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [projection, setProjection] = useState("umap");
  const [coverMode, setCoverMode] = useState<CoverMode>("playlist");
  const [loading, setLoading] = useState(true);
  const gridSize = 8000;

  // Expand/collapse state for parent groups in the toggle sidebar
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    new Set(),
  );

  // Omnibox
  const [omniText, setOmniText] = useState("");
  const [omniFile, setOmniFile] = useState<File | null>(null);
  const [omniFileUrl, setOmniFileUrl] = useState<string | null>(null);
  const [omniThumbHover, setOmniThumbHover] = useState(false);
  const [omniDragging, setOmniDragging] = useState(false);
  const [omniLoading, setOmniLoading] = useState(false);
  const omniFileRef = useRef<HTMLInputElement>(null);
  const omniTextRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!omniFile) {
      setOmniFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(omniFile);
    setOmniFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [omniFile]);

  const submitOmni = async () => {
    if (!omniText.trim() && !omniFile) return;
    const userId = session.data?.user?.id;
    if (!userId) return;
    setOmniLoading(true);
    try {
      const form = new FormData();
      form.append("user_id", userId);
      if (omniText.trim()) form.append("text", omniText.trim());
      if (omniFile) form.append("file", omniFile);
      const res = await fetch(`${API}/api/search`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) return;
      await res.json();
      setOmniText("");
      setOmniFile(null);
      await fetchCanvas(true);
    } catch {
    } finally {
      setOmniLoading(false);
    }
  };

  // Add entity UI
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [suggestions, setSuggestions] = useState<SearchParentEntity[]>([]);
  const [addSuggestionsLoaded, setAddSuggestionsLoaded] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const addDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedSearchGrandparentIds, setSelectedSearchGrandparentIds] =
    useState<Set<string>>(new Set());
  const [addingSearchSelections, setAddingSearchSelections] = useState(false);

  // URL resolve mode
  interface ResolvedEntity { name: string; cover: string | null; trackCount: number; url: string; }
  interface ResolvedData { name: string; type: string; entities: ResolvedEntity[]; }
  const [resolvedData, setResolvedData] = useState<ResolvedData | null>(null);
  const [resolving, setResolving] = useState(false);
  const [selectedResolvedUrls, setSelectedResolvedUrls] = useState<Set<string>>(new Set());
  const [addingResolved, setAddingResolved] = useState(false);

  const isSpotifyUrl = (val: string) => val.includes("spotify.com");

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCanvas = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/me/canvas");
      if (!res.ok) return;
      const data = await res.json();
      setTracks(data.tracks);
      setEntities(data.entities);
      setGrandparents(data.grandparents ?? []);

      const ents = data.entities as SourceEntity[];
      setEnabledEntityIds(new Set(ents.map((e) => e.id)));

      const expandedParentsSet = new Set<string>();
      for (const gp of data.grandparents ?? []) {
        if (gp.expanded) {
          expandedParentsSet.add(gp.id);
        }
      }
      setExpandedParents(expandedParentsSet);

      // Poll every 5s if any grandparent has no tracks yet (pipeline in progress)
      const trackGpIds = new Set(
        (data.tracks as (Track & { sourceEntityId: string })[])
          .map(
            (t) =>
              (data.entities as SourceEntity[]).find(
                (e) => e.id === t.sourceEntityId,
              )?.parentId,
          )
          .filter(Boolean),
      );
      const hasPending = (data.grandparents ?? []).some(
        (gp: { id: string; type: string }) =>
          !NON_DELETABLE_GRANDPARENT_TYPES.has(gp.type) &&
          !trackGpIds.has(gp.id),
      );
      const reprojectPending = Boolean(
        (data as { reprojectPending?: boolean }).reprojectPending,
      );
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (reprojectPending || hasPending) {
        const delay = reprojectPending ? 2000 : 5000;
        pollTimerRef.current = setTimeout(() => fetchCanvas(true), delay);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCanvas();
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchCanvas]);

  const fetchSuggestions = useCallback((q: string) => {
    setAddSuggestionsLoaded(false);
    const url = q.trim()
      ? `${API}/api/entities?q=${encodeURIComponent(q.trim())}`
      : `${API}/api/entities`;
    fetch(url)
      .then((r) => r.json())
      .then((d) =>
        setSuggestions(
          (d.entities ?? [])
            .filter(
              (e: SearchParentEntity) =>
                !NON_DELETABLE_GRANDPARENT_TYPES.has(e.type),
            )
            .map((e: SearchParentEntity) => ({
              ...e,
              children: e.children ?? [],
            })),
        ),
      )
      .catch(() => {})
      .finally(() => setAddSuggestionsLoaded(true));
  }, []);

  useEffect(() => {
    if (!addOpen) return;
    setAddInput("");
    setSelectedSearchGrandparentIds(new Set());
    setResolvedData(null);
    setSelectedResolvedUrls(new Set());
    setTimeout(() => addInputRef.current?.focus(), 50);
    fetchSuggestions("");
  }, [addOpen, fetchSuggestions]);

  const addedIds = useMemo(
    () => new Set(entities.map((e) => e.parentId).filter(Boolean)),
    [entities],
  );

  // Group child entities by parent for the sidebar
  const entityGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        type: string;
        cover: string | null;
        children: SourceEntity[];
      }
    >();
    // Seed with grandparents — hide orphans until they have children
    for (const gp of grandparents) {
      if (!HIDDEN_EMPTY_GRANDPARENT_TYPES.has(gp.type)) {
        map.set(gp.id, {
          id: gp.id,
          name: gp.name,
          type: gp.type,
          cover: gp.cover,
          children: [],
        });
      }
    }
    for (const e of entities) {
      let pid = e.parentId;
      let pname = e.parentName ?? e.name;
      let ptype = e.parentType ?? e.type;
      let pcover = e.parentCover ?? e.cover;

      if (!pid) {
        pid = `__solo__${e.id}`;
        pname = e.name;
        ptype = e.type;
        pcover = e.cover;
      }

      if (!map.has(pid))
        map.set(pid, {
          id: pid,
          name: pname,
          type: ptype,
          cover: pcover,
          children: [],
        });
      map.get(pid)!.children.push(e);
    }
    return Array.from(map.values()).sort((a, b) => {
      const rank = (type: string) => (type === "searches" ? 1 : 0);
      return rank(a.type) - rank(b.type);
    });
  }, [grandparents, entities]);

  const toggleParent = async (_groupId: string, childIds: string[]) => {
    const allOn = childIds.every((id) => enabledEntityIds.has(id));

    setEnabledEntityIds((prev) => {
      const next = new Set(prev);
      if (allOn) childIds.forEach((id) => next.delete(id));
      else childIds.forEach((id) => next.add(id));
      return next;
    });

    try {
      await Promise.all(
        childIds.map((id) =>
          fetch(`/api/me/parents/${id}`, {
            method: allOn ? "DELETE" : "POST",
          }),
        ),
      );
      void fetchCanvas(true);
    } catch (error) {
      console.error("Failed to toggle parents:", error);
      setEnabledEntityIds((prev) => {
        const next = new Set(prev);
        if (allOn) childIds.forEach((id) => next.add(id));
        else childIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const filteredSuggestions = useMemo(() => {
    return suggestions.filter((s) => !addedIds.has(s.id));
  }, [suggestions, addedIds]);

  const deleteGrandparent = async (grandparentId: string) => {
    const grandparent = grandparents.find((gp) => gp.id === grandparentId);
    if (!grandparent || NON_DELETABLE_GRANDPARENT_TYPES.has(grandparent.type))
      return;

    setGrandparents((prev) => prev.filter((g) => g.id !== grandparentId));
    setEntities((prev) => prev.filter((e) => e.parentId !== grandparentId));
    fetch("/api/me/grandparents", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grandparentId }),
    })
      .then((res) => {
        if (!res.ok) fetchCanvas(true);
      })
      .catch(() => {
        fetchCanvas(true);
      });
  };

  const playlistCovers = useMemo(
    () => entities.map((e) => e.cover),
    [entities],
  );

  const playlistOnlyCovers = useMemo(
    () => entities.map((e) => (e.type === "playlist" ? e.cover : null)),
    [entities],
  );

  const artistCovers = useMemo(
    () => entities.map((e) => e.parentCover ?? e.cover),
    [entities],
  );

  const visibleTracks = useMemo(() => {
    return tracks
      .filter((t) => enabledEntityIds.has(t.sourceEntityId))
      .slice(0, TRACK_LIMIT);
  }, [tracks, enabledEntityIds]);

  const overLimit = useMemo(() => {
    const n = tracks.filter((t) =>
      enabledEntityIds.has(t.sourceEntityId),
    ).length;
    return n > TRACK_LIMIT ? n - TRACK_LIMIT : 0;
  }, [tracks, enabledEntityIds]);

  const handleTrackClick = useCallback((track: Track) => {
    setCurrentTrack((prev) => (prev?.index === track.index ? null : track));
  }, []);

  const toggleSearchSelection = useCallback(
    (grandparentId: string) => {
      if (addedIds.has(grandparentId)) return;
      setSelectedSearchGrandparentIds((prev) => {
        const next = new Set(prev);
        if (next.has(grandparentId)) next.delete(grandparentId);
        else next.add(grandparentId);
        return next;
      });
    },
    [addedIds],
  );

  const addSelectedSearchItems = useCallback(async () => {
    const ids = Array.from(selectedSearchGrandparentIds).filter(
      (id) => !addedIds.has(id),
    );
    if (ids.length === 0) return;
    setAddingSearchSelections(true);
    try {
      const results = await Promise.all(
        ids.map((grandparentId) =>
          fetch("/api/me/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grandparentId }),
          }),
        ),
      );
      if (results.some((res) => res.status === 401)) {
        router.push("/canvas");
        return;
      }
      setSelectedSearchGrandparentIds(new Set());
      setAddOpen(false);
      setAddInput("");
      fetchCanvas(true);
    } finally {
      setAddingSearchSelections(false);
    }
  }, [selectedSearchGrandparentIds, addedIds, router, fetchCanvas]);

  const addResolvedItems = useCallback(async () => {
    if (!resolvedData || selectedResolvedUrls.size === 0) return;
    setAddingResolved(true);
    try {
      const parentUrls = Array.from(selectedResolvedUrls);
      const body: Record<string, unknown> = { parentUrls };
      if (resolvedData.type === "artist" || resolvedData.type === "user") {
        body.grandparentUrl = addInput;
      }
      const res = await fetch("/api/me/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) { router.push("/canvas"); return; }
      setResolvedData(null);
      setSelectedResolvedUrls(new Set());
      setAddOpen(false);
      setAddInput("");
      fetchCanvas(true);
    } finally {
      setAddingResolved(false);
    }
  }, [resolvedData, selectedResolvedUrls, addInput, router, fetchCanvas]);

  const toggleEntity = async (id: string) => {
    const isEnabled = enabledEntityIds.has(id);
    const newEnabled = !isEnabled;

    setEnabledEntityIds((prev) => {
      const next = new Set(prev);
      if (newEnabled) next.add(id);
      else next.delete(id);
      return next;
    });

    try {
      await fetch(`/api/me/parents/${id}`, {
        method: newEnabled ? "POST" : "DELETE",
      });
      void fetchCanvas(true);
    } catch (error) {
      console.error("Failed to toggle parent:", error);
      setEnabledEntityIds((prev) => {
        const next = new Set(prev);
        if (newEnabled) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  };

  const toggleExpanded = async (groupId: string) => {
    const isCurrentlyExpanded = expandedParents.has(groupId);
    const newExpanded = !isCurrentlyExpanded;

    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (newExpanded) next.add(groupId);
      else next.delete(groupId);
      return next;
    });

    // Skip API for synthetic solo groups
    if (groupId.startsWith("__solo__")) return;

    try {
      await fetch(`/api/me/grandparents/${groupId}/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expanded: newExpanded }),
      });
    } catch (error) {
      console.error("Failed to update grandparent expanded preference:", error);
      setExpandedParents((prev) => {
        const next = new Set(prev);
        if (newExpanded) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
    }
  };

  const showAddDropdown = addOpen;
  const selectedSearchCount = Array.from(selectedSearchGrandparentIds).filter(
    (id) => !addedIds.has(id),
  ).length;

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-black text-white">
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <Canvas
          tracks={visibleTracks}
          currentTrack={currentTrack}
          onTrackClick={handleTrackClick}
          playlistCovers={playlistCovers}
          playlistOnlyCovers={playlistOnlyCovers}
          artistCovers={artistCovers}
          gridSize={gridSize}
          coverMode={coverMode}
          projection={projection}
        />

        <div className="absolute top-3 left-3 z-10 pointer-events-auto">
          <Nav />
        </div>

        {/* Top right: controls then entities below */}
        <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2 pointer-events-auto">
          {/* Projection + covers */}
          <CanvasControls
            projection={projection}
            onProjectionChange={setProjection}
            coverMode={coverMode}
            onCoverModeChange={setCoverMode}
          />

          {/* Entity list */}
          <div
            className="flex flex-col w-64 gap-1 rounded-xl px-2 py-2 overflow-y-auto"
            style={{
              maxHeight: "calc(100vh - 160px)",
              scrollbarWidth: "none",
              background: "rgb(14,14,18)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "rgba(0,0,0,0.3) 0px 2px 4px",
            }}
          >
            {loading
              ? [56, 44, 64].map((w, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                    style={{ background: "rgba(255,255,255,0.04)" }}
                  >
                    <div
                      className="flex-shrink-0 w-11 h-11 rounded-lg"
                      style={{
                        background: "rgba(255,255,255,0.07)",
                        animation: "skeletonPulse 1.6s ease-in-out infinite",
                        animationDelay: `${i * 0.15}s`,
                      }}
                    />
                    <div className="flex-1 flex flex-col gap-1.5">
                      <div
                        className="h-2.5 rounded-full"
                        style={{
                          width: `${w}%`,
                          background: "rgba(255,255,255,0.07)",
                          animation: "skeletonPulse 1.6s ease-in-out infinite",
                          animationDelay: `${i * 0.15 + 0.05}s`,
                        }}
                      />
                      <div
                        className="h-2 rounded-full"
                        style={{
                          width: "40%",
                          background: "rgba(255,255,255,0.04)",
                          animation: "skeletonPulse 1.6s ease-in-out infinite",
                          animationDelay: `${i * 0.15 + 0.1}s`,
                        }}
                      />
                    </div>
                  </div>
                ))
              : entityGroups.map((group) => {
                  const childIds = group.children.map((c) => c.id);
                  const allOn = childIds.every((id) =>
                    enabledEntityIds.has(id),
                  );
                  const someOn =
                    !allOn && childIds.some((id) => enabledEntityIds.has(id));
                  const expanded = expandedParents.has(group.id);
                  const isSolo = group.id.startsWith("__solo__");
                  return (
                    <div key={group.id} className="flex flex-col group/gp">
                      {/* Profile/artist header — prominent, collapsible */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          isSolo
                            ? toggleEntity(group.children[0].id)
                            : toggleExpanded(group.id)
                        }
                        onKeyDown={(e) =>
                          e.key === "Enter" &&
                          (isSolo
                            ? toggleEntity(group.children[0].id)
                            : toggleExpanded(group.id))
                        }
                        className="flex items-center gap-3 w-full text-left rounded-xl px-3 py-2.5 transition-colors hover:bg-white/5 cursor-pointer outline-none focus:outline-none"
                        style={{ background: "rgba(255,255,255,0.04)" }}
                      >
                        {/* Cover */}
                        <div className="relative flex-shrink-0 w-11 h-11 rounded-lg overflow-hidden bg-zinc-800 flex items-center justify-center">
                          {group.type === "searches" ? (
                            <Search
                              size={20}
                              style={{ color: "rgba(255,255,255,0.5)" }}
                            />
                          ) : group.cover ? (
                            <Image
                              src={group.cover}
                              alt=""
                              fill
                              sizes="44px"
                              className="object-cover"
                            />
                          ) : null}
                        </div>
                        {/* Name */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate text-white">
                            {group.name}
                          </p>
                        </div>
                        {/* Collapse indicator */}
                        {!isSolo && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            className="flex-shrink-0 transition-transform"
                            style={{
                              transform: expanded
                                ? "rotate(0deg)"
                                : "rotate(-90deg)",
                              color: "rgba(255,255,255,0.3)",
                            }}
                          >
                            <path
                              d="M2 4l4 4 4-4"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>

                      {/* Children */}
                      {group.children.length > 0 && (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateRows:
                              isSolo || expanded ? "1fr" : "0fr",
                            transition:
                              "grid-template-rows 0.22s cubic-bezier(0.4,0,0.2,1)",
                          }}
                        >
                          <div className="overflow-hidden">
                            <div className="flex flex-col mt-0.5">
                              {group.children.map((child) => {
                                const isLoading =
                                  child.status !== "ready";
                                const on =
                                  !isLoading &&
                                  enabledEntityIds.has(child.id);
                                const count = child.trackCount;
                                return (
                                  <button
                                    key={child.id}
                                    onClick={() =>
                                      !isLoading && toggleEntity(child.id)
                                    }
                                    className={`flex items-center gap-3 py-1.5 px-3 text-left w-full rounded-lg transition-colors outline-none focus:outline-none ${isLoading ? "cursor-default" : "hover:bg-white/[0.04]"}`}
                                    style={{
                                      opacity: isLoading ? 0.5 : on ? 1 : 0.4,
                                    }}
                                  >
                                    <div className="relative flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-zinc-800">
                                      {child.cover && (
                                        <Image
                                          src={child.cover}
                                          alt=""
                                          fill
                                          sizes="32px"
                                          className="object-cover"
                                        />
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs font-medium truncate text-white">
                                        {child.name}
                                      </p>
                                      <p
                                        className="text-[10px] tabular-nums"
                                        style={{
                                          color: "rgba(255,255,255,0.35)",
                                        }}
                                      >
                                        {isLoading
                                          ? "loading..."
                                          : `${count} songs`}
                                      </p>
                                    </div>
                                    {isLoading ? (
                                      <span
                                        className="flex-shrink-0 w-3 h-3 rounded-full border-[1.5px] border-white/20 border-t-white/60 animate-spin"
                                      />
                                    ) : (
                                      <span
                                        className="flex-shrink-0 flex items-center justify-center rounded-sm transition-all"
                                        style={{
                                          width: 15,
                                          height: 15,
                                          border: on
                                            ? "none"
                                            : "1.5px solid rgba(255,255,255,0.2)",
                                          background: on
                                            ? "white"
                                            : "transparent",
                                        }}
                                      >
                                        {on && (
                                          <svg
                                            width="9"
                                            height="7"
                                            viewBox="0 0 9 7"
                                            fill="none"
                                          >
                                            <path
                                              d="M1 3.5L3.5 6L8 1"
                                              stroke="black"
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </svg>
                                        )}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
          </div>

          {/* Add source */}
          <div className="relative w-64">
            {addOpen ? (
              <div
                className="relative flex w-full items-center rounded-[10px] border px-4 py-3 leading-none cursor-text"
                onClick={() => addInputRef.current?.focus()}
                style={{
                  borderColor: "rgba(255,255,255,0.08)",
                  background: "rgb(14,14,18)",
                  boxShadow: "rgba(0,0,0,0.3) 0px 2px 4px",
                }}
              >
                <input
                  ref={addInputRef}
                  value={addInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAddInput(val);
                    if (addDebounceRef.current) clearTimeout(addDebounceRef.current);
                    if (isSpotifyUrl(val)) {
                      setResolvedData(null);
                      setSelectedResolvedUrls(new Set());
                      setResolving(true);
                      addDebounceRef.current = setTimeout(async () => {
                        try {
                          const res = await fetch(`${API}/api/resolve?url=${encodeURIComponent(val)}`);
                          if (!res.ok) throw new Error();
                          const data: ResolvedData = await res.json();
                          setResolvedData(data);
                          if (data.entities.length === 1) setSelectedResolvedUrls(new Set([data.entities[0].url]));
                        } catch {
                          setResolvedData(null);
                        } finally {
                          setResolving(false);
                        }
                      }, 400);
                    } else {
                      setResolvedData(null);
                      setResolving(false);
                      addDebounceRef.current = setTimeout(() => fetchSuggestions(val), 300);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddOpen(false);
                  }}
                  onBlur={() => setTimeout(() => setAddOpen(false), 150)}
                  placeholder="search/paste spotify URL (esc to cancel)"
                  className="flex-1 bg-transparent text-sm font-medium leading-none text-white placeholder-white/40 outline-none"
                />
                {showAddDropdown && (
                  <div
                    className="absolute top-full right-0 z-20 mt-2 flex max-h-96 w-64 flex-col rounded-xl"
                    style={{
                      backgroundColor: "rgb(14,14,18)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      boxShadow: "0 16px 40px rgba(0,0,0,0.7)",
                      bottom: "24px",
                    }}
                  >
                    <div
                      className="flex-1 min-h-0 overflow-y-auto px-2"
                      style={{ scrollbarWidth: "none" }}
                    >
                      {resolving ? (
                        <div className="px-2 py-3 text-xs text-white/40">resolving...</div>
                      ) : resolvedData ? (
                        <div className="flex flex-col divide-y divide-white/[0.08]">
                          {resolvedData.entities.map((entity) => {
                            const on = selectedResolvedUrls.has(entity.url);
                            return (
                              <button
                                key={entity.url}
                                onMouseDown={(e) => { e.preventDefault(); setSelectedResolvedUrls((prev) => { const next = new Set(prev); if (next.has(entity.url)) next.delete(entity.url); else next.add(entity.url); return next; }); }}
                                className="flex items-center gap-3 py-2.5 text-left w-full outline-none focus:outline-none"
                                style={{ opacity: on ? 1 : 0.5 }}
                              >
                                <div className="relative flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-zinc-800">
                                  {entity.cover && <img src={entity.cover} alt="" className="h-full w-full object-cover" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium truncate text-white">{entity.name}</p>
                                  {entity.trackCount > 0 && <p className="text-[10px] tabular-nums" style={{ color: "rgba(255,255,255,0.35)" }}>{entity.trackCount} songs</p>}
                                </div>
                                <span className="flex-shrink-0 flex items-center justify-center rounded-sm transition-all" style={{ width: 15, height: 15, border: on ? "none" : "1.5px solid rgba(255,255,255,0.2)", background: on ? "white" : "transparent" }}>
                                  {on && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : filteredSuggestions.length > 0 ? (
                        <div className="flex flex-col divide-y divide-white/[0.08]">
                          {filteredSuggestions.slice(0, 5).map((parent) => (
                            <div
                              key={parent.id}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                toggleSearchSelection(parent.id);
                              }}
                              className="group/parent py-2.5"
                              style={{}}
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className="group/cover relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-zinc-900 shadow-lg"
                                  style={{
                                    outline: selectedSearchGrandparentIds.has(
                                      parent.id,
                                    )
                                      ? "2px solid rgba(255,255,255,0.98)"
                                      : undefined,
                                    outlineOffset:
                                      selectedSearchGrandparentIds.has(
                                        parent.id,
                                      )
                                        ? "-2px"
                                        : undefined,
                                  }}
                                >
                                  {parent.cover ? (
                                    <img
                                      src={parent.cover}
                                      alt={parent.name}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <div className="h-full w-full" />
                                  )}
                                  <button
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      toggleSearchSelection(parent.id);
                                    }}
                                    className={`absolute inset-0 flex items-center justify-center transition-all duration-150 ${
                                      selectedSearchGrandparentIds.has(
                                        parent.id,
                                      )
                                        ? "opacity-100"
                                        : "opacity-0 group-hover/cover:opacity-100"
                                    }`}
                                    style={{
                                      background: "rgba(0,0,0,0.42)",
                                      color: "white",
                                    }}
                                    title={
                                      selectedSearchGrandparentIds.has(
                                        parent.id,
                                      )
                                        ? "Remove selection"
                                        : "Select"
                                    }
                                  >
                                    {selectedSearchGrandparentIds.has(
                                      parent.id,
                                    ) ? (
                                      <span className="text-3xl leading-none">
                                        -
                                      </span>
                                    ) : (
                                      <Plus size={22} strokeWidth={1.9} />
                                    )}
                                  </button>
                                </div>
                                <div className="min-w-0 flex-1">
                                  <h2 className="truncate text-base font-semibold text-white/90 group-hover/parent:text-white">
                                    {parent.name}
                                  </h2>
                                </div>
                              </div>

                              <div
                                className="mt-2 flex gap-2 overflow-x-auto pb-1"
                                style={{ scrollbarWidth: "none" }}
                              >
                                {parent.children.map((child) => (
                                  <div
                                    key={child.id}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      toggleSearchSelection(parent.id);
                                    }}
                                    className="group/child relative flex w-20 shrink-0 flex-col gap-1 rounded-xl"
                                  >
                                    <div
                                      className="group/cover relative aspect-square w-full overflow-hidden rounded-lg bg-zinc-900 shadow-md"
                                      style={{
                                        outline:
                                          selectedSearchGrandparentIds.has(
                                            parent.id,
                                          )
                                            ? "2px solid rgba(255,255,255,0.98)"
                                            : undefined,
                                        outlineOffset:
                                          selectedSearchGrandparentIds.has(
                                            parent.id,
                                          )
                                            ? "-2px"
                                            : undefined,
                                      }}
                                    >
                                      {child.cover ? (
                                        <img
                                          src={child.cover}
                                          alt={child.name}
                                          className="h-full w-full object-cover"
                                        />
                                      ) : (
                                        <div className="h-full w-full" />
                                      )}
                                      <button
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          toggleSearchSelection(parent.id);
                                        }}
                                        className={`absolute inset-0 flex items-center justify-center transition-all duration-150 ${
                                          selectedSearchGrandparentIds.has(
                                            parent.id,
                                          )
                                            ? "opacity-100"
                                            : "opacity-0 group-hover/cover:opacity-100"
                                        }`}
                                        style={{
                                          background: "rgba(0,0,0,0.42)",
                                          color: "white",
                                        }}
                                        title={
                                          selectedSearchGrandparentIds.has(
                                            parent.id,
                                          )
                                            ? "Remove selection"
                                            : "Select"
                                        }
                                      >
                                        {selectedSearchGrandparentIds.has(
                                          parent.id,
                                        ) ? (
                                          <span className="text-2xl leading-none">
                                            -
                                          </span>
                                        ) : (
                                          <Plus size={18} strokeWidth={1.9} />
                                        )}
                                      </button>
                                    </div>
                                    <div className="px-0.5">
                                      <p className="truncate text-[10px] font-medium text-white/70 group-hover/child:text-white/90">
                                        {child.name}
                                      </p>
                                    </div>
                                  </div>
                                ))}
                                {parent.children.length === 0 && (
                                  <div className="flex w-20 shrink-0 items-center justify-center text-[10px] italic text-white/20">
                                    no sub-entities
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : addSuggestionsLoaded ? (
                        <div className="px-2 py-3 text-xs text-white/40">
                          no matches
                        </div>
                      ) : null}
                    </div>
                    {(selectedSearchCount > 0 || selectedResolvedUrls.size > 0) && (
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (resolvedData) void addResolvedItems();
                          else void addSelectedSearchItems();
                        }}
                        disabled={addingSearchSelections || addingResolved}
                        className="flex-shrink-0 w-full rounded-b-xl px-3 py-2 text-xs font-medium transition-opacity disabled:opacity-50"
                        style={{
                          background: "white",
                          color: "black",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {addingSearchSelections || addingResolved
                          ? "adding..."
                          : resolvedData
                            ? `add ${selectedResolvedUrls.size} item${selectedResolvedUrls.size === 1 ? "" : "s"}`
                            : `add ${selectedSearchCount} item${selectedSearchCount === 1 ? "" : "s"}`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setAddOpen(true)}
                className="relative flex w-full items-center justify-center rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,background-image,opacity] duration-200 active:scale-[0.98]"
                style={{
                  borderColor: "rgba(255,255,255,0.08)",
                  background: "rgb(14,14,18)",
                  color: "rgba(255, 255, 255, 0.75)",
                  boxShadow: "rgba(0,0,0,0.3) 0px 2px 4px",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                  e.currentTarget.style.color = "rgba(255, 255, 255, 0.95)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                  e.currentTarget.style.color = "rgba(255, 255, 255, 0.75)";
                }}
              >
                + add source
              </button>
            )}

          </div>
        </div>

        {/* Omnibox */}
        <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 w-[600px] pointer-events-auto">
          <input
            ref={omniFileRef}
            type="file"
            accept="audio/*,video/*,image/*"
            className="hidden"
            onChange={(e) => setOmniFile(e.target.files?.[0] ?? null)}
          />
          <div
            className="flex flex-col rounded-2xl cursor-text"
            onClick={() => omniTextRef.current?.focus()}
            onDragOver={(e) => {
              e.preventDefault();
              setOmniDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setOmniDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOmniDragging(false);
              const f = Array.from(e.dataTransfer.files).find(
                (f) =>
                  f.type.startsWith("audio/") ||
                  f.type.startsWith("video/") ||
                  f.type.startsWith("image/"),
              );
              if (f) setOmniFile(f);
            }}
            style={{
              backgroundImage:
                "linear-gradient(rgb(30, 31, 48) 0%, rgb(24, 25, 40) 50%, color-mix(in oklch, rgb(99, 102, 241) 12%, rgb(20, 20, 30)) 100%)",
              border: omniDragging
                ? "1px solid rgba(99,102,241,0.7)"
                : "1px solid rgb(60, 62, 80)",
              boxShadow: omniDragging
                ? "rgba(0,0,0,0.3) 0px 2px 4px, 0 24px 64px rgba(0,0,0,0.6), 0 0 0 3px rgba(99,102,241,0.18)"
                : "rgba(0,0,0,0.3) 0px 2px 4px, 0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            {/* Text area */}
            <div className="px-5 pt-4 pb-2">
              <textarea
                ref={omniTextRef}
                rows={1}
                value={omniText}
                onChange={(e) => {
                  setOmniText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitOmni();
                  }
                }}
                placeholder={
                  omniDragging
                    ? "Drop to attach"
                    : "describe a vibe, or attach audio, video, or an image"
                }
                className={`w-full bg-transparent text-[15px] text-white outline-none resize-none leading-relaxed ${omniDragging ? "placeholder-indigo-400/70" : "placeholder-white/30"}`}
                style={{
                  maxHeight: 180,
                  overflowY: "auto",
                  scrollbarWidth: "none",
                }}
              />
            </div>

            {/* Bottom bar */}
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => omniFileRef.current?.click()}
                  className="flex items-center justify-center w-9 h-9 rounded-xl transition-colors hover:bg-white/6"
                  style={{ color: "rgba(255,255,255,0.4)" }}
                  title="attach audio, video, or image"
                >
                  <Plus size={18} strokeWidth={1.75} />
                </button>
                {omniFile && (
                  <div
                    className="relative flex-shrink-0 w-9 h-9 rounded-xl overflow-hidden cursor-pointer"
                    style={{ background: "rgba(255,255,255,0.08)" }}
                    onMouseEnter={() => setOmniThumbHover(true)}
                    onMouseLeave={() => setOmniThumbHover(false)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOmniFile(null);
                    }}
                    title="remove attachment"
                  >
                    {omniFileUrl && omniFile?.type.startsWith("image/") ? (
                      <img
                        src={omniFileUrl ?? ""}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center"
                        style={{ color: "rgba(255,255,255,0.4)" }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path
                            d="M9 18V5l12-2v13"
                            stroke="currentColor"
                            strokeWidth="1.75"
                          />
                          <circle
                            cx="6"
                            cy="18"
                            r="3"
                            stroke="currentColor"
                            strokeWidth="1.75"
                          />
                          <circle
                            cx="18"
                            cy="16"
                            r="3"
                            stroke="currentColor"
                            strokeWidth="1.75"
                          />
                        </svg>
                      </div>
                    )}
                    {omniThumbHover && (
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ background: "rgba(0,0,0,0.6)" }}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 14 14"
                          fill="none"
                        >
                          <path
                            d="M2 2l10 10M12 2L2 12"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={submitOmni}
                disabled={omniLoading || (!omniText.trim() && !omniFile)}
                className="flex items-center justify-center w-9 h-9 rounded-xl transition-all active:scale-95 disabled:opacity-20"
                style={{ background: "white", color: "black" }}
              >
                {omniLoading ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 14 14"
                    fill="none"
                    className="animate-spin"
                  >
                    <circle
                      cx="7"
                      cy="7"
                      r="5.5"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeDasharray="10 10"
                    />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path
                      d="M12 19V5M5 12l7-7 7 7"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
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
