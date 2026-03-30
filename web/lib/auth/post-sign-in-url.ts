const EXPECT_CANVAS_KEY = "mus:expectCanvasAfterOAuth";

/**
 * Post-OAuth redirect target. Use a full URL so Neon Auth / Better Auth always
 * send the browser to our app’s canvas (relative paths can end up on `/`).
 */
export function postSignInCanvasUrl(): string {
  if (typeof window === "undefined") return "/canvas";
  return `${window.location.origin}/canvas`;
}

/** Call immediately before `signIn.social` when the user should land on /canvas. */
export function markExpectCanvasAfterOAuth(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(EXPECT_CANVAS_KEY, "1");
}

export function peekExpectCanvasAfterOAuth(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(EXPECT_CANVAS_KEY) === "1";
}

export function clearExpectCanvasAfterOAuth(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(EXPECT_CANVAS_KEY);
}
