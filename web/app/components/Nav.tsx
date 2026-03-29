"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { authClient } from "@/lib/auth/client";

const links = [
  { label: "home", href: "/home" },
  { label: "canvas", href: "/canvas", protected: true },
  // { label: "explore", href: "/explore" },
];

export function Nav() {
  const pathname = usePathname();
  const session = authClient.useSession();

  return (
    <div className="flex items-center gap-3">
      {links.map(({ label, href, protected: isProtected }) => {
        if (isProtected && !session.isPending && !session.data?.user)
          return null;
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            prefetch={true}
            className="text-sm transition-colors"
            style={{
              color: active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)",
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
  );
}
