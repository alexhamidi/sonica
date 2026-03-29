"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8002";

interface Entity {
  id: string;
  name: string;
  cover: string | null;
  type: string;
}

interface CmdKProps {
  open: boolean;
  onClose: () => void;
}

export function CmdK({ open, onClose }: CmdKProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  const fetchEntities = (q: string) => {
    const url = q.trim()
      ? `${API}/api/entities?q=${encodeURIComponent(q.trim())}`
      : `${API}/api/entities`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => setEntities(d.entities ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      fetchEntities("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleQuery = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchEntities(value), 300);
  };

  const navigate = (entity: Entity) => {
    router.push(`/c/${entity.id}`);
    onClose();
  };

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Keep handler ref up to date without re-registering the listener
  useEffect(() => {
    handlerRef.current = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        setSelected((s) => Math.min(s + 1, entities.length - 1));
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        setSelected((s) => Math.max(s - 1, 0));
        e.preventDefault();
      }
      if (e.key === "Enter" && entities[selected]) {
        navigate(entities[selected]);
      }
    };
  }, [entities, selected, onClose]);

  // Register/unregister only when open changes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => handlerRef.current?.(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      style={{
        backgroundColor: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          backgroundColor: "rgb(18, 18, 22)",
          border: "1px solid rgb(40, 40, 46)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
      >
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid rgb(32, 32, 38)" }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-white/30 flex-shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQuery(e.target.value)}
            placeholder="browse collections..."
            className="flex-1 bg-transparent text-sm text-white placeholder-white/25 outline-none"
          />
          <kbd className="text-[10px] text-white/20 font-mono">esc</kbd>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {entities.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-white/30">
              no collections found
            </p>
          )}
          {entities.map((entity, i) => (
            <button
              key={entity.id}
              onMouseDown={() => navigate(entity)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
              style={{
                backgroundColor:
                  i === selected ? "rgba(255,255,255,0.06)" : "transparent",
              }}
              onMouseEnter={() => setSelected(i)}
            >
              {entity.cover ? (
                <div className="relative h-8 w-8 flex-shrink-0 rounded-md overflow-hidden">
                  <Image
                    src={entity.cover}
                    alt=""
                    fill
                    sizes="32px"
                    className="object-cover"
                  />
                </div>
              ) : (
                <div
                  className="h-8 w-8 flex-shrink-0 rounded-md"
                  style={{ backgroundColor: "rgb(40,40,48)" }}
                />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{entity.name}</p>
                <p className="text-[11px] text-white/30 capitalize">
                  {entity.type}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
