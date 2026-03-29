"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CanvasPayload } from "@/lib/api/canvas-types";
import { queryKeys } from "../keys";

async function patchCanvasVisible(parentId: string, canvasVisible: boolean) {
  const res = await fetch(`/api/me/parents/${parentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canvasVisible }),
  });
  if (!res.ok) throw new Error(String(res.status));
}

export function usePatchParentCanvasVisible() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      parentId,
      canvasVisible,
    }: {
      parentId: string;
      canvasVisible: boolean;
    }) => patchCanvasVisible(parentId, canvasVisible),

    onMutate: async ({ parentId, canvasVisible }) => {
      await qc.cancelQueries({ queryKey: queryKeys.canvas });
      const prev = qc.getQueryData<CanvasPayload>(queryKeys.canvas);
      if (prev) {
        qc.setQueryData<CanvasPayload>(queryKeys.canvas, {
          ...prev,
          entities: prev.entities.map((e) =>
            e.id === parentId ? { ...e, canvasVisible } : e,
          ),
        });
      }
      return { prev } as { prev: CanvasPayload | undefined };
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.canvas, ctx.prev);
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.canvas });
    },
  });
}
