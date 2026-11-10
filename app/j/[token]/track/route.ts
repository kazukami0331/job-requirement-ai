import { NextResponse, type NextRequest } from "next/server";
import { getCandidateJobByToken } from "@/lib/candidateJobs";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { enc, writeRows } from "@/lib/swipeAdmin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clamp = (n: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));

/**
 * 共有リンクの閲覧記録。ページ側から sendBeacon で送られてくる。
 * - start：開いたとき（1 行作る）
 * - ping ：開いている間と閉じるとき（滞在時間・最大スクロール・PDF を開いたかを更新）
 * ログイン中の社内メンバーが開いた分は記録しない。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null)) {
      return new NextResponse(null, { status: 204 });
    }
    const { token } = await params;
    const body = JSON.parse(await req.text()) as Record<string, unknown>;
    const visitId = String(body.visitId ?? "");
    if (!UUID.test(visitId)) return new NextResponse(null, { status: 400 });

    const job = await getCandidateJobByToken(token);
    if (!job) return new NextResponse(null, { status: 404 });

    const now = new Date().toISOString();
    if (body.event === "start") {
      await writeRows(
        "POST",
        "crm_job_views",
        "",
        {
          id: visitId,
          candidate_job_id: job.id,
          viewed_at: now,
          last_seen_at: now,
          user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
        },
        { ignoreDuplicates: true },
      );
    } else {
      await writeRows("PATCH", "crm_job_views", `id=eq.${enc(visitId)}&candidate_job_id=eq.${enc(job.id)}`, {
        last_seen_at: now,
        duration_sec: clamp(body.duration, 24 * 3600),
        max_scroll: clamp(body.scroll, 100),
        ...(body.pdf ? { pdf_opened: true } : {}),
      });
    }
    return new NextResponse(null, { status: 204 });
  } catch {
    // 記録に失敗しても候補者の閲覧には影響させない
    return new NextResponse(null, { status: 204 });
  }
}
