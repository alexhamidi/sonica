import type { Track } from "@/app/components/TrackTile";

export type CanvasGrandparent = {
  id: string;
  name: string;
  type: string;
  cover: string | null;
};

export type CanvasEntity = {
  id: string;
  name: string;
  cover: string | null;
  type: string;
  queryKind?: string | null;
  parentId: string | null;
  parentName: string | null;
  parentCover: string | null;
  parentType: string | null;
  trackCount: number;
  canvasVisible: boolean;
  status: string;
};

export type CanvasTrack = Track & { sourceEntityId: string };

export type CanvasPayload = {
  grandparents: CanvasGrandparent[];
  entities: CanvasEntity[];
  tracks: CanvasTrack[];
  reprojectPending?: boolean;
};

export async function fetchCanvasPayload(): Promise<CanvasPayload> {
  const res = await fetch("/api/me/canvas");
  if (!res.ok) {
    let desc = res.statusText || `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: unknown; error?: unknown };
      if (typeof j.detail === "string") desc = j.detail;
      else if (typeof j.error === "string") desc = j.error;
    } catch {
      /* keep desc */
    }
    throw new Error(desc);
  }
  return res.json() as Promise<CanvasPayload>;
}
