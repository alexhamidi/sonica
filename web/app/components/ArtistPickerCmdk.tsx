"use client";

import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { formatAddPeople } from "@/lib/format-add-people";
import { publicMusApiUrl } from "@/lib/mus/public";
import { queryKeys } from "@/lib/query/keys";
import { toast } from "sonner";

const MAX_SELECT = 5;

interface EntityRow {
  id: string;
  name: string;
  type: string;
  cover: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
  cover: string | null;
}

const EMPTY_ARTISTS: ArtistRow[] = [];

export interface ArtistPickerCmdkProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Grandparent IDs already on the canvas (hidden from list). */
  excludeGrandparentIds: Set<string>;
  /** Logged-in user: empty-query list uses embedding-based suggestions from their artists. */
  userId?: string | null;
  onSuccess?: () => void;
}

export function ArtistPickerCmdk({
  open,
  onOpenChange,
  excludeGrandparentIds,
  userId = null,
  onSuccess,
}: ArtistPickerCmdkProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeGrandparentIdsRef = useRef(excludeGrandparentIds);
  excludeGrandparentIdsRef.current = excludeGrandparentIds;

  const excludeKey = useMemo(
    () => Array.from(excludeGrandparentIds).sort().join(),
    [excludeGrandparentIds],
  );

  const artistsQuery = useQuery({
    queryKey: [...queryKeys.artistsPicker(debouncedSearch, userId), excludeKey],
    enabled: open,
    queryFn: async () => {
      const base = publicMusApiUrl();
      const q = debouncedSearch.trim();
      const url =
        q.length > 0
          ? `${base}/api/artists?q=${encodeURIComponent(q)}&limit=40`
          : userId
            ? `${base}/api/artists/suggested?userId=${encodeURIComponent(userId)}&limit=10`
            : `${base}/api/artists?limit=15`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.statusText || String(r.status));
      const d = (await r.json()) as {
        artists?: EntityRow[];
        personalized?: boolean;
      };
      const exclude = excludeGrandparentIdsRef.current;
      let rows = d.artists ?? [];
      rows = rows.filter((e) => !exclude.has(e.id));
      if (!q) rows = rows.slice(0, 10);
      const artists: ArtistRow[] = rows.map((e) => ({
        id: e.id,
        name: e.name,
        cover: e.cover,
      }));
      const personalized = !q && Boolean(userId) && d.personalized === true;
      return { artists, personalized };
    },
  });

  const artists = useMemo(
    () => artistsQuery.data?.artists ?? EMPTY_ARTISTS,
    [artistsQuery.data],
  );
  const artistsLoading = artistsQuery.isFetching;
  const suggestionsPersonalized = artistsQuery.data?.personalized ?? false;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setDebouncedSearch("");
      setSelected(new Set());
      setError("");
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const artistsErrorToastShown = useRef(false);
  useEffect(() => {
    if (!open) {
      artistsErrorToastShown.current = false;
      return;
    }
    if (!artistsQuery.isError || !artistsQuery.error) return;
    if (artistsErrorToastShown.current) return;
    artistsErrorToastShown.current = true;
    toast.error("Couldn't load artists", {
      description:
        artistsQuery.error instanceof Error
          ? artistsQuery.error.message
          : "Network or server error",
    });
  }, [open, artistsQuery.isError, artistsQuery.error]);

  const toggleArtist = useCallback((artist: ArtistRow) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(artist.id)) next.delete(artist.id);
      else if (next.size < MAX_SELECT) next.add(artist.id);
      return next;
    });
  }, []);

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/me/add-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grandparentIds: Array.from(selected) }),
      });
      if (res.status === 401) {
        router.push("/canvas");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = selected.size > 0 && !submitting && !artistsLoading;

  const addButtonLabel = useMemo(() => {
    if (submitting) return "adding…";
    if (selected.size === 0) return "";
    const names = Array.from(selected)
      .map((id) => artists.find((a) => a.id === id)?.name)
      .filter((n): n is string => Boolean(n && n.trim()));
    if (names.length === 0) return `Add ${selected.size} artists`;
    return formatAddPeople(names);
  }, [submitting, selected, artists]);

  const fadeMs = 0.14;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="artist-picker"
          className="fixed inset-0 z-[100] flex items-center justify-center p-6"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: fadeMs, ease: "easeOut" }}
        >
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              backgroundColor: "rgba(0, 0, 0, 0.72)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
            onMouseDown={() => onOpenChange(false)}
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search artists to add"
            className="relative z-[1] flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-white/[0.08] p-5 outline-none shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
            style={{ backgroundColor: "rgb(10, 10, 12)" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search artists…"
              autoComplete="off"
              className="w-full bg-transparent py-0.5 text-[13px] text-white placeholder:text-white/32 outline-none"
            />
            {!debouncedSearch.trim() && suggestionsPersonalized ? (
              <p className="-mt-2 text-[10px] leading-tight text-white/38">
                Suggested from your artists
              </p>
            ) : null}

            <div
              className="max-h-[min(14rem,50vh)] overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ marginLeft: "-0.25rem", marginRight: "-0.25rem" }}
            >
              {artistsLoading &&
                Array.from({ length: 10 }, (_, i) => (
                  <div
                    key={`__loading__${i}`}
                    className="flex items-center gap-3 rounded-lg py-1.5 px-2"
                    aria-hidden
                  >
                    <div className="h-8 w-8 flex-shrink-0 animate-pulse rounded-md bg-white/[0.06]" />
                    <div className="h-3.5 max-w-[70%] flex-1 animate-pulse rounded bg-white/[0.06]" />
                    <div className="h-[15px] w-[15px] flex-shrink-0" />
                  </div>
                ))}

              {!artistsLoading && artists.length === 0 && (
                <p className="px-2 py-3 text-xs text-white/40">
                  {debouncedSearch.trim()
                    ? "no artists match your search."
                    : "nothing to show yet — try typing a name."}
                </p>
              )}

              {!artistsLoading &&
                artists.map((artist) => {
                  const isSelected = selected.has(artist.id);
                  const rowDimmed = !isSelected && selected.size >= MAX_SELECT;
                  return (
                    <button
                      key={artist.id}
                      type="button"
                      onClick={() => toggleArtist(artist)}
                      className="flex w-full items-center gap-3 rounded-lg py-1.5 px-2 text-left transition-colors outline-none hover:bg-white/[0.035] focus:outline-none"
                      style={{ opacity: rowDimmed ? 0.35 : 1 }}
                      aria-pressed={isSelected}
                    >
                      <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-md bg-zinc-800">
                        {artist.cover && (
                          <Image
                            src={artist.cover}
                            alt=""
                            fill
                            sizes="32px"
                            className="object-cover"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-white">
                          {artist.name}
                        </p>
                      </div>
                      <span
                        className="pointer-events-none flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-sm transition-all"
                        style={{
                          border: isSelected
                            ? "none"
                            : "1.5px solid rgba(255,255,255,0.2)",
                          background: isSelected ? "white" : "transparent",
                        }}
                        aria-hidden
                      >
                        {isSelected && (
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
                })}
            </div>

            {error ? (
              <p className="text-xs" style={{ color: "rgb(248, 113, 113)" }}>
                {error}
              </p>
            ) : null}

            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="relative flex min-h-[44px] w-full items-center justify-center rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,background-image,opacity,transform] duration-200 active:scale-[0.98] disabled:cursor-not-allowed"
              style={{
                borderColor: "rgb(60, 62, 80)",
                backgroundImage:
                  "linear-gradient(rgb(30, 31, 48) 0%, rgb(24, 25, 40) 50%, color-mix(in oklch, rgb(99, 102, 241) 12%, rgb(20, 20, 30)) 100%)",
                color: "rgba(255, 255, 255, 0.75)",
                boxShadow: "rgba(0,0,0,0.3) 0px 2px 4px",
                opacity: canSubmit ? 1 : 0.4,
              }}
              onMouseEnter={(e) => {
                if (!canSubmit) return;
                e.currentTarget.style.borderColor = "rgb(80, 84, 110)";
                e.currentTarget.style.backgroundImage =
                  "linear-gradient(rgb(38, 40, 62) 0%, rgb(32, 33, 54) 50%, color-mix(in oklch, rgb(99, 102, 241) 22%, rgb(26, 26, 40)) 100%)";
                e.currentTarget.style.color = "rgba(255, 255, 255, 0.95)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgb(60, 62, 80)";
                e.currentTarget.style.backgroundImage =
                  "linear-gradient(rgb(30, 31, 48) 0%, rgb(24, 25, 40) 50%, color-mix(in oklch, rgb(99, 102, 241) 12%, rgb(20, 20, 30)) 100%)";
                e.currentTarget.style.color = "rgba(255, 255, 255, 0.75)";
              }}
            >
              {addButtonLabel || "Select artists"}
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
