"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LandingSearchDemo } from "./components/LandingSearchDemo";
import { Nav } from "./components/Nav";
import { authClient } from "@/lib/auth/client";
import {
  markExpectCanvasAfterOAuth,
  peekExpectCanvasAfterOAuth,
  postSignInCanvasUrl,
} from "@/lib/auth/post-sign-in-url";
import { formatAddPeople } from "@/lib/format-add-people";
import {
  peekPendingAddBulk,
  setPendingAddBulk,
} from "@/lib/onboarding/pending-add-bulk";
import { publicMusApiUrl } from "@/lib/mus/public";
import { toast } from "sonner";

const ALBUM_COVERS = [
  "001_SZA_SOS.png",
  "003_SZA_SOS Deluxe: LANA.png",
  "004_SZA_Good Days.png",
  "005_Usher_Confessions (Expanded Edition).png",
  "006_Usher_Raymond v Raymond (Expanded Edition).png",
  "007_Usher_8701.png",
  "008_Usher_Confessions.png",
  "009_Fall Out Boy_From Under the Cork Tree.png",
  "010_Fall Out Boy_Infinity on High.png",
  "011_Fall Out Boy_American Beauty_American Psycho.png",
  "012_Fall Out Boy_Save Rock and Roll.png",
  "013_Amy Winehouse_Back to Black.png",
  "014_Amy Winehouse_Back to Black (Deluxe Edition).png",
  "015_Amy Winehouse_Frank.png",
  "016_Amy Winehouse_Lioness: Hidden Treasures.png",
  "017_Skrillex_Bangarang EP.png",
  "018_Skrillex_More Monsters and Sprites EP.png",
  "019_Skrillex_Scary Monsters And Nice Sprites EP.png",
  "020_Skrillex_Quest for Fire.png",
  "021_Miguel_All I Want Is You.png",
  "022_Miguel_War & Leisure.png",
  "023_Miguel_Kaleidoscope Dream.png",
  "024_Miguel_Rogue Waves.png",
  "025_Daniel Caesar_Freudian.png",
  "026_Daniel Caesar_NEVER ENOUGH.png",
  "027_Daniel Caesar_Get You - Single.png",
  "028_Daniel Caesar_CASE STUDY 01.png",
  "029_Kygo_Cloud Nine.png",
  "030_Kygo_Golden Hour.png",
  "031_Kygo_Firestone.png",
  "032_Guns N Roses_Appetite for Destruction.png",
  "033_Guns N Roses_Use Your Illusion I.png",
  "034_Guns N Roses_Use Your Illusion II.png",
  "035_Guns N Roses_Greatest Hits.png",
  "036_Taylor Swift_Lover.png",
  "037_Taylor Swift_reputation.png",
  "038_Taylor Swift_folklore.png",
  "039_Taylor Swift_1989.png",
  "040_Rauw Alejandro_Cosa Nuestra.png",
  "041_Rauw Alejandro_VICE VERSA.png",
  "042_Rauw Alejandro_Playa Saturno.png",
  "043_Zedd_Clarity.png",
  "044_Zedd_The Middle.png",
  "045_Zedd_Stay.png",
  "046_Zedd_True Colors.png",
  "047_Deadmau5_For Lack of a Better Name.png",
  "048_Deadmau5_4x4=12.png",
  "049_Deadmau5_Strobe.png",
  "050_Deadmau5_> album title goes here <.png",
  "051_Kesha_Animal.png",
  "052_Kesha_TiK ToK.png",
  "053_Kesha_Cannibal.png",
  "054_Kesha_Warrior (Deluxe Version).png",
  "055_Playboi Carti_Whole Lotta Red.png",
  "056_Playboi Carti_Playboi Carti.png",
  "057_Playboi Carti_Die Lit.png",
  "058_Playboi Carti_Music.png",
  "059_Ed Sheeran_÷ (Deluxe).png",
  "060_Ed Sheeran_x (Deluxe Edition).png",
  "061_Ed Sheeran_+.png",
  "062_Ed Sheeran_No.6 Collaborations Project.png",
  "063_Britney Spears_In the Zone.png",
  "064_Britney Spears_Blackout.png",
  "065_Britney Spears_Circus (Deluxe Version).png",
  "066_Britney Spears_...Baby One More Time (Digital Deluxe Version).png",
  "067_Travis Scott_Rodeo (Deluxe).png",
  "068_Travis Scott_Days Before Rodeo.png",
  "069_Travis Scott_Antidote.png",
  "070_Travis Scott_Birds in the Trap Sing McKnight.png",
  "071_Eminem_The Eminem Show.png",
  "072_Eminem_Recovery.png",
  "073_Eminem_The Marshall Mathers LP.png",
  "074_Eminem_The Slim Shady LP.png",
  "075_Warpaint_The Fool.png",
  "076_Warpaint_Warpaint.png",
  "077_Warpaint_Exquisite Corpse.png",
  "078_Warpaint_Heads Up.png",
  "079_The National_Boxer.png",
  "080_The National_Trouble Will Find Me.png",
  "081_The National_High Violet.png",
  "082_The National_Sad Songs for Dirty Lovers.png",
  "083_Bruno Mars_Doo-Wops & Hooligans.png",
  "084_Bruno Mars_Unorthodox Jukebox.png",
  "085_Bruno Mars_24K Magic.png",
  "086_Bruno Mars_An Evening with Silk Sonic.png",
  "087_Alicia Keys_The Diary of Alicia Keys.png",
  "088_Alicia Keys_Songs in A Minor.png",
  "089_Alicia Keys_The Element of Freedom.png",
  "090_Alicia Keys_As I Am.png",
  "091_Beyoncé_I AM...SASHA FIERCE.png",
  "092_Beyoncé_Dangerously in Love.png",
  "093_Beyoncé_4.png",
  "094_Beyoncé_BEYONCÉ [Platinum Edition].png",
  "095_Sturgill Simpson_Metamodern Sounds in Country Music.png",
  "096_Sturgill Simpson_A Sailor's Guide to Earth.png",
  "097_Sturgill Simpson_The Ballad of Dood & Juanita.png",
  "098_Sturgill Simpson_High Top Mountain.png",
  "099_Lorde_Pure Heroine.png",
  "100_Lorde_Melodrama.png",
];

