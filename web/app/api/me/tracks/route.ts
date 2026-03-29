import { auth } from "@/lib/auth/server";
import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";

const sql = neon(process.env.POSTGRES_URL!);

const TRACK_LIMIT = 500;

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const { trackIds, sourceEntityId } = (await req.json()) as {
    trackIds: string[];
    sourceEntityId: string;
  };

  // Check current count
  const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM user_tracks WHERE user_id = ${userId}
    `;

  const existing = Number(count);
  const adding = trackIds.length;

  if (existing + adding > TRACK_LIMIT) {
    return NextResponse.json(
      {
        error: `Would exceed ${TRACK_LIMIT} track limit (have ${existing}, adding ${adding})`,
      },
      { status: 422 },
    );
  }

  // Insert, skip duplicates
  await sql`
        INSERT INTO user_tracks (user_id, track_id, source_entity_id)
        SELECT ${userId}, UNNEST(${trackIds}::uuid[]), ${sourceEntityId}::uuid
        ON CONFLICT (user_id, track_id) DO NOTHING
    `;

  return NextResponse.json({ ok: true, total: existing + adding });
}

export async function DELETE(req: NextRequest) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const { trackId } = (await req.json()) as { trackId: string };

  await sql`
        DELETE FROM user_tracks WHERE user_id = ${userId} AND track_id = ${trackId}::uuid
    `;

  return NextResponse.json({ ok: true });
}
