import { auth } from "@/lib/auth/server";
import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

const sql = neon(process.env.POSTGRES_URL!);

export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const userId = session.user.id;
  const body = await req.json();

  const expanded: boolean | undefined =
    typeof body.expanded === "boolean" ? body.expanded : undefined;

  if (expanded === undefined) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  await sql`UPDATE user_grandparents SET expanded = ${expanded} WHERE user_id = ${userId} AND grandparent_id = ${id}`;

  return NextResponse.json({ expanded });
}
