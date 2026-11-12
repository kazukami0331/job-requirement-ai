import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCandidateJobByToken, lookupJobs } from "@/lib/candidateJobs";
import ViewTracker from "@/components/ViewTracker";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const job = await getCandidateJobByToken(token).catch(() => null);
  return {
    title: job ? `${job.company ?? ""} ${job.title ?? "求人のご紹介"}`.trim() : "求人のご紹介",
    robots: { index: false, follow: false },
  };
}

/** 候補者に送る求人ページ（ログイン不要。リンクを知っている人だけが見られる） */
export default async function SharedJobPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const cj = await getCandidateJobByToken(token).catch(() => null);
  if (!cj) notFound();
  const job = cj.job_id ? (await lookupJobs([cj.job_id]).catch(() => new Map())).get(cj.job_id) : undefined;
  const pdfUrl = cj.pdf_path ? `/j/${token}/pdf` : null;

  const sections: [string, string | null | undefined][] = job
    ? [
        ["仕事内容", job.description],
        ["応募条件", job.applicationRequirements],
        ["給与", job.salaryDetails],
        ["勤務地", job.workLocation],
        ["勤務時間", job.workingHours],
        ["休日・福利厚生", job.employmentBenefits],
        ["選考プロセス", job.selectionProcess],
        ["会社情報", job.companyDescription],
      ]
    : [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <ViewTracker token={token} />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="text-xs font-semibold tracking-wide text-slate-500">求人のご紹介</div>
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-sm text-slate-600">{cj.company ?? job?.company}</div>
          <h1 className="mt-1 text-xl font-bold leading-snug">{cj.title ?? job?.title}</h1>
          {job && (
            <div className="mt-3 text-sm text-slate-600">
              {[job.employmentType, job.location, job.salary].filter(Boolean).join(" ／ ")}
            </div>
          )}
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" data-track="pdf" className="mt-4 inline-flex rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">
              📄 求人票（PDF）を開く
            </a>
          )}
        </section>

        {pdfUrl && (
          <iframe src={pdfUrl} title="求人票" className="hidden h-[80vh] w-full rounded-2xl border border-slate-200 bg-white sm:block" />
        )}

        {!pdfUrl &&
          sections
            .filter(([, body]) => body)
            .map(([title, body]) => (
              <section key={title} className="rounded-2xl border border-slate-200 bg-white p-5">
                <h2 className="mb-2 font-semibold">{title}</h2>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{body}</p>
              </section>
            ))}

        {!pdfUrl && !job && (
          <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
            詳細は担当者からご案内します。
          </p>
        )}
        <p className="pt-2 text-center text-xs text-slate-400">ご不明な点は担当者までお気軽にご連絡ください。</p>
      </main>
    </div>
  );
}
