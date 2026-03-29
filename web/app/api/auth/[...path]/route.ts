import { auth } from "@/lib/auth/server";
import { neon } from "@neondatabase/serverless";
import { NextRequest } from "next/server";

const sql = neon(process.env.POSTGRES_URL!);

const SEARCHES_ID = "00000000-0000-0000-0000-000000000001";
const ORPHANS_ID = "00000000-0000-0000-0000-000000000002";

async function provisionUser(userId: string) {
  await sql`
        INSERT INTO user_grandparents (user_id, grandparent_id)
        VALUES
            (${userId}, ${SEARCHES_ID}),
            (${userId}, ${ORPHANS_ID})
        ON CONFLICT DO NOTHING
    `;
}

const { GET, POST: authPOST } = auth.handler();
export { GET };

export async function POST(req: NextRequest, ctx: unknown) {
  const url = new URL(req.url);
  const res = await authPOST(req, ctx);

  if (url.pathname.endsWith("/sign-up/email") && res.ok) {
    try {
      const body = await res.clone().json();
      const userId = body?.user?.id;
      if (userId) await provisionUser(userId);
    } catch {}
  }

  return res;
}
