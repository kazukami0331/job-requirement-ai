import Link from "next/link";
import { notFound } from "next/navigation";
import { formatJst, getJob } from "@/lib/swipeAdmin";
import { ActionBadge, AppliedBadge, Chips, ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const jobId = decodeURIComponent(id);

  let data;
  try {
    data = await getJob(jobId);
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  const { job, swipes } = data;
  if (!job && swipes.length === 0) notFound();

  const back = from ? (
    <Link href={`/admin/users/${encodeURIComponent(from)}`} className="text-sm text-slate-500 hover:text-slate-900">← 候補者のスワイプ履歴に戻る</Link>
  ) : (
    <Link href="/admin" className="text-sm text-slate-500 hover:text-slate-900">← 候補者一覧</Link>
  );

  const likes = swipes.filter((s) => s.action === "like").length;

  return (
    <div className="space-y-6">
      {back}
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <article className="min-w-0 space-y-4">
          {job ? (
            <>
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h1 className="text-xl font-bold leading-snug">{job.title}</h1>
                <div className="mt-2 text-sm">
                  {job.companyUrl ? (
                    <a href={job.companyUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 hover:underline">{job.company}</a>
                  ) : (
                    <span className="font-medium">{job.company}</span>
                  )}
                  <span className="ml-2 text-xs text-slate-400">求人ID：{job.id}{job.source && ` ・ 提供元：${job.source}`}</span>
                </div>
                <div className="mt-3 text-sm text-slate-600">
                  {[job.employmentType, job.jobType, job.industry, job.location, job.salary].filter(Boolean).join(" ／ ")}
                </div>
                {job.tags?.length ? <div className="mt-3"><Chips items={job.tags} /></div> : null}
                <div className="mt-3 flex flex-wrap gap-4 text-sm">
                  {job.jobUrl && <a href={job.jobUrl} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">元の求人ページを開く ↗</a>}
                  {job.status && job.status !== "active" && <span className="rounded bg-amber-100 px-2 text-amber-700">ステータス：{job.status}</span>}
                </div>
              </section>

              <Section title="仕事内容" body={job.description} />
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="mb-3 font-semibold">応募条件</h2>
                <Label>必須</Label>
                <Bullets items={job.requiredExperience} />
                <Label>歓迎</Label>
                <Bullets items={job.preferredExperience} />
                {job.education && (<><Label>学歴</Label><p className="text-sm">{job.education}</p></>)}
                {job.applicationRequirements && (<><Label>詳細</Label><Pre text={job.applicationRequirements} /></>)}
              </section>
              <Section title="給与" body={job.salaryDetails} />
              <Section title="勤務地" body={job.workLocation} />
              <Section title="勤務時間" body={job.workingHours} />
              <Section title="休日・福利厚生" body={job.employmentBenefits} />
              <Section title="選考プロセス" body={job.selectionProcess} />
              <Section title="受動喫煙対策" body={job.smokingPolicy} />
              <Section title={`会社情報${job.employeeCount ? `（従業員 ${job.employeeCount.toLocaleString()} 名）` : ""}`} body={job.companyDescription} />
            </>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
              求人ID「{jobId}」は jobs テーブルに見つかりませんでした（削除・入れ替えされた可能性があります）。
            </div>
          )}
        </article>

        <aside className="h-fit rounded-xl border border-slate-200 bg-white lg:sticky lg:top-20">
          <h2 className="border-b border-slate-200 p-3 text-sm font-semibold">
            この求人をスワイプした人 <span className="font-normal text-slate-500">（Like {likes} / 全 {swipes.length}）</span>
          </h2>
          <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
            {swipes.map((s) => (
              <li key={s.id}>
                <Link href={`/admin/users/${encodeURIComponent(s.userId)}`} className={`block px-3 py-2 hover:bg-slate-50 ${s.userId === from ? "bg-indigo-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <ActionBadge action={s.action} />
                    <span className="truncate text-sm font-medium">{s.user?.name || s.user?.email || s.userId}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                    {formatJst(s.createdAt)}
                    {s.application && <AppliedBadge status={s.application.status} />}
                  </div>
                </Link>
              </li>
            ))}
            {swipes.length === 0 && <li className="p-4 text-sm text-slate-400">まだ誰もスワイプしていません</li>}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string | null }) {
  if (!body) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-3 font-semibold">{title}</h2>
      <Pre text={body} />
    </section>
  );
}

function Pre({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{text}</p>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-xs font-semibold text-slate-500 first:mt-0">{children}</div>;
}

function Bullets({ items }: { items: string[] | null }) {
  if (!items?.length) return <p className="text-sm text-slate-400">—</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-700">
      {items.map((t, i) => <li key={i}>{t}</li>)}
    </ul>
  );
}
