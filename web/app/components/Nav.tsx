"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { authClient } from "@/lib/auth/client";

const links = [
  { label: "home", href: "/" },
  { label: "canvas", href: "/canvas" },
];

export function Nav() {
  const pathname = usePathname();
  const session = authClient.useSession();

  return (
    <div className="flex w-full max-w-[min(100vw-1.5rem,48rem)] items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        {links.map(({ label, href }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              className="text-sm transition-colors"
              style={{
                color: active
                  ? "rgba(255,255,255,0.9)"
                  : "rgba(255,255,255,0.3)",
              }}
              onMouseEnter={(e) => {
                if (!active)
                  e.currentTarget.style.color = "rgba(255,255,255,0.7)";
              }}
              onMouseLeave={(e) => {
                if (!active)
                  e.currentTarget.style.color = "rgba(255,255,255,0.3)";
              }}
            >
              {label}
            </Link>
          );
        })}
      </div>
      {!session.isPending && !session.data?.user ? (
        <button
          type="button"
          className="shrink-0 text-sm transition-colors"
          style={{ color: "rgba(255,255,255,0.55)" }}
          onClick={() =>
            void authClient.signIn.social({
              provider: "google",
              callbackURL: "/canvas",
            })
          }
        >
          log in with Google
        </button>
      ) : null}
    </div>
  );
}
