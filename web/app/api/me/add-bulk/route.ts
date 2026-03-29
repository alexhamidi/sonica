import { auth } from "@/lib/auth/server";
import { sql } from "@/lib/server/db";
import { triggerMusReprojectUser } from "@/lib/server/mus-reproject";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const ids = body.grandparentIds as unknown;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "grandparentIds non-empty array required" },
      { status: 400 },
    );
  }
  const grandparentIds = ids.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  if (grandparentIds.length !== ids.length) {
    return NextResponse.json(
      { error: "grandparentIds must be strings" },
      { status: 400 },
    );
  }

  const userId = session.user.id;
  let anyReady = false;
  const results: {
    grandparentId: string;
    parents: { id: string; status: string }[];
  }[] = [];

  for (const grandparentId of grandparentIds) {
    const gpRows = await sql`
      SELECT id FROM grandparents WHERE id = ${grandparentId}::uuid LIMIT 1
    `;
    if (!gpRows.length) {
      return NextResponse.json(
        { error: `Unknown grandparent: ${grandparentId}` },
        { status: 404 },
      );
    }

    await sql`
      INSERT INTO user_grandparents (user_id, grandparent_id)
      VALUES (${userId}, ${grandparentId}::uuid)
      ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO user_parents (user_id, parent_id)
      SELECT ${userId}, p.id FROM parents p
      WHERE p.grandparent_id = ${grandparentId}::uuid
        AND EXISTS (SELECT 1 FROM parent_tracks pt WHERE pt.parent_id = p.id)
      ON CONFLICT DO NOTHING
    `;

    const parents = await sql`
      SELECT id, status FROM parents p
      WHERE p.grandparent_id = ${grandparentId}::uuid
        AND EXISTS (SELECT 1 FROM parent_tracks pt WHERE pt.parent_id = p.id)
    `;
    const plist = parents as { id: unknown; status: string }[];
    if (plist.some((p) => p.status === "ready")) {
      anyReady = true;
      await sql`
        UPDATE user_grandparents
        SET projected = false
        WHERE user_id = ${userId} AND grandparent_id = ${grandparentId}::uuid
      `;
    }
    results.push({
      grandparentId,
      parents: plist.map((p) => ({
        id: String(p.id),
        status: p.status,
      })),
    });
  }

  if (anyReady) {
    try {
      const resProj = await triggerMusReprojectUser(userId);
      if (!resProj.ok) {
        const detail = await resProj.text();
        console.error("mus reproject-user:", resProj.status, detail);
        return NextResponse.json(
          { error: "Layout service error", detail, results },
          { status: 503 },
        );
      }
    } catch (e) {
      console.error("mus reproject-user fetch failed", e);
      return NextResponse.json(
        { error: "Layout service unreachable", detail: String(e), results },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({ results });
}
