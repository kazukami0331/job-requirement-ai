import Link from "next/link";
import { deleteCandidateJob } from "@/app/admin/actions";
import type { CandidateJob } from "@/lib/candidateJobs";
import { JOB_SOURCES } from "@/lib/crmConstants";
import AddJobForm from "@/components/admin/AddJobForm";
import CopyButton from "@/components/admin/CopyButton";
import JobStageSelect from "@/components/admin/JobStageSelect";
import MessageComposer from "@/components/admin/MessageComposer";
import { Notice } from "@/components/admin/bits";

export default function CandidateJobsPanel({
  userId,
  candidateName,
  staffName,
  jobs,
  origin,
  saved,
  error,
}: {
  userId: string;
  candidateName: string;
  staffName: string;
  jobs: CandidateJob[];
  origin: string;
  saved?: string;
  error?: string;
}) {
  const shareUrl = (j: CandidateJob) => `${origin}/j/${j.share_token}`;
  const label = (j: CandidateJob) => ({
    company: j.company || "（会社名なし）",
    title: j.title || j.job_id || "（タイトルなし）",
  });
  return (
    <section id="jobs" className="scroll-mt-20 rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <h2 className="font-semibold">📋 提案・選考する求人</h2>
        <span className="text-sm text-slate-500">{jobs.length} 件</span>
      </div>
      <div className="space-y-4 p-4">
        {saved === "job" && <Notice kind="ok">✓ 求人をリストに追加しました</Notice>}
        {error && <Notice kind="error">{error}</Notice>}

        {jobs.length === 0 ? (
          <p className="text-sm text-slate-400">
            まだありません。下のフォームで提案求人を追加するか、スワイプ履歴の「＋ 提案リストへ」で Like した求人を入れてください。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">出どころ</th>
                  <th className="py-2 pr-3 font-medium">求人</th>
                  <th className="py-2 pr-3 font-medium">選考ステージ</th>
                  <th className="py-2 pr-3 font-medium">共有リンク</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => {
                  const l = label(j);
                  return (
                    <tr key={j.id} className="align-top">
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{JOB_SOURCES[j.source] ?? j.source}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="text-xs text-slate-500">{l.company}</div>
                        <div className="font-medium text-slate-900">{l.title}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-400">
                          {j.job_id && (
                            <Link href={`/admin/jobs/${encodeURIComponent(j.job_id)}?from=${encodeURIComponent(userId)}`} className="hover:underline">{j.job_id}</Link>
                          )}
                          {j.pdf_path && <span>📄 PDF あり</span>}
                          {j.note && <span>メモ：{j.note}</span>}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3"><JobStageSelect id={j.id} stage={j.stage} /></td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <CopyButton text={shareUrl(j)} label="リンクをコピー" />
                          <a href={shareUrl(j)} target="_blank" rel="noreferrer" className="text-xs text-indigo-700 hover:underline">開く ↗</a>
                        </div>
                      </td>
                      <td className="py-2.5 text-right">
                        <form action={deleteCandidateJob}>
                          <input type="hidden" name="id" value={j.id} />
                          <input type="hidden" name="userId" value={userId} />
                          <button className="text-xs text-slate-400 hover:text-rose-600">外す</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <MessageComposer
          candidateName={candidateName}
          staffName={staffName}
          items={jobs
            .filter((j) => j.stage !== "rejected" && j.stage !== "declined")
            .map((j) => ({ id: j.id, ...label(j), url: shareUrl(j), preselect: j.stage === "proposed" || j.stage === "interested" }))}
        />

        <AddJobForm userId={userId} />
      </div>
    </section>
  );
}
