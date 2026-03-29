import { auth } from "@/lib/auth/server";
import { sql } from "@/lib/server/db";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

/** Add source to library (or ensure row exists) and show on canvas. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await sql`
    INSERT INTO user_parents (user_id, parent_id, canvas_visible)
    VALUES (${session.user.id}, ${id}, true)
    ON CONFLICT (user_id, parent_id)
    DO UPDATE SET canvas_visible = true
  `;
  return NextResponse.json({ ok: true });
}

/** Toggle whether this source’s tracks appear on the map (row stays in library). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { canvasVisible?: unknown };
  if (typeof body.canvasVisible !== "boolean") {
    return NextResponse.json(
      { error: "Expected { canvasVisible: boolean }" },
      { status: 400 },
    );
  }

  const { id } = await params;
  const updated = await sql`
    UPDATE user_parents
    SET canvas_visible = ${body.canvasVisible}
    WHERE user_id = ${session.user.id} AND parent_id = ${id}
    RETURNING parent_id
  `;
  if (updated.length === 0)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Remove source from library entirely. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await sql`
    DELETE FROM user_parents
    WHERE user_id = ${session.user.id} AND parent_id = ${id}
  `;
  return NextResponse.json({ ok: true });
}