type TrailCover = {
  id: number;
  x: number;
  y: number;
  src: string;
  rotation: number;
  size: number;
};

interface HomeArtist {
  id: string;
  name: string;
  cover: string | null;
  skeleton?: boolean;
}

function skeletonIds(parentId: string) {
  return [0, 1, 2].map((i) => `__sk__${parentId}__${i}`);
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  cover: string | null;
}

interface ResolvedEntity {
  name: string;
  cover: string | null;
  trackCount: number;
  url: string;
}

interface ResolvedData {
  name: string;
  type: string;
  entities: ResolvedEntity[];
}

const MAX_SEARCH_EXPAND = 5;
/** Quick start: API returns up to 10; user can select at most 5. */
const MAX_QUICKSTART_SELECT = 5;

type HomeMode = "quickstart" | "search";

function isProfileUrl(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t.includes("open.spotify.com") && t.includes("/user/");
}

export default function Home() {
  const router = useRouter();
  const session = authClient.useSession();

  const [mode, setMode] = useState<HomeMode>("quickstart");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [resolvedData, setResolvedData] = useState<ResolvedData | null>(null);
  const [profileResolving, setProfileResolving] = useState(false);
  const [artists, setArtists] = useState<HomeArtist[]>([]);
  const [artistsLoading, setArtistsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [trail, setTrail] = useState<TrailCover[]>([]);
  const trailIdRef = useRef(0);
  const lastSpawnRef = useRef({ x: -999, y: -999 });
  const overContentRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /** OAuth sometimes lands on `/` despite callbackURL; finish onboarding on canvas. */
  useEffect(() => {
    if (session.isPending) return;
    if (!session.data?.user) return;
    if (!peekPendingAddBulk() && !peekExpectCanvasAfterOAuth()) return;
    router.replace("/canvas");
  }, [session.isPending, session.data?.user, router]);

  useEffect(() => {
    if (mode === "quickstart") {
      setArtistsLoading(false);
      return;
    }
    let cancelled = false;
    setArtistsLoading(true);
    const q = debouncedSearch.trim();
    const base = publicMusApiUrl();
    const url =
      mode === "search" && q
        ? `${base}/api/artists?q=${encodeURIComponent(q)}&limit=40`
        : `${base}/api/artists?limit=15`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { artists?: EntityRow[] }) => {
        if (cancelled) return;
        let rows = d.artists ?? [];
        if (mode === "search" && !q) {
          rows = rows.slice(0, 5);
        }
        setArtists(
          rows.map((e) => ({ id: e.id, name: e.name, cover: e.cover })),
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setArtists([]);
          toast.error("Couldn't load artists", {
            description:
              err instanceof Error ? err.message : "Network or server error",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setArtistsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, debouncedSearch]);

  useEffect(() => {
    setSelected(new Set());
    setError("");
    if (mode === "quickstart") {
      setArtists([]);
      setArtistsLoading(false);
    } else {
      setProfileUrl("");
      setResolvedData(null);
      setProfileResolving(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "quickstart") return;
    if (!profileUrl.trim()) {
      setResolvedData(null);
      setSelected(new Set());
      setProfileResolving(false);
      setError("");
      return;
    }
    if (!isProfileUrl(profileUrl)) {
      setResolvedData(null);
      setSelected(new Set());
      setProfileResolving(false);
      setError("");
      return;
    }

    setResolvedData(null);
    setSelected(new Set());
    setProfileResolving(true);
    setError("");

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${publicMusApiUrl()}/api/resolve?url=${encodeURIComponent(profileUrl.trim())}`,
        );
        const raw = await res.text();
        let data: ResolvedData & { detail?: unknown };
        try {
          data = JSON.parse(raw) as ResolvedData & { detail?: unknown };
        } catch {
          throw new Error(raw || "Invalid response");
        }
        if (!res.ok) {
          const d = data.detail;
          const msg =
            typeof d === "string"
              ? d
              : d != null
                ? JSON.stringify(d)
                : res.statusText;
          throw new Error(msg);
        }
        setResolvedData(data);
        setSelected(
          new Set(
            data.entities.slice(0, MAX_QUICKSTART_SELECT).map((e) => e.url),
          ),
        );
      } catch (e) {
        setResolvedData(null);
        setSelected(new Set());
        setError(
          e instanceof Error ? e.message : "Could not load that profile",
        );
      } finally {
        setProfileResolving(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [mode, profileUrl]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (overContentRef.current) return;
    const dx = e.clientX - lastSpawnRef.current.x;
    const dy = e.clientY - lastSpawnRef.current.y;
    if (Math.hypot(dx, dy) < 90) return;
    lastSpawnRef.current = { x: e.clientX, y: e.clientY };
    const src = ALBUM_COVERS[Math.floor(Math.random() * ALBUM_COVERS.length)];
    const id = trailIdRef.current++;
    setTrail((t) => [
      ...t,
      {
        id,
        x: e.clientX,
        y: e.clientY,
        src,
        rotation: (Math.random() - 0.5) * 24,
        size: 64 + Math.random() * 32,
      },
    ]);
    setTimeout(() => setTrail((t) => t.filter((c) => c.id !== id)), 2200);
  }, []);

  const expandSimilar = async (clickedId: string) => {
    if (artists.some((a) => a.id.startsWith(`__sk__${clickedId}__`))) return;

    const exclude = artists
      .filter((a) => !a.skeleton)
      .map((a) => a.id)
      .join(",");

    const skRows: HomeArtist[] = skeletonIds(clickedId).map((id) => ({
      id,
      name: "",
      cover: null,
      skeleton: true,
    }));

    setArtists((prev) => {
      const idx = prev.findIndex((a) => a.id === clickedId);
      if (idx === -1) return prev;
      return [...prev.slice(0, idx + 1), ...skRows, ...prev.slice(idx + 1)];
    });

    try {
      const res = await fetch(
        `${publicMusApiUrl()}/api/artist-neighbors?grandparentId=${encodeURIComponent(clickedId)}&exclude=${encodeURIComponent(exclude)}&pool=10&k=3`,
      );
      if (!res.ok) throw new Error();
      const d: { artists?: HomeArtist[] } = await res.json();
      const neighbors = d.artists ?? [];
      setArtists((prev) => {
        const stripped = prev.filter(
          (a) => !a.id.startsWith(`__sk__${clickedId}__`),
        );
        const idx = stripped.findIndex((a) => a.id === clickedId);
        if (idx === -1) return stripped;
        const seen = new Set(stripped.map((a) => a.id));
        const toAdd = neighbors.filter((a) => !seen.has(a.id));
        return [
          ...stripped.slice(0, idx + 1),
          ...toAdd,
          ...stripped.slice(idx + 1),
        ];
      });
    } catch {
      setArtists((prev) =>
        prev.filter((a) => !a.id.startsWith(`__sk__${clickedId}__`)),
      );
    }
  };

  const toggleProfileEntity = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < MAX_QUICKSTART_SELECT) next.add(url);
      return next;
    });
  };

  const onArtistRowClick = (artist: HomeArtist) => {
    if (artist.skeleton) return;

    if (mode === "search") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(artist.id)) next.delete(artist.id);
        else if (next.size < MAX_SEARCH_EXPAND) next.add(artist.id);
        return next;
      });
      return;
    }

    if (selected.has(artist.id)) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(artist.id);
        return next;
      });
      return;
    }

    if (selected.size >= MAX_SEARCH_EXPAND) return;

    setSelected((prev) => {
      const next = new Set(prev);
      next.add(artist.id);
      return next;
    });
    void expandSimilar(artist.id);
  };

  const handleSubmit = async () => {
    if (selected.size === 0) {
      setError("");
      if (!session.data?.user) {
        markExpectCanvasAfterOAuth();
        void authClient.signIn.social({
          provider: "google",
          callbackURL: postSignInCanvasUrl(),
        });
        return;
      }
      router.push("/canvas");
      return;
    }
    const grandparentIds = Array.from(selected);
    if (!session.data?.user) {
      setError("");
      setPendingAddBulk(grandparentIds);
      markExpectCanvasAfterOAuth();
      void authClient.signIn.social({
        provider: "google",
        callbackURL: postSignInCanvasUrl(),
      });
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/me/add-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grandparentIds }),
      });
      if (res.status === 401) {
        setPendingAddBulk(grandparentIds);
        markExpectCanvasAfterOAuth();
        void authClient.signIn.social({
          provider: "google",
          callbackURL: postSignInCanvasUrl(),
        });
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      router.push("/canvas");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  };

  const showProfileEntities =
    mode === "quickstart" && !!resolvedData && resolvedData.entities.length > 0;
  const profileWaiting =
    mode === "quickstart" &&
    !!profileUrl.trim() &&
    isProfileUrl(profileUrl) &&
    profileResolving;

  const listLoading = mode !== "quickstart" && artistsLoading;

  const canSubmit =
    !submitting && !profileWaiting && !listLoading;

  const addButtonLabel = useMemo(() => {
    if (submitting) return "adding...";
    if (profileWaiting) return "loading...";
    if (listLoading && selected.size === 0) return "loading...";
    if (selected.size === 0) return "continue (no artists)";
    if (mode === "quickstart" && resolvedData) {
      return `add ${resolvedData.name}'s picks`;
    }
    const names = Array.from(selected)
      .map((id) => artists.find((a) => a.id === id && !a.skeleton)?.name)
      .filter((n): n is string => Boolean(n && n.trim()));
    if (names.length === 0) return `Add ${selected.size} artists`;
    return formatAddPeople(names);
  }, [submitting, profileWaiting, listLoading, selected, artists, mode, resolvedData]);

  if (session.isPending) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden text-white"
      style={{ backgroundColor: "rgba(14, 14, 17, 0.85)" }}
      onMouseMove={onMouseMove}
    >
      <div
        className="absolute top-3 left-3 right-3 z-20 pointer-events-auto"
        onMouseEnter={() => {
          overContentRef.current = true;
        }}
        onMouseLeave={() => {
          overContentRef.current = false;
        }}
      >
        <Nav />
      </div>

      {trail.map((cover) => (
        <img
          key={cover.id}
          src={`/album_covers/${encodeURIComponent(cover.src)}`}
          alt=""
          className="pointer-events-none absolute rounded-lg"
          style={{
            left: cover.x,
            top: cover.y,
            width: cover.size,
            height: cover.size,
            marginLeft: -cover.size / 2,
            marginTop: -cover.size / 2,
            objectFit: "cover",
            ["--r" as string]: `${cover.rotation}deg`,
            animation: "cover-trail 2.2s ease forwards",
            zIndex: 0,
          }}
        />
      ))}

      <div
        className="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-2xl p-6"
        onMouseEnter={() => {
          overContentRef.current = true;
        }}
        onMouseLeave={() => {
          overContentRef.current = false;
        }}
      >
        <div className="flex flex-col gap-3 text-[13px] leading-[1.5] text-white/75 select-none">
          <p>
            google recently released {" "}
            <a
              href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-embedding-2/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/80 underline underline-offset-2 decoration-white/50 hover:text-white"
            >
              a model
            </a>{" "}
            cap’ble of embedding audio, video, text, and images.             sonica allows you to visualize and search across a library of more than 100k songs in this shared
            space, so you can do things like:

          </p>
          <LandingSearchDemo />
          <p>start by choosing up to 5 artists to populate your canvas</p>
          <p>
            <button
              type="button"
              onClick={() => setMode("quickstart")}
              className={`inline p-0 border-0 bg-transparent font-inherit cursor-pointer ${
                mode === "quickstart"
                  ? "text-white/75 underline underline-offset-2 decoration-white/70"
                  : "text-white/75 hover:text-white/90"
              }`}
            >
              quick start
            </button>
            {" · "}
            <button
              type="button"
              onClick={() => setMode("search")}
              className={`inline p-0 border-0 bg-transparent font-inherit cursor-pointer ${
                mode === "search"
                  ? "text-white/75 underline underline-offset-2 decoration-white/70"
                  : "text-white/75 hover:text-white/90"
              }`}
            >
              search
            </button>
          </p>
        </div>

        {mode === "search" && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search artists…"
            autoComplete="off"
            className="w-full rounded-[10px] px-3.5 py-2.5 text-[13px] text-white placeholder-white/30 outline-none transition-colors"
            style={{
              backgroundColor: "rgb(28, 28, 32)",
              border: "1px solid rgb(48, 48, 50)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.5)";
              e.currentTarget.style.backgroundColor = "rgb(22, 22, 26)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "rgb(48, 48, 50)";
              e.currentTarget.style.backgroundColor = "rgb(28, 28, 32)";
            }}
          />
        )}

        {mode === "quickstart" && (
          <input
            type="text"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="Your Spotify profile URL"
            autoComplete="off"
            className="w-full rounded-[10px] px-3.5 py-2.5 text-[13px] text-white placeholder-white/30 outline-none transition-colors"
            style={{
              backgroundColor: "rgb(28, 28, 32)",
              border: "1px solid rgb(48, 48, 50)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "rgba(99, 102, 241, 0.5)";
              e.currentTarget.style.backgroundColor = "rgb(22, 22, 26)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "rgb(48, 48, 50)";
              e.currentTarget.style.backgroundColor = "rgb(28, 28, 32)";
            }}
          />
        )}

        <div
          style={{
            display:
              mode === "quickstart" && !showProfileEntities ? "none" : "grid",
            gridTemplateRows: "1fr",
            transition: "grid-template-rows 0.3s cubic-bezier(0.4,0,0.2,1)",
          }}
        >
          <div className="overflow-hidden">
            <div
              className="flex flex-col mt-0.5 max-h-[min(14rem,50vh)] overflow-y-auto scrollbar-hide"
              style={{ scrollbarWidth: "none" }}
            >
              {mode === "quickstart" &&
                resolvedData?.entities.map((entity) => {
                  const isSelected = selected.has(entity.url);
                  const isDisabled =
                    !isSelected && selected.size >= MAX_QUICKSTART_SELECT;
                  return (
                    <button
                      key={entity.url}
                      type="button"
                      onClick={() => toggleProfileEntity(entity.url)}
                      disabled={isDisabled}
                      className="flex w-full items-center gap-3 py-1.5 px-2 rounded-lg text-left transition-colors hover:bg-white/[0.04] outline-none focus:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                      style={{ opacity: isDisabled ? 0.35 : 1 }}
                    >
                      <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-md bg-zinc-800">
                        {entity.cover && (
                          <Image
                            src={entity.cover}
                            alt=""
                            fill
                            sizes="32px"
                            className="object-cover"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-white">
                          {entity.name}
                        </p>
                      </div>
                      <span
                        className="flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-sm transition-all pointer-events-none"
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

              {mode !== "quickstart" &&
                artistsLoading &&
                Array.from({ length: 5 }, (_, i) => (
                  <div
                    key={`__loading__${i}`}
                    className="flex items-center gap-3 rounded-lg py-1.5 px-2"
                    aria-hidden
                  >
                    <div className="h-8 w-8 flex-shrink-0 animate-pulse rounded-md bg-white/[0.08]" />
                    <div className="h-3.5 max-w-[70%] flex-1 animate-pulse rounded bg-white/[0.08]" />
                    <div className="h-[15px] w-[15px] flex-shrink-0" />
                  </div>
                ))}

              {mode !== "quickstart" &&
                !artistsLoading &&
                artists.length === 0 && (
                  <p className="px-3 py-2 text-xs text-white/45">
                    {mode === "search" && debouncedSearch.trim()
                      ? "no artists match your search."
                      : "couldn't load artists. try again later."}
                  </p>
                )}

              {mode !== "quickstart" &&
                !artistsLoading &&
                artists.map((artist, rowIndex) => {
                  const isSelected = selected.has(artist.id);
                  const rowDimmed =
                    !isSelected && selected.size >= MAX_SEARCH_EXPAND;
                  if (artist.skeleton) {
                    return (
                      <div
                        key={`${artist.id}:${rowIndex}`}
                        className="flex items-center gap-3 rounded-lg py-1.5 px-2"
                      >
                        <div className="h-8 w-8 flex-shrink-0 animate-pulse rounded-md bg-white/[0.08]" />
                        <div className="h-3.5 max-w-[70%] flex-1 animate-pulse rounded bg-white/[0.08]" />
                        <div
                          className="h-[15px] w-[15px] flex-shrink-0"
                          aria-hidden
                        />
                      </div>
                    );
                  }
                  return (
                    <button
                      key={`${artist.id}:${rowIndex}`}
                      type="button"
                      onClick={() => onArtistRowClick(artist)}
                      className="flex w-full items-center gap-3 rounded-lg py-1.5 px-2 text-left transition-colors outline-none hover:bg-white/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
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
                        className="flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-sm transition-all pointer-events-none"
                        style={{
                          width: 15,
                          height: 15,
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
          </div>
        </div>

        {mode === "quickstart" &&
          !showProfileEntities &&
          !profileWaiting &&
          profileUrl.trim() &&
          isProfileUrl(profileUrl) &&
          error && (
            <p className="text-xs" style={{ color: "rgb(248, 113, 113)" }}>
              {error}
            </p>
          )}
        <div className="flex flex-col gap-2.5">
          {mode !== "quickstart" && error && (
            <p className="text-xs" style={{ color: "rgb(248, 113, 113)" }}>
              {error}
            </p>
          )}
          {mode === "quickstart" && error && showProfileEntities && (
            <p className="text-xs" style={{ color: "rgb(248, 113, 113)" }}>
              {error}
            </p>
          )}
          <button
            onClick={() => void handleSubmit()}
            type="button"
            disabled={!canSubmit}
            className="relative flex min-h-[44px] w-full items-center justify-center rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,background-image,opacity] duration-200 active:scale-[0.98] disabled:cursor-not-allowed"
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
            {addButtonLabel}
          </button>
        </div>
      </div>

      <a
        href="https://twitter.com/ahamidi_"
        target="_blank"
        rel="noopener noreferrer"
        className="pointer-events-auto absolute bottom-4 right-4 z-20 text-[11px] text-white/45 underline decoration-white/25 underline-offset-2 transition-colors hover:text-white/75 hover:decoration-white/45"
      >
        created by alex hamidi
      </a>
    </div>
  );
}
