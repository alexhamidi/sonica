import { auth } from "@/lib/auth/server";
import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

const sql = neon(process.env.POSTGRES_URL!);

export const dynamic = "force-dynamic";

type ReprojectFlagRow = { reproject_pending: boolean };

export async function GET() {
  const { data: session } = await auth.getSession();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;

  const [grandparentRows, entityRows, trackRows, reprojectRow] = await Promise.all([
    sql`
        SELECT gp.id, gp.name, gp.type, gp.cover_s3, ug.expanded
        FROM user_grandparents ug
        JOIN grandparents gp ON gp.id = ug.grandparent_id
        WHERE ug.user_id = ${userId}
        ORDER BY CASE gp.type WHEN 'searches' THEN 2 WHEN 'orphans' THEN 1 ELSE 0 END, ug.added_at
    `,
    sql`
        SELECT p.id, p.name, p.cover_s3, p.type, p.status AS parent_status,
               gp.id       AS grandparent_id,
               gp.name     AS grandparent_name,
               gp.cover_s3 AS grandparent_cover_s3,
               gp.type     AS grandparent_type,
               (
                 SELECT COUNT(*)::int
                 FROM parent_tracks pt
                 JOIN tracks t ON t.id = pt.track_id AND t.status = 'ready'
                 WHERE pt.parent_id = p.id
               ) AS track_count
        FROM user_parents up
        JOIN parents p ON p.id = up.parent_id
        JOIN grandparents gp ON gp.id = p.grandparent_id
        JOIN user_grandparents ug
          ON ug.user_id = up.user_id AND ug.grandparent_id = gp.id
        WHERE up.user_id = ${userId}
        ORDER BY CASE gp.type WHEN 'searches' THEN 2 WHEN 'orphans' THEN 1 ELSE 0 END,
                 ug.added_at, up.added_at, p.created_at
    `,
    sql`
        SELECT
            t.id, t.title, t.artist, t.audio_s3, t.cover_s3,
            COALESCE(utp.umap_x, pt.umap_x) AS umap_x,
            COALESCE(utp.umap_y, pt.umap_y) AS umap_y,
            COALESCE(utp.pca_x,  pt.pca_x)  AS pca_x,
            COALESCE(utp.pca_y,  pt.pca_y)  AS pca_y,
            utp.tsne_x, utp.tsne_y,
            p.id AS source_parent_id
        FROM user_parents up
        JOIN parents p ON p.id = up.parent_id AND p.status = 'ready'
        JOIN parent_tracks pt ON pt.parent_id = p.id
        JOIN tracks t ON t.id = pt.track_id AND t.status = 'ready'
        LEFT JOIN user_track_projections utp
               ON utp.user_id = ${userId} AND utp.track_id = t.id
        WHERE up.user_id = ${userId}
        ORDER BY up.added_at, p.id, t.id
    `,
    sql`
        SELECT EXISTS (
          SELECT 1 FROM user_grandparents
          WHERE user_id = ${userId} AND projected = false
        ) AS reproject_pending
    `,
  ]);

  const S3_BASE = process.env.S3_BASE ?? "";
  const s3 = (key: string | null | undefined) => {
    if (!key) return null;
    if (key.startsWith("http://") || key.startsWith("https://")) return key;
    const k = key.startsWith("s3://") ? key.split("/").slice(3).join("/") : key;
    return `${S3_BASE}/${k}`;
  };

  const entities = entityRows.map((row) => ({
    id: String(row.id),
    name: row.name as string,
    cover: s3(row.cover_s3 as string | null),
    type: row.type as string,
    parentId: row.grandparent_id ? String(row.grandparent_id) : null,
    parentName: row.grandparent_name as string | null,
    parentCover: s3(row.grandparent_cover_s3 as string | null),
    parentType: row.grandparent_type as string | null,
    trackCount: Number(row.track_count ?? 0),
    status: row.parent_status as string,
  }));
  const entityIndex = new Map(entities.map((e, i) => [e.id, i]));

  const tracks = trackRows.map((row, i) => {
    const projections: Record<string, [number, number]> = {};
    if (row.umap_x != null)
      projections.umap = [Number(row.umap_x), Number(row.umap_y)];
    if (row.pca_x != null)
      projections.pca = [Number(row.pca_x), Number(row.pca_y)];
    if (row.tsne_x != null)
      projections.tsne = [Number(row.tsne_x), Number(row.tsne_y)];
    return {
      index: i,
      title: row.title,
      artist: row.artist,
      mp3: s3(row.audio_s3 as string | null),
      cover: s3(row.cover_s3 as string | null),
      playlistIndex: entityIndex.get(String(row.source_parent_id)) ?? 0,
      sourceEntityId: String(row.source_parent_id),
      projections,
    };
  });

  const grandparents = grandparentRows.map((row) => ({
    id: String(row.id),
    name: row.name as string,
    type: row.type as string,
    cover: s3(row.cover_s3 as string | null),
    expanded: Boolean(row.expanded ?? false),
  }));

  const reprojectPending = Boolean(
    (reprojectRow[0] as ReprojectFlagRow | undefined)?.reproject_pending,
  );

  return NextResponse.json({ grandparents, entities, tracks, reprojectPending });
}
