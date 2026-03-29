"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchCanvasPayload } from "@/lib/api/canvas-types";
import { queryKeys } from "../keys";

export function useCanvasQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.canvas,
    queryFn: fetchCanvasPayload,
    enabled,
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.reprojectPending ? 2000 : false),
  });
}
