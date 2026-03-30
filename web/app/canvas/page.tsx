"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Canvas, type CanvasHandle } from "../components/Canvas";
import Player from "../components/Player";
import { CanvasControls, CoverMode } from "../components/CanvasControls";
import { ArtistPickerCmdk } from "../components/ArtistPickerCmdk";
import { Nav } from "../components/Nav";
import {
  type CanvasEntity,
  type CanvasGrandparent,
  type CanvasPayload,
  type CanvasTrack,
  fetchCanvasPayload,
} from "@/lib/api/canvas-types";
import { authClient } from "@/lib/auth/client";
import {
  clearExpectCanvasAfterOAuth,
  markExpectCanvasAfterOAuth,
  postSignInCanvasUrl,
} from "@/lib/auth/post-sign-in-url";
import {
  clearPendingAddBulk,
  peekPendingAddBulk,
  restorePendingAddBulk,
} from "@/lib/onboarding/pending-add-bulk";
import { publicMusApiUrl } from "@/lib/mus/public";
import { pastelFromId } from "@/lib/pastelFromId";
import { useCanvasQuery } from "@/lib/query/hooks/use-canvas";
import { usePatchParentCanvasVisible } from "@/lib/query/hooks/use-parent-canvas-mutation";
import { queryKeys } from "@/lib/query/keys";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Track } from "../components/TrackTile";
import { toast } from "sonner";

const TRACK_LIMIT = 500;
const NON_DELETABLE_GRANDPARENT_TYPES = new Set(["orphans"]);
const HIDDEN_EMPTY_GRANDPARENT_TYPES = new Set(["orphans"]);

const EMPTY_TRACKS: CanvasTrack[] = [];
const EMPTY_ENTITIES: CanvasEntity[] = [];
const EMPTY_GPS: CanvasGrandparent[] = [];

/** Avoid duplicate add-bulk if React Strict Mode runs the effect twice. */
let pendingAddBulkApplyInFlight = false;

const SEARCH_CANVAS_POLL_MS = 400;
const SEARCH_CANVAS_MAX_WAIT_MS = 90_000;

/** Black circle × centered on the card’s top-right corner (half outside). */
function DockedPlayerCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close player"
      className="pointer-events-auto absolute top-0 right-0 z-20 flex h-6 w-6 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black text-white shadow-[0_2px_10px_rgba(0,0,0,0.55)] outline-none ring-1 ring-white/20 transition-colors duration-150 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <X size={11} strokeWidth={2.25} className="text-white" aria-hidden />
    </button>
  );
}

/** Search tour steps: result tracks only (not the query/sentinel tile). */
function buildSearchTourIndices(
  rows: CanvasTrack[],
  trackIds: string[],
  sentinelId: string | null,
): number[] {
  const ids =
    sentinelId != null
      ? trackIds.filter((id) => String(id) !== String(sentinelId))
      : trackIds;
  return ids
    .map((id) => rows.find((t) => t.trackId === String(id))?.index)
    .filter((i): i is number => i !== undefined);
}

/** Rows present + layout done, or every tour tile has coordinates for `proj` (while reproject still flagged). */
function isSearchCanvasReady(
  data: CanvasPayload,
  trackIds: string[],
  sentinelId: string | null,
  proj: string,
): boolean {
  if (!trackIds.length) return false;
  const rows = data.tracks;
  const byId = new Map(rows.map((t) => [String(t.trackId), t]));
  for (const id of trackIds) {
    if (!byId.has(String(id))) return false;
  }
  if (sentinelId && !byId.has(String(sentinelId))) return false;

  if (!data.reprojectPending) return true;

  const ids = [
    ...new Set([
      ...trackIds.map(String),
      ...(sentinelId ? [String(sentinelId)] : []),
    ]),
  ];
  return ids.every((id) => {
    const t = byId.get(id);
    if (!t) return false;
    const c = t.projections?.[proj];
    return Array.isArray(c) && c.length === 2;
  });
}

