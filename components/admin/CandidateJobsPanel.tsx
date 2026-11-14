import Link from "next/link";
import { deleteCandidateJob } from "@/app/admin/actions";
import type { CandidateJob, ViewStats } from "@/lib/candidateJobs";
import { formatJst } from "@/lib/swipeAdmin";
import { JOB_SOURCES } from "@/lib/crmConstants";
import AddJobForm from "@/components/admin/AddJobForm";
import CopyButton from "@/components/admin/CopyButton";
import JobStageSelect from "@/components/admin/JobStageSelect";
import MessageComposer from "@/components/admin/MessageComposer";
import { Notice, btnCls, btnSubCls } from "@/components/admin/bits";
import Modal from "@/components/admin/Modal";

export default function CandidateJobsPanel({
  userId,
  candidateName,
  staffName,
  jobs,
  views,
  origin,
  saved,
  error,
}: {
  userId: string;
  candidateName: string;
  staffName: string;
  jobs: CandidateJob[];
  views: Map<string, ViewStats>;
  origin: string;
  saved?: string;
  error?: string;
}) {
  const shareUrl = (j: CandidateJob) => `${origin}/j/${j.share_token}`;
  const label = (j: CandidateJob) => ({
    company: j.company || "（会社名なし）",
    title: j.title || j.job_id || "（タイトルなし）",
  });
  const composeItems = jobs
    .filter((j) => j.stage !== "rejected" && j.stage !== "declined")
    .map((j) => ({ id: j.id, ...label(j), url: shareUrl(j), preselect: j.stage === "proposed" || j.stage === "interested" }));

  return (
    <section id="jobs" className="scroll-mt-20 rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <h2 className="font-semibold">📋 提案・選考する求人</h2>
        <span className="text-sm text-slate-500">{jobs.length} 件</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {/* 求人数が変わったら作り直して閉じる */}
          <Modal key={`add-${jobs.length}`} title="提案する求人を追加" buttonLabel="＋ 求人を追加" buttonClassName={btnSubCls} wide>
            <AddJobForm userId={userId} />
          </Modal>
          <Modal
            title={`${candidateName}様への送付文`}
            buttonLabel="✉️ 送付文を作る"
            buttonClassName={btnCls}
            disabled={composeItems.length === 0}
            wide
          >
            <MessageComposer candidateName={candidateName} staffName={staffName} items={composeItems} />
          </Modal>
        </div>
      </div>
      <div className="space-y-4 p-4">
        {saved === "job" && <Notice kind="ok">✓ 求人をリストに追加しました</Notice>}
        {error && <Notice kind="error">{error}</Notice>}

        {jobs.length === 0 ? (
          <p className="text-sm text-slate-400">
            まだありません。右上の「＋ 求人を追加」で提案求人を入れるか、「♥ スワイプ履歴」タブの「＋ 提案リストへ」で Like した求人を入れてください。
          </p>
        ) : (
          <>
          {/* スマホ：カード表示 */}
          <ul className="space-y-3 md:hidden">
            {jobs.map((j) => {
              const l = label(j);
              return (
                <li key={j.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{JOB_SOURCES[j.source] ?? j.source}</span>
                    <form action={deleteCandidateJob}>
                      <input type="hidden" name="id" value={j.id} />
                      <input type="hidden" name="userId" value={userId} />
                      <button className="text-xs text-slate-400">外す</button>
                    </form>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">{l.company}</div>
                    <div className="text-sm font-medium text-slate-900">{l.title}</div>
                  </div>
                  <JobStageSelect id={j.id} stage={j.stage} />
                  <div className="flex items-center gap-3">
                    <CopyButton text={shareUrl(j)} label="リンクをコピー" />
                    <a href={shareUrl(j)} target="_blank" rel="noreferrer" className="text-xs text-indigo-700">開く ↗</a>
                  </div>
                  <ViewCell v={views.get(j.id)} />
                </li>
              );
            })}
          </ul>

          {/* PC：表 */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">出どころ</th>
                  <th className="py-2 pr-3 font-medium">求人</th>
                  <th className="py-2 pr-3 font-medium">選考ステージ</th>
                  <th className="py-2 pr-3 font-medium">共有リンク</th>
                  <th className="py-2 pr-3 font-medium">候補者の閲覧</th>
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
                      <td className="py-2.5 pr-3"><ViewCell v={views.get(j.id)} /></td>
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
          </>
        )}

      </div>
    </section>
  );
}

function ViewCell({ v }: { v: ViewStats | undefined }) {
  if (!v) return <span className="text-xs text-slate-400">未閲覧</span>;
  const min = Math.floor(v.totalSec / 60);
  const sec = v.totalSec % 60;
  return (
    <div className="text-xs leading-relaxed">
      <div className="font-semibold text-emerald-700">👀 {v.views} 回</div>
      <div className="text-slate-500">最終 {formatJst(v.lastAt)}</div>
      <div className="text-slate-500">
        {v.maxScroll}% まで・計 {min ? `${min}分` : ""}{sec}秒{v.pdfOpened ? "・PDF 開封" : ""}
      </div>
    </div>
  );
}
