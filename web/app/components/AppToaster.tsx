"use client";

import { Toaster } from "sonner";

export function AppToaster() {
  return (
    <Toaster
      theme="dark"
      position="top-center"
      toastOptions={{
        classNames: {
          toast: "!bg-zinc-900 !border !border-white/10 !text-white",
          description: "!text-white/60",
          actionButton: "!bg-white/10 !text-white",
        },
      }}
    />
  );
}
