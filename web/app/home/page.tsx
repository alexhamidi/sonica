"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "../components/Nav";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

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

const MAX_SELECTION = 5;

export default function Home() {
  const router = useRouter();
  const [inputValue, setInputValue] = useState("");
  const [resolvedData, setResolvedData] = useState<ResolvedData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [trail, setTrail] = useState<TrailCover[]>([]);
  const trailIdRef = useRef(0);
  const lastSpawnRef = useRef({ x: -999, y: -999 });
  const overContentRef = useRef(false);

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

  useEffect(() => {
    if (!inputValue) {
      setResolvedData(null);
      setSelected(new Set());
      setResolving(false);
      return;
    }
    setResolvedData(null);
    setSelected(new Set());
    setResolving(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API}/api/resolve?url=${encodeURIComponent(inputValue)}`,
        );
        if (!res.ok) throw new Error();
        const data: ResolvedData = await res.json();
        setResolvedData(data);
        if (data.entities.length === 1) {
          setSelected(new Set([data.entities[0].url]));
        }
      } catch {
        setResolvedData(null);
      } finally {
        setResolving(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const toggleEntity = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else if (next.size < MAX_SELECTION) {
        next.add(url);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!inputValue && !resolvedData) {
      router.push("/explore");
      return;
    }
    if (!resolvedData || selected.size === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const parentUrls = Array.from(selected);
      const body: Record<string, unknown> = { parentUrls };
      if (resolvedData.type === "artist" || resolvedData.type === "user") {
        body.grandparentUrl = inputValue;
      }
      const res = await fetch("/api/me/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        router.push("/canvas");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      router.push("/canvas");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  };

  const showEntities = !!resolvedData && resolvedData.entities.length > 0;
  const isWaiting = !!inputValue && !resolvedData;
  const canSubmit =
    !submitting && !isWaiting && (!resolvedData || selected.size > 0);

  const buttonLabel = submitting
    ? "adding..."
    : !canSubmit
      ? ""
      : resolvedData
        ? `add ${resolvedData.name}'s songs`
        : "explore artists";

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden text-white"
      style={{ backgroundColor: "rgba(14, 14, 17, 0.85)" }}
      onMouseMove={onMouseMove}
    >
      <div
        className="absolute top-3 left-3 z-20 pointer-events-auto"
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
            musmap is a way to explore the audio features of your favorite
            songs, artists, and albums. it embeds each track using
            gemini-embedding-002, then projects them into 2-dimensional space so
            you can visualize it.
          </p>
          <p>
            other than being fun to explore, musmap can be used to find similar
            songs to your favorites and identify outliers in your playlists.
          </p>
          <p>
            to get started, choose some artists you&apos;d like in your
            embedding space. you can always add more later.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateRows: showEntities ? "1fr" : "0fr",
            transition: "grid-template-rows 0.3s cubic-bezier(0.4,0,0.2,1)",
          }}
        >
          <div className="overflow-hidden">
            <div
              className="flex flex-col mt-0.5 max-h-48 overflow-y-auto scrollbar-hide"
              style={{ scrollbarWidth: "none" }}
            >
              {resolvedData?.entities.map((entity) => {
                const isSelected = selected.has(entity.url);
                const isDisabled =
                  !isSelected && selected.size >= MAX_SELECTION;
                return (
                  <button
                    key={entity.url}
                    onClick={() => toggleEntity(entity.url)}
                    disabled={isDisabled}
                    className="flex items-center gap-3 py-1.5 px-3 text-left w-full rounded-lg transition-colors hover:bg-white/[0.04] outline-none focus:outline-none"
                    style={{ opacity: isDisabled ? 0.35 : 1 }}
                  >
                    <div className="relative flex-shrink-0 w-8 h-8 rounded-md overflow-hidden bg-zinc-800">
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
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate text-white">
                        {entity.name}
                      </p>
                    </div>
                    <span
                      className="flex-shrink-0 flex items-center justify-center rounded-sm transition-all"
                      style={{
                        width: 15,
                        height: 15,
                        border: isSelected
                          ? "none"
                          : "1.5px solid rgba(255,255,255,0.2)",
                        background: isSelected ? "white" : "transparent",
                      }}
                    >
                      {isSelected && (
                        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
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

        <div className="flex flex-col gap-2.5">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) handleSubmit();
            }}
            placeholder="paste spotify Profile URL here"
            className="w-full rounded-[10px] px-3.5 py-2.5 text-[13px] text-white outline-none transition-colors"
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
          {error && (
            <p className="text-xs" style={{ color: "rgb(248, 113, 113)" }}>
              {error}
            </p>
          )}
          <button
            onClick={handleSubmit}
            type="button"
            disabled={!canSubmit}
            className="relative flex w-full items-center justify-center rounded-[10px] border px-4 py-3 text-sm font-medium leading-none transition-[color,border-color,background-image,opacity] duration-200 active:scale-[0.98] disabled:cursor-not-allowed min-h-[44px]"
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
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
