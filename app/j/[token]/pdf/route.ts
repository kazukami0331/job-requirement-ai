import { NextResponse } from "next/server";
import { getCandidateJobByToken, PDF_BUCKET } from "@/lib/candidateJobs";
import { storageSignDownload } from "@/lib/swipeAdmin";

export const dynamic = "force-dynamic";

/** 共有リンクの PDF。毎回 1 時間だけ有効な URL を作ってそこへ転送する */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = await getCandidateJobByToken(token).catch(() => null);
  if (!job?.pdf_path) return new NextResponse("見つかりません", { status: 404 });
  const url = await storageSignDownload(PDF_BUCKET, job.pdf_path, 3600);
  return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } });
}