export default function CanvasPage() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const patchCanvasVisible = usePatchParentCanvasVisible();

  const sessionUserId = session.data?.user?.id;
  const canvasQueryEnabled = !session.isPending && Boolean(sessionUserId);
  const {
    data: canvasData,
    isPending: canvasPending,
    error: canvasQueryError,
    refetch: refetchCanvasQuery,
  } = useCanvasQuery(canvasQueryEnabled);

  const tracks = useMemo(
    () => canvasData?.tracks ?? EMPTY_TRACKS,
    [canvasData],
  );
  const entities = useMemo(
    () => canvasData?.entities ?? EMPTY_ENTITIES,
    [canvasData],
  );
  const checkedParentIdsCsv = useMemo(
    () =>
      entities
        .filter((e) => e.canvasVisible)
        .map((e) => e.id)
        .join(","),
    [entities],
  );
  const hasCheckedAlbum = useMemo(
    () => entities.some((e) => e.canvasVisible),
    [entities],
  );
  const grandparents = useMemo(
    () => canvasData?.grandparents ?? EMPTY_GPS,
    [canvasData],
  );
  const loading = canvasPending && !canvasData;

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const [searchTour, setSearchTour] = useState<number[] | null>(null);
  const [tourStep, setTourStep] = useState(0);
  /** Sidebar "searches" row: second click ends tour (was tied to sentinel-as-first-step). */
  const searchTourFromEntityRef = useRef<string | null>(null);
  const endSearchTour = useCallback(() => {
    searchTourFromEntityRef.current = null;
    setSearchTour(null);
  }, []);
  /** End tour and hide docked player (X on tour, Escape, sidebar deselect, player close). */
  const endSearchTourAndClosePlayer = useCallback(() => {
    endSearchTour();
    setCurrentTrack(null);
  }, [endSearchTour]);
  const dismissPlayer = useCallback(() => {
    endSearchTourAndClosePlayer();
  }, [endSearchTourAndClosePlayer]);
  const [projection, setProjection] = useState("umap");
  const [coverMode, setCoverMode] = useState<CoverMode>("album");
  const gridSize = 8000;

  // Grandparent section expand/collapse — local only; all collapsed on load / refetch does not reset.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    () => new Set(),
  );

  /** Any parent row (search, album, playlist, …): expand to list tracks (local only). */
  const [expandedParentTrackIds, setExpandedParentTrackIds] = useState<
    Set<string>
  >(() => new Set());

  // Omnibox
  const [omniText, setOmniText] = useState("");
  const [omniFile, setOmniFile] = useState<File | null>(null);
  const [omniFileUrl, setOmniFileUrl] = useState<string | null>(null);
  const [omniThumbHover, setOmniThumbHover] = useState(false);
  const [omniDragging, setOmniDragging] = useState(false);
  const [omniLoading, setOmniLoading] = useState(false);
  const omniFileRef = useRef<HTMLInputElement>(null);
  const omniTextRef = useRef<HTMLTextAreaElement>(null);

  // Find-in-canvas (cmd+f)
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!omniFile) {
      setOmniFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(omniFile);
    setOmniFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [omniFile]);

  const [artistPickerOpen, setArtistPickerOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    groupId: string;
    entityId?: string;
  } | null>(null);

  const canvasLoadErrorShown = useRef(false);
  useEffect(() => {
    if (!canvasQueryError) {
      canvasLoadErrorShown.current = false;
      return;
    }
    if (canvasLoadErrorShown.current) return;
    canvasLoadErrorShown.current = true;
    toast.error("Couldn't load canvas", {
      description:
        canvasQueryError instanceof Error
          ? canvasQueryError.message
          : "Network error",
      action: {
        label: "Retry",
        onClick: () => {
          canvasLoadErrorShown.current = false;
          void refetchCanvasQuery();
        },
      },
    });
  }, [canvasQueryError, refetchCanvasQuery]);

  const applySearchTourAfterFetch = useCallback(
    async (trackIds: string[], sentinelId?: string | null) => {
      const sent = sentinelId ?? null;
      if (!trackIds.length) {
        endSearchTour();
        await queryClient.refetchQueries({ queryKey: queryKeys.canvas });
        return;
      }

      const deadline = Date.now() + SEARCH_CANVAS_MAX_WAIT_MS;
      let latest: CanvasPayload | undefined;
      let timedOut = false;

      while (Date.now() < deadline) {
        const data = await queryClient.fetchQuery({
          queryKey: queryKeys.canvas,
          queryFn: fetchCanvasPayload,
        });
        latest = data;
        if (isSearchCanvasReady(data, trackIds, sent, projection)) break;
        await new Promise((r) => setTimeout(r, SEARCH_CANVAS_POLL_MS));
      }

      if (!latest) {
        toast.error("Couldn't load canvas", { description: "Try again." });
        return;
      }

      if (
        Date.now() >= deadline &&
        !isSearchCanvasReady(latest, trackIds, sent, projection)
      ) {
        timedOut = true;
        toast.error("Layout timed out", {
          description: "Showing results if available.",
        });
      }

      const rows = latest.tracks;
      const indices = buildSearchTourIndices(rows, trackIds, sent);
      if (indices.length === 0) {
        endSearchTour();
        if (!timedOut) {
          toast.error("Search results not on the map yet", {
            description: "Try refreshing or search again.",
          });
        }
        return;
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      searchTourFromEntityRef.current = null;
      setSearchTour(indices);
      setTourStep(0);
      const first = rows.find((t) => t.index === indices[0]);
      if (first) setCurrentTrack(first);
    },
    [endSearchTour, queryClient, projection],
  );

  const submitOmni = async () => {
    if (!omniText.trim() && !omniFile) return;
    const userId = session.data?.user?.id;
    if (!userId) return;
    endSearchTourAndClosePlayer();
    setOmniLoading(true);
    try {
      const form = new FormData();
      form.append("user_id", userId);
      if (omniText.trim()) form.append("text", omniText.trim());
      if (omniFile) form.append("file", omniFile);
      const res = await fetch(`${publicMusApiUrl()}/api/search`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        toast.error("Search failed", {
          description: res.statusText || `HTTP ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as {
        trackIds?: string[];
        sentinelId?: string;
      };
      setOmniFile(null);
      await applySearchTourAfterFetch(
        data.trackIds ?? [],
        data.sentinelId ?? null,
      );
    } catch (e) {
      toast.error("Search failed", {
        description: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setOmniLoading(false);
    }
  };

  const submitSimilarFromTrack = useCallback(
    async (track: Track) => {
      const userId = session.data?.user?.id;
      if (!userId || !track.trackId) return;
      endSearchTour();
      setOmniLoading(true);
      try {
        const form = new FormData();
        form.append("user_id", userId);
        form.append("track_id", track.trackId);
        const res = await fetch(`${publicMusApiUrl()}/api/search/similar`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          toast.error("Similar search failed", {
            description: res.statusText || `HTTP ${res.status}`,
          });
          return;
        }
        const data = (await res.json()) as {
          trackIds?: string[];
          sentinelId?: string;
        };
        await applySearchTourAfterFetch(
          data.trackIds ?? [],
          data.sentinelId ?? null,
        );
      } catch (e) {
        toast.error("Similar search failed", {
          description: e instanceof Error ? e.message : "Network error",
        });
      } finally {
        setOmniLoading(false);
      }
    },
    [applySearchTourAfterFetch, endSearchTour, session.data?.user?.id],
  );

  const submitRecommended = useCallback(async () => {
    const userId = session.data?.user?.id;
    if (!userId || !checkedParentIdsCsv) return;
    endSearchTourAndClosePlayer();
    setOmniLoading(true);
    try {
      const form = new FormData();
      form.append("user_id", userId);
      form.append("parent_ids", checkedParentIdsCsv);
      const res = await fetch(`${publicMusApiUrl()}/api/search/recommended`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        let detail = res.statusText || `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { detail?: unknown };
          if (typeof j.detail === "string") detail = j.detail;
        } catch {
          /* keep detail */
        }
        toast.error("Recommendations failed", { description: detail });
        return;
      }
      const data = (await res.json()) as {
        trackIds?: string[];
        sentinelId?: string;
      };
      await applySearchTourAfterFetch(
        data.trackIds ?? [],
        data.sentinelId ?? null,
      );
    } catch (e) {
      toast.error("Recommendations failed", {
        description: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setOmniLoading(false);
    }
  }, [
    applySearchTourAfterFetch,
    checkedParentIdsCsv,
    endSearchTourAndClosePlayer,
    session.data?.user?.id,
  ]);

  useLayoutEffect(() => {
    if (session.isPending) return;
    if (!session.data?.user) {
      markExpectCanvasAfterOAuth();
      void authClient.signIn.social({
        provider: "google",
        callbackURL: postSignInCanvasUrl(),
      });
    }
  }, [session.isPending, session.data?.user]);

  useEffect(() => {
    clearExpectCanvasAfterOAuth();
  }, []);

  useEffect(() => {
    if (session.isPending || !sessionUserId) return;
    if (pendingAddBulkApplyInFlight) return;
    const ids = peekPendingAddBulk();
    if (!ids?.length) return;

    pendingAddBulkApplyInFlight = true;
    void (async () => {
      try {
        const res = await fetch("/api/me/add-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grandparentIds: ids }),
        });
        if (!res.ok) {
          let detail = res.statusText || `HTTP ${res.status}`;
          try {
            const j = (await res.json()) as { error?: unknown; detail?: unknown };
            if (typeof j.error === "string") detail = j.error;
            else if (typeof j.detail === "string") detail = j.detail;
          } catch {
            /* keep detail */
          }
          restorePendingAddBulk(ids);
          toast.error("Couldn't add your artists", { description: detail });
          return;
        }
        clearPendingAddBulk();
        await queryClient.invalidateQueries({ queryKey: queryKeys.canvas });
        toast.success("Your picks are on the canvas");
      } catch (e) {
        restorePendingAddBulk(ids);
        toast.error("Couldn't add your artists", {
          description: e instanceof Error ? e.message : "Network error",
        });
      } finally {
        pendingAddBulkApplyInFlight = false;
      }
    })();
  }, [session.isPending, sessionUserId, queryClient]);

  // cmd+f / ctrl+f → open find bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 0);
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
        setFindQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen]);

  const addedGrandparentIds = useMemo(
    () =>
      new Set(
        entities
          .map((e) => e.parentId)
          .filter((id): id is string => Boolean(id)),
      ),
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
        children: CanvasEntity[];
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
      const rank = (type: string) =>
        type === "searches" ? 0 : type === "orphans" ? 2 : 1;
      return rank(a.type) - rank(b.type);
    });
  }, [grandparents, entities]);

  const toggleGrandparentVisibility = (groupId: string) => {
    endSearchTour();
    const group = entityGroups.find((g) => g.id === groupId);
    if (!group) return;
    const ready = group.children.filter((c) => c.status === "ready");
    if (!ready.length) return;
    const allOn = ready.every((c) => c.canvasVisible);
    const next = !allOn;
    const childIds = ready.map((c) => c.id);

    void queryClient.cancelQueries({ queryKey: queryKeys.canvas });
    const prevSnap = queryClient.getQueryData<CanvasPayload>(queryKeys.canvas);
    if (prevSnap) {
      queryClient.setQueryData<CanvasPayload>(queryKeys.canvas, {
        ...prevSnap,
        entities: prevSnap.entities.map((e) =>
          childIds.includes(e.id) ? { ...e, canvasVisible: next } : e,
        ),
      });
    }

    void Promise.all(
      childIds.map((id) =>
        fetch(`/api/me/parents/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canvasVisible: next }),
        }),
      ),
    )
      .then((responses) => {
        if (responses.some((r) => !r.ok)) throw new Error();
      })
      .catch(() => {
        if (prevSnap) queryClient.setQueryData(queryKeys.canvas, prevSnap);
        void queryClient.invalidateQueries({ queryKey: queryKeys.canvas });
      });
  };

  const deleteEntity = (entityId: string) => {
    void queryClient.cancelQueries({ queryKey: queryKeys.canvas });
    const prevSnap = queryClient.getQueryData<CanvasPayload>(queryKeys.canvas);
    if (prevSnap) {
      queryClient.setQueryData<CanvasPayload>(queryKeys.canvas, {
        ...prevSnap,
        entities: prevSnap.entities.filter((e) => e.id !== entityId),
        tracks: prevSnap.tracks.filter((t) => t.sourceEntityId !== entityId),
      });
    }
    fetch(`/api/me/parents/${entityId}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error();
      })
      .catch(() => {
        if (prevSnap) queryClient.setQueryData(queryKeys.canvas, prevSnap);
        void queryClient.invalidateQueries({ queryKey: queryKeys.canvas });
      });
  };

  const deleteGrandparent = async (grandparentId: string) => {
    const grandparent = grandparents.find((gp) => gp.id === grandparentId);
    if (!grandparent || NON_DELETABLE_GRANDPARENT_TYPES.has(grandparent.type))
      return;

    void queryClient.cancelQueries({ queryKey: queryKeys.canvas });
    const prevSnap = queryClient.getQueryData<CanvasPayload>(queryKeys.canvas);
    if (prevSnap) {
      const removedEntityIds = new Set(
        prevSnap.entities
          .filter((e) => e.parentId === grandparentId)
          .map((e) => e.id),
      );
      queryClient.setQueryData<CanvasPayload>(queryKeys.canvas, {
        ...prevSnap,
        grandparents: prevSnap.grandparents.filter(
          (g) => g.id !== grandparentId,
        ),
        entities: prevSnap.entities.filter((e) => e.parentId !== grandparentId),
        tracks: prevSnap.tracks.filter(
          (t) => !removedEntityIds.has(t.sourceEntityId),
        ),
      });
    }

    try {
      const res = await fetch("/api/me/grandparents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grandparentId }),
      });
      if (!res.ok) throw new Error();
    } catch {
      if (prevSnap) queryClient.setQueryData(queryKeys.canvas, prevSnap);
      void queryClient.invalidateQueries({ queryKey: queryKeys.canvas });
    }
  };

  const artistCovers = useMemo(
    () => entities.map((e) => e.parentCover ?? e.cover),
    [entities],
  );

  const visibleParentIds = useMemo(() => {
    return new Set(entities.filter((e) => e.canvasVisible).map((e) => e.id));
  }, [entities]);

  const visibleTracks = useMemo(() => {
    return tracks
      .filter((t) => visibleParentIds.has(t.sourceEntityId))
      .slice(0, TRACK_LIMIT);
  }, [tracks, visibleParentIds]);

  const tracksBySourceEntityId = useMemo(() => {
    const m = new Map<string, (Track & { sourceEntityId: string })[]>();
    for (const t of tracks) {
      const sid = t.sourceEntityId;
      if (!sid) continue;
      const arr = m.get(sid);
      if (arr) arr.push(t);
      else m.set(sid, [t]);
    }
    return m;
  }, [tracks]);

  const startSearchTourForEntity = useCallback(
    (sourceEntityId: string) => {
      const list = tracksBySourceEntityId.get(sourceEntityId) ?? [];
      if (list.length === 0) return;

      const applyTourFromSubset = (
        subset: (Track & { sourceEntityId: string })[],
        rowSource: (Track & { sourceEntityId: string })[],
      ) => {
        const indices = subset.filter((t) => !t.isQuery).map((t) => t.index);
        if (indices.length === 0) return;
        searchTourFromEntityRef.current = sourceEntityId;
        setSearchTour(indices);
        setTourStep(0);
        const first = rowSource.find((t) => t.index === indices[0]);
        if (first) setCurrentTrack(first);
      };

      const visibleIndexSet = new Set(visibleTracks.map((t) => t.index));
      const visibleSubset = list.filter((t) => visibleIndexSet.has(t.index));

      if (visibleSubset.length > 0) {
        applyTourFromSubset(visibleSubset, tracks);
        return;
      }

      const ent = entities.find((e) => e.id === sourceEntityId);
      if (ent && !ent.canvasVisible) {
        applyTourFromSubset(list, tracks);
        void (async () => {
          try {
            await patchCanvasVisible.mutateAsync({
              parentId: sourceEntityId,
              canvasVisible: true,
            });
          } catch {
            endSearchTour();
            void queryClient.invalidateQueries({ queryKey: queryKeys.canvas });
          }
        })();
        return;
      }

      applyTourFromSubset(list, tracks);
    },
    [
      tracksBySourceEntityId,
      visibleTracks,
      tracks,
      entities,
      patchCanvasVisible,
      endSearchTour,
      queryClient,
    ],
  );

  const findMatchIndices = useMemo<Set<number>>(() => {
    const q = findQuery.trim().toLowerCase();
    if (!findOpen || !q) return new Set();
    return new Set(
      visibleTracks
        .filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q),
        )
        .map((t) => t.index),
    );
  }, [findOpen, findQuery, visibleTracks]);

  /** Same dimming as cmd+f: Canvas dims tiles not in this set (opacity 0.2). */
  const canvasHighlightIndices = useMemo(() => {
    const next = new Set<number>();
    for (const i of findMatchIndices) next.add(i);
    if (searchTour?.length) {
      for (const i of searchTour) next.add(i);
    }
    const findActiveWithHits =
      findOpen &&
      findQuery.trim().length > 0 &&
      findMatchIndices.size > 0;
    if (!findActiveWithHits && currentTrack) {
      next.add(currentTrack.index);
    }
    return next;
  }, [
    findMatchIndices,
    searchTour,
    findOpen,
    findQuery,
    currentTrack,
  ]);

  const handleTrackClick = useCallback(
    (track: Track) => {
      setSearchTour((st) => {
        if (st?.length && !st.includes(track.index)) {
          searchTourFromEntityRef.current = null;
          return null;
        }
        return st;
      });
      const isDeselect = currentTrack?.index === track.index;
      setCurrentTrack((prev) => (prev?.index === track.index ? null : track));
      if (!isDeselect) {
        requestAnimationFrame(() => {
          canvasRef.current?.focusTrackTour(track.index, projection);
        });
      }
    },
    [currentTrack?.index, projection],
  );

  const toggleParentTracksExpanded = useCallback(
    (parentId: string) => {
      endSearchTour();
      setExpandedParentTrackIds((prev) => {
        const next = new Set(prev);
        if (next.has(parentId)) next.delete(parentId);
        else next.add(parentId);
        return next;
      });
    },
    [endSearchTour],
  );

  const focusSidebarTrack = useCallback(
    (track: Track & { sourceEntityId: string }) => {
      endSearchTour();
      setCurrentTrack(track);
      requestAnimationFrame(() => {
        canvasRef.current?.focusTrackTour(track.index, projection);
      });
    },
    [endSearchTour, projection],
  );

  const toggleEntity = async (id: string) => {
    endSearchTour();
    const ent = entities.find((e) => e.id === id);
    if (!ent || ent.status !== "ready") return;
    const next = !ent.canvasVisible;
    try {
      await patchCanvasVisible.mutateAsync({
        parentId: id,
        canvasVisible: next,
      });
    } catch (error) {
      toast.error("Couldn't update visibility", {
        description:
          error instanceof Error ? error.message : "Network or server error",
      });
    }
  };

  const toggleExpanded = (groupId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const tourTrack = useMemo(() => {
    if (!searchTour?.length) return null;
    const idx = searchTour[tourStep];
    return tracks.find((t) => t.index === idx) ?? null;
  }, [searchTour, tourStep, tracks]);

  const searchTourResultCount = useMemo(() => {
    if (!searchTour?.length) return 0;
    let n = 0;
    for (const idx of searchTour) {
      const t = tracks.find((x) => x.index === idx);
      if (t && !t.isQuery) n++;
    }
    return n;
  }, [searchTour, tracks]);

  const tourWalkLabel = useMemo(() => {
    if (!searchTour?.length || !tourTrack) return "";
    const n = searchTourResultCount;
    if (n === 0) return `${tourStep + 1} / 0`;
    if (tourTrack.isQuery) return `search / ${n}`;
    let rank = 0;
    for (let s = 0; s <= tourStep; s++) {
      const idx = searchTour[s];
      const t = tracks.find((x) => x.index === idx);
      if (t?.isQuery) continue;
      rank++;
      if (s === tourStep) return `${rank} / ${n}`;
    }
    return `${tourStep + 1} / ${n}`;
  }, [searchTour, tourTrack, tourStep, tracks, searchTourResultCount]);

  const searchTourRef = useRef(searchTour);
  searchTourRef.current = searchTour;

  const tourNext = useCallback(() => {
    setTourStep((s) => {
      const tour = searchTourRef.current;
      if (!tour?.length) return s;
      return (s + 1) % tour.length;
    });
  }, []);

  const tourPrev = useCallback(() => {
    setTourStep((s) => {
      const tour = searchTourRef.current;
      if (!tour?.length) return s;
      return (s - 1 + tour.length) % tour.length;
    });
  }, []);

  useEffect(() => {
    if (!searchTour?.length) return;
    const idx = searchTour[tourStep];
    const tr = tracks.find((t) => t.index === idx);
    if (tr) setCurrentTrack(tr);
  }, [searchTour, tourStep, tracks]);

  useEffect(() => {
    if (!searchTour?.length) return;
    const idx = searchTour[tourStep];
    const id = requestAnimationFrame(() => {
      canvasRef.current?.focusTrackTour(idx, projection);
    });
    return () => cancelAnimationFrame(id);
  }, [searchTour, tourStep, projection, tracks.length]);

  useEffect(() => {
    if (!searchTour?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        tourPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        tourNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        endSearchTourAndClosePlayer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchTour, tourPrev, tourNext, endSearchTourAndClosePlayer]);

  if (session.isPending || !session.data?.user) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black text-sm text-white/45">
        {session.isPending ? "Loading…" : "Redirecting to sign in…"}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-black text-white">
      <div className="relative z-0 min-h-0 flex-1 overflow-hidden">
        <Canvas
          ref={canvasRef}
          tracks={visibleTracks}
          currentTrack={currentTrack}
          onTrackClick={handleTrackClick}
          artistCovers={artistCovers}
          gridSize={gridSize}
          coverMode={coverMode}
          projection={projection}
          highlightIndices={canvasHighlightIndices}
        />

        <div className="absolute top-3 left-3 right-3 z-10 pointer-events-auto">
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
            {loading && entities.length === 0
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
                  const expanded = expandedParents.has(group.id);
                  const isSolo = group.id.startsWith("__solo__");
                  return (
                    <div key={group.id} className="flex flex-col group/gp">
                      {/* Profile/artist header — prominent, collapsible */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          endSearchTour();
                          if (isSolo) toggleEntity(group.children[0].id);
                          else toggleExpanded(group.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          endSearchTour();
                          if (isSolo) toggleEntity(group.children[0].id);
                          else toggleExpanded(group.id);
                        }}
                        {...(group.type !== "searches" && {
                          onContextMenu: (e: React.MouseEvent) => {
                            e.preventDefault();
                            setCtxMenu({
                              x: e.clientX,
                              y: e.clientY,
                              groupId: group.id,
                            });
                          },
                        })}
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
                        {/* Grandparent checkbox */}
                        {(() => {
                          const ready = group.children.filter(
                            (c) => c.status === "ready",
                          );
                          const allOn =
                            ready.length > 0 &&
                            ready.every((c) => c.canvasVisible);
                          return (
                            <button
                              type="button"
                              aria-label={
                                allOn
                                  ? "Hide all on canvas"
                                  : "Show all on canvas"
                              }
                              className="flex-shrink-0 flex cursor-pointer items-center justify-center p-1 rounded-md outline-none focus:outline-none"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGrandparentVisibility(group.id);
                              }}
                            >
                              <span
                                className="flex-shrink-0 flex items-center justify-center rounded-sm transition-all"
                                style={{
                                  width: 15,
                                  height: 15,
                                  border: allOn
                                    ? "none"
                                    : "1.5px solid rgba(255,255,255,0.2)",
                                  background: allOn ? "white" : "transparent",
                                }}
                              >
                                {allOn && (
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
                            </button>
                          );
                        })()}
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
                                const notReady = child.status !== "ready";
                                const on = !notReady && child.canvasVisible;
                                const count = child.trackCount;
                                const canListTracks = !notReady && count > 0;
                                const tracksExpanded =
                                  canListTracks &&
                                  expandedParentTrackIds.has(child.id);
                                const childTracks =
                                  tracksBySourceEntityId.get(child.id) ?? [];
                                return (
                                  <div
                                    key={child.id}
                                    className="flex flex-col w-full min-w-0"
                                  >
                                    <div
                                      className={`flex items-center gap-0.5 w-full min-w-0 rounded-lg transition-colors ${
                                        notReady ? "" : "hover:bg-white/[0.04]"
                                      }`}
                                      {...(group.type === "searches" && {
                                        onContextMenu: (
                                          e: React.MouseEvent,
                                        ) => {
                                          e.preventDefault();
                                          setCtxMenu({
                                            x: e.clientX,
                                            y: e.clientY,
                                            groupId: group.id,
                                            entityId: child.id,
                                          });
                                        },
                                      })}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (notReady) return;
                                          if (group.type === "searches") {
                                            if (
                                              searchTour?.length &&
                                              searchTourFromEntityRef.current ===
                                                child.id
                                            ) {
                                              endSearchTourAndClosePlayer();
                                              return;
                                            }
                                            startSearchTourForEntity(child.id);
                                          } else {
                                            toggleEntity(child.id);
                                          }
                                        }}
                                        className={`flex flex-1 items-center gap-3 min-w-0 py-1.5 px-3 text-left rounded-lg outline-none focus:outline-none ${notReady ? "cursor-default" : "cursor-pointer"}`}
                                        style={{
                                          opacity: notReady
                                            ? 0.5
                                            : on
                                              ? 1
                                              : 0.58,
                                        }}
                                      >
                                        <div className="relative flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-zinc-800">
                                          {group.type === "searches" ? (
                                            child.cover ? (
                                              <Image
                                                src={child.cover}
                                                alt=""
                                                fill
                                                sizes="32px"
                                                className="object-cover"
                                              />
                                            ) : (
                                              <div
                                                className="h-full w-full"
                                                style={{
                                                  background: pastelFromId(
                                                    child.id,
                                                  ),
                                                }}
                                              />
                                            )
                                          ) : (
                                            child.cover && (
                                              <Image
                                                src={child.cover}
                                                alt=""
                                                fill
                                                sizes="32px"
                                                className="object-cover"
                                              />
                                            )
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
                                            {notReady
                                              ? "not ready"
                                              : `${count} song${count === 1 ? "" : "s"}`}
                                          </p>
                                        </div>
                                      </button>
                                      {notReady ? (
                                        <span
                                          className="flex-shrink-0 w-[15px] h-[15px] mr-2 rounded-sm border border-white/15"
                                          aria-hidden
                                        />
                                      ) : (
                                        <button
                                          type="button"
                                          aria-label={
                                            on
                                              ? "Hide on canvas"
                                              : "Show on canvas"
                                          }
                                          className="flex-shrink-0 flex cursor-pointer items-center justify-center p-1 rounded-md outline-none focus:outline-none"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleEntity(child.id);
                                          }}
                                        >
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
                                        </button>
                                      )}
                                      {canListTracks ? (
                                        <button
                                          type="button"
                                          aria-expanded={tracksExpanded}
                                          aria-label={
                                            tracksExpanded
                                              ? "Hide songs"
                                              : "Show songs"
                                          }
                                          className="flex-shrink-0 w-7 h-8 mr-1 flex items-center justify-center rounded-md text-white/35 outline-none focus:outline-none"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleParentTracksExpanded(
                                              child.id,
                                            );
                                          }}
                                        >
                                          <ChevronDown
                                            size={14}
                                            strokeWidth={2}
                                            className="transition-transform duration-200"
                                            style={{
                                              transform: tracksExpanded
                                                ? "rotate(0deg)"
                                                : "rotate(-90deg)",
                                            }}
                                          />
                                        </button>
                                      ) : null}
                                    </div>
                                    {canListTracks ? (
                                      <div
                                        style={{
                                          display: "grid",
                                          gridTemplateRows: tracksExpanded
                                            ? "1fr"
                                            : "0fr",
                                          transition:
                                            "grid-template-rows 0.22s cubic-bezier(0.4,0,0.2,1)",
                                        }}
                                      >
                                        <div className="overflow-hidden">
                                          <div className="mt-0.5 mb-1 w-full flex flex-col gap-0">
                                            {childTracks.map((t) => (
                                              <button
                                                key={
                                                  t.trackId ?? String(t.index)
                                                }
                                                type="button"
                                                onClick={() =>
                                                  focusSidebarTrack(t)
                                                }
                                                className="w-full text-left py-1.5 px-3 rounded-md hover:bg-white/[0.06] outline-none focus:outline-none min-w-0"
                                              >
                                                <span className="text-[11px] font-medium text-white/90 truncate block">
                                                  {t.title}
                                                </span>
                                                <span className="text-[10px] text-white/35 truncate block">
                                                  {t.artist}
                                                </span>
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    ) : null}
                                  </div>
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

          {/* Add artists — opens centered command menu (same flow as home search / expand) */}
          <div className="relative flex w-64 flex-col gap-2">
            <button
              type="button"
              onClick={() => setArtistPickerOpen(true)}
              className="relative flex w-full items-center justify-center rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,opacity] duration-200 active:scale-[0.98]"
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
              + add artist or album
            </button>
            <button
              type="button"
              disabled={!sessionUserId || omniLoading || !hasCheckedAlbum}
              onClick={() => void submitRecommended()}
              title="Mean embedding from tracks visible on the canvas (checked albums)."
              aria-label="get recommendations based on selected tracks"
              className="relative flex w-full items-center justify-center gap-0.5 rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,background,opacity,box-shadow] duration-200 active:scale-[0.98] disabled:opacity-50"
              style={{
                borderColor: "rgba(167, 139, 250, 0.45)",
                background:
                  "linear-gradient(180deg, rgb(52, 36, 88) 0%, rgb(42, 28, 72) 45%, rgb(58, 36, 98) 100%)",
                color: "rgba(255, 255, 255, 0.92)",
                boxShadow:
                  "0 2px 6px rgba(0,0,0,0.35), 0 0 0 1px rgba(139, 92, 246, 0.12) inset",
              }}
              onMouseEnter={(e) => {
                if (e.currentTarget.disabled) return;
                e.currentTarget.style.borderColor = "rgba(196, 181, 253, 0.7)";
                e.currentTarget.style.background =
                  "linear-gradient(180deg, rgb(62, 44, 102) 0%, rgb(50, 34, 86) 45%, rgb(68, 42, 112) 100%)";
                e.currentTarget.style.color = "rgb(255, 255, 255)";
                e.currentTarget.style.boxShadow =
                  "0 4px 14px rgba(88, 28, 135, 0.35), 0 0 0 1px rgba(167, 139, 250, 0.2) inset";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgba(167, 139, 250, 0.45)";
                e.currentTarget.style.background =
                  "linear-gradient(180deg, rgb(52, 36, 88) 0%, rgb(42, 28, 72) 45%, rgb(58, 36, 98) 100%)";
                e.currentTarget.style.color = "rgba(255, 255, 255, 0.92)";
                e.currentTarget.style.boxShadow =
                  "0 2px 6px rgba(0,0,0,0.35), 0 0 0 1px rgba(139, 92, 246, 0.12) inset";
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-[15px] shrink-0 -translate-y-px"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
                />
              </svg>
              {omniLoading ? (
                <span>generating…</span>
              ) : (
                <span>get recommendations</span>
              )}
            </button>
          </div>
        </div>

        <ArtistPickerCmdk
          open={artistPickerOpen}
          onOpenChange={setArtistPickerOpen}
          excludeGrandparentIds={addedGrandparentIds}
          userId={sessionUserId ?? null}
          onSuccess={() =>
            void queryClient.invalidateQueries({ queryKey: queryKeys.canvas })
          }
        />

        {/* Search-result tour + omnibox */}
        <div className="absolute bottom-6 left-1/2 z-10 flex w-[600px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-stretch gap-0 pointer-events-auto">
          <input
            ref={omniFileRef}
            type="file"
            accept="audio/*,video/*,image/*"
            className="hidden"
            onChange={(e) => setOmniFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-col items-center gap-0">
            {currentTrack && (
              <div className="w-[calc(100%-80px)] flex flex-col items-stretch">
                {searchTour && tourTrack ? (
                  <>
                    <div
                      className="relative flex h-7 items-center gap-1 px-1.5"
                      style={{
                        background: "rgb(14,14,18)",
                        border: "1px solid #000",
                        borderBottom: "1px solid #000",
                        borderRadius: "16px 16px 0 0",
                        fontFamily: "var(--font-nunito)",
                      }}
                    >
                      <span
                        className="h-6 w-6 shrink-0"
                        aria-hidden
                      />
                      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={tourPrev}
                          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/5 hover:text-white"
                          aria-label="Previous result"
                        >
                          <ChevronLeft size={14} strokeWidth={2} />
                        </button>
                        <span
                          className="min-w-[3.25rem] text-center text-[10px] font-medium tabular-nums"
                          style={{ color: "rgba(255,255,255,0.42)" }}
                        >
                          {tourWalkLabel}
                        </span>
                        <button
                          type="button"
                          onClick={tourNext}
                          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/5 hover:text-white"
                          aria-label="Next result"
                        >
                          <ChevronRight size={14} strokeWidth={2} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={endSearchTourAndClosePlayer}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/5 hover:text-white"
                        aria-label="Close tour"
                      >
                        <X size={13} strokeWidth={2} />
                      </button>
                    </div>
                    <div
                      className="px-4 pt-3 pb-3"
                      style={{
                        background: "rgb(14,14,18)",
                        border: "1px solid #000",
                        borderTop: "none",
                        borderBottom: "none",
                      }}
                    >
                      <Player
                        track={currentTrack}
                        embedded
                        onSearchSimilar={
                          currentTrack.isQuery
                            ? undefined
                            : submitSimilarFromTrack
                        }
                        similarBusy={omniLoading}
                      />
                    </div>
                  </>
                ) : (
                  <div
                    className="relative px-4 pt-3 pb-3"
                    style={{
                      background: "rgb(14,14,18)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderBottom: "none",
                      borderRadius: "16px 16px 0 0",
                    }}
                  >
                    <DockedPlayerCloseButton onClick={dismissPlayer} />
                    <Player
                      track={currentTrack}
                      embedded
                      onSearchSimilar={
                        currentTrack.isQuery
                          ? undefined
                          : submitSimilarFromTrack
                      }
                      similarBusy={omniLoading}
                    />
                  </div>
                )}
              </div>
            )}
            <div
              className="flex flex-col rounded-2xl cursor-text w-full"
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
                borderRadius: "16px",
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
                      : "describe a vibe, or attach audio, video, or an image. cmd+f to find songs in canvas"
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
          {/* end player+omnibox group */}
        </div>
      </div>

      {ctxMenu &&
        (() => {
          const isEntity = Boolean(ctxMenu.entityId);
          const gp = grandparents.find((g) => g.id === ctxMenu.groupId);
          const canDeleteGp =
            !isEntity && gp && !NON_DELETABLE_GRANDPARENT_TYPES.has(gp.type);
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setCtxMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu(null);
                }}
              />
              <div
                className="fixed z-50 rounded-xl overflow-hidden py-1 min-w-[148px]"
                style={{
                  left: ctxMenu.x,
                  top: ctxMenu.y,
                  background: "rgb(22,22,26)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  boxShadow: "0 8px 28px rgba(0,0,0,0.65)",
                  fontFamily: "var(--font-nunito)",
                }}
              >
                {isEntity && (
                  <button
                    type="button"
                    className="w-full text-left px-3.5 py-2 text-[12px] font-medium transition-colors hover:bg-red-500/10"
                    style={{ color: "rgba(239,68,68,0.85)" }}
                    onClick={() => {
                      deleteEntity(ctxMenu.entityId!);
                      setCtxMenu(null);
                    }}
                  >
                    Delete
                  </button>
                )}
                {canDeleteGp && (
                  <button
                    type="button"
                    className="w-full text-left px-3.5 py-2 text-[12px] font-medium transition-colors hover:bg-red-500/10"
                    style={{ color: "rgba(239,68,68,0.85)" }}
                    onClick={() => {
                      void deleteGrandparent(ctxMenu.groupId);
                      setCtxMenu(null);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </>
          );
        })()}

      {findOpen && (
        <div className="absolute top-3 left-3 z-20 pointer-events-auto">
          <div
            className="w-72 rounded-2xl px-3 py-2.5 flex items-center gap-2"
            style={{
              background: "rgb(14,14,18)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "rgba(0,0,0,0.4) 0px 4px 16px",
              fontFamily: "var(--font-nunito)",
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              style={{ flexShrink: 0, color: "rgba(255,255,255,0.3)" }}
            >
              <circle
                cx="11"
                cy="11"
                r="7"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M20 20l-3-3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={findInputRef}
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder="find in canvas…"
              className="flex-1 bg-transparent text-[13px] font-medium text-white placeholder-white/30 outline-none"
            />
            {findQuery.trim() && (
              <span
                className="text-[11px] font-medium tabular-nums flex-shrink-0"
                style={{ color: "rgba(255,255,255,0.35)" }}
              >
                {findMatchIndices.size}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setFindOpen(false);
                setFindQuery("");
              }}
              className="flex-shrink-0 text-white/30 hover:text-white/70 transition-colors text-base leading-none"
              aria-label="Close find"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
