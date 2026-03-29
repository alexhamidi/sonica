import { auth } from "@/lib/auth/server";
import { sql } from "@/lib/server/db";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
const SENTINEL_GRANDPARENT_TYPES = new Set(["orphans", "searches"]);

export async function DELETE(req: Request) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { grandparentId } = await req.json();
  if (!grandparentId)
    return NextResponse.json(
      { error: "Missing grandparentId" },
      { status: 400 },
    );

  const rows = await sql`
        SELECT type FROM grandparents WHERE id = ${grandparentId}
    `;
  const grandparentType = rows[0]?.type as string | undefined;

  if (!grandparentType) {
    return NextResponse.json(
      { error: "Grandparent not found" },
      { status: 404 },
    );
  }

  if (SENTINEL_GRANDPARENT_TYPES.has(grandparentType)) {
    return NextResponse.json(
      { error: "Sentinel grandparents cannot be deleted" },
      { status: 403 },
    );
  }

  const parentIds = await sql`
        SELECT id FROM parents WHERE grandparent_id = ${grandparentId}
    `;
  if (parentIds.length > 0) {
    const ids = parentIds.map((r) => String(r.id));
    await sql`
        DELETE FROM user_parents
        WHERE user_id = ${session.user.id} AND parent_id = ANY(${ids})
    `;
  }

  await sql`
        DELETE FROM user_grandparents
        WHERE user_id = ${session.user.id} AND grandparent_id = ${grandparentId}
    `;

  if (grandparentType === "user") {
    await sql`DELETE FROM grandparents WHERE id = ${grandparentId}`;
  }

  return NextResponse.json({ ok: true });
}
