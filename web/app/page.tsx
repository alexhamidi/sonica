"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export default function Root() {
  const router = useRouter();
  const session = authClient.useSession();

  useEffect(() => {
    if (session.isPending) return;
    router.replace(session.data?.user ? "/canvas" : "/home");
  }, [session.isPending, session.data, router]);

  return null;
}
