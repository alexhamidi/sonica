"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "../components/Nav";
import { Plus, Check } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

interface ChildEntity {
  id: string;
  name: string;
  type: string;
  cover: string | null;
}

interface ParentEntity {
  id: string;
  name: string;
  type: string;
  cover: string | null;
  children: ChildEntity[];
}

export default function ExplorePage() {
  const router = useRouter();
  const [entities, setEntities] = useState<ParentEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());

  const fetchEntities = useCallback((q: string) => {
    setLoading(true);
    const url = q.trim()
      ? `${API}/api/entities?q=${encodeURIComponent(q.trim())}`
      : `${API}/api/entities`;
    fetch(url)
      .then((r) => r.json())
      .then((d) =>
        setEntities(
          (d.entities ?? [])
            .filter(
              (e: ParentEntity) =>
                e.type !== "searches" && e.type !== "orphans",
            )
            .map((e: ParentEntity) => ({ ...e, children: e.children ?? [] })),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchEntities("");
  }, [fetchEntities]);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchEntities(value), 300);
  };

  const addToCanvas = async (grandparentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (added.has(grandparentId) || adding.has(grandparentId)) return;
    setAdding((prev) => new Set([...prev, grandparentId]));
    try {
      const res = await fetch("/api/me/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grandparentId }),
      });
      if (res.status === 401) {
        router.push("/canvas");
        return;
      }
      if (res.ok) setAdded((prev) => new Set([...prev, grandparentId]));
    } finally {
      setAdding((prev) => {
        const n = new Set(prev);
        n.delete(grandparentId);
        return n;
      });
    }
  };

  return (
    <div
      className="fixed inset-0 overflow-y-auto text-white"
      style={{
        backgroundColor: "rgba(14, 14, 17, 0.85)",
        scrollbarWidth: "none",
      }}
    >
      <div className="absolute top-3 left-3 z-20">
        <Nav />
      </div>

      <div className="mx-auto max-w-5xl px-6 pt-16 pb-12">
        <input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="search..."
          className="mb-8 w-full rounded-lg bg-transparent px-3 py-2 text-sm text-white placeholder-white/20 outline-none"
          style={{ border: "1px solid rgba(255,255,255,0.12)" }}
        />
        {loading ? (
          <div className="flex flex-col gap-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex gap-6 rounded-2xl p-4"
                style={{ border: "1px solid rgba(255,255,255,0.04)" }}
              >
                <div className="flex w-48 flex-col shrink-0 pt-1">
                  <div className="aspect-square w-full rounded-xl bg-white/[0.06] mb-3 animate-pulse" />
                  <div className="h-3.5 w-3/4 rounded bg-white/[0.06] mb-2 animate-pulse" />
                  <div className="h-2.5 w-1/3 rounded bg-white/[0.04] animate-pulse" />
                </div>
                <div className="flex flex-1 items-start gap-4 overflow-hidden pt-1">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <div key={j} className="flex w-32 shrink-0 flex-col gap-1">
                      <div className="aspect-square w-full rounded-xl bg-white/[0.06] animate-pulse" />
                      <div className="h-2.5 w-4/5 rounded bg-white/[0.06] mt-1 animate-pulse" />
                      <div className="h-2 w-1/2 rounded bg-white/[0.04] animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {entities.map((parent) => (
              <div
                key={parent.id}
                onClick={() => router.push(`/c/${parent.id}`)}
                className="flex gap-6 rounded-2xl p-4 transition-colors hover:bg-white/[0.03] cursor-pointer group/parent"
                style={{ border: "1px solid rgba(255,255,255,0.04)" }}
              >
                <div className="flex w-48 flex-col shrink-0 pt-1">
                  <div className="relative aspect-square w-full rounded-xl bg-zinc-900 mb-3 shadow-lg overflow-hidden group/cover">
                    {parent.cover ? (
                      <Image
                        src={parent.cover}
                        alt={parent.name}
                        fill
                        sizes="192px"
                        className="object-cover"
                      />
                    ) : (
                      <div className="h-full w-full" />
                    )}
                    <button
                      onClick={(e) => addToCanvas(parent.id, e)}
                      className="absolute bottom-2 right-2 flex items-center justify-center rounded-full w-8 h-8 opacity-0 group-hover/cover:opacity-100 transition-all duration-150 active:scale-95"
                      style={{
                        backgroundColor: added.has(parent.id)
                          ? "rgba(99,102,241,0.9)"
                          : "rgba(0,0,0,0.7)",
                        border: "1px solid rgba(255,255,255,0.15)",
                        backdropFilter: "blur(8px)",
                      }}
                      title={
                        added.has(parent.id)
                          ? "Added to canvas"
                          : "Add to canvas"
                      }
                    >
                      {added.has(parent.id) ? (
                        <Check size={14} className="text-white" />
                      ) : (
                        <Plus size={14} className="text-white" />
                      )}
                    </button>
                  </div>
                  <h2 className="text-[15px] font-semibold text-white/90 truncate group-hover/parent:text-white">
                    {parent.name}
                  </h2>
                </div>

                <div
                  className="flex flex-1 items-start gap-4 overflow-x-auto pb-2 pt-1"
                  style={{ scrollbarWidth: "none" }}
                >
                  {parent.children.map((child) => (
                    <div
                      key={child.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/c/${child.id}`);
                      }}
                      className="group/child relative flex w-32 shrink-0 flex-col gap-1 rounded-xl outline-none border-2 border-transparent transition-all duration-200"
                    >
                      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-zinc-900 shadow-md">
                        {child.cover ? (
                          <Image
                            src={child.cover}
                            alt={child.name}
                            fill
                            sizes="128px"
                            className="object-cover"
                          />
                        ) : (
                          <div className="h-full w-full" />
                        )}
                        <button
                          onClick={(e) => addToCanvas(parent.id, e)}
                          className="absolute bottom-1.5 right-1.5 flex items-center justify-center rounded-full w-6 h-6 opacity-0 group-hover/child:opacity-100 transition-all duration-150 active:scale-95"
                          style={{
                            backgroundColor: added.has(parent.id)
                              ? "rgba(99,102,241,0.9)"
                              : "rgba(0,0,0,0.7)",
                            border: "1px solid rgba(255,255,255,0.15)",
                            backdropFilter: "blur(8px)",
                          }}
                          title={
                            added.has(parent.id)
                              ? "Added to canvas"
                              : "Add artist to canvas"
                          }
                        >
                          {added.has(parent.id) ? (
                            <Check size={10} className="text-white" />
                          ) : (
                            <Plus size={10} className="text-white" />
                          )}
                        </button>
                      </div>
                      <div className="px-0.5">
                        <p className="truncate text-xs font-medium text-white/70">
                          {child.name}
                        </p>
                      </div>
                    </div>
                  ))}
                  {parent.children.length === 0 && (
                    <div className="flex w-32 shrink-0 items-center justify-center text-white/20 text-xs italic">
                      no sub-entities
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
