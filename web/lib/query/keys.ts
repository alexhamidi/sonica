export const queryKeys = {
  canvas: ["me", "canvas"] as const,
  artistsHome: (mode: string, debouncedSearch: string) =>
    ["catalog", "artists", "home", mode, debouncedSearch] as const,
  artistsPicker: (debouncedSearch: string, userId: string | null) =>
    ["catalog", "artists", "picker", debouncedSearch, userId ?? ""] as const,
} as const;
