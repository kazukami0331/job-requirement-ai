import Link from "next/link";
import { notFound } from "next/navigation";
import { formatJst, getCandidate } from "@/lib/swipeAdmin";
import { ActionBadge, AppliedBadge, Chips, ErrorBox } from "@/components/admin/ui";
import CrmPanel from "@/components/admin/CrmPanel";
import { crmForUser } from "@/lib/crm";
import { listStaff, requireStaff } from "@/lib/auth";
import { headers } from "next/headers";
import { listCandidateJobs, syncSwipeApplications, viewStats, type CandidateJob } from "@/lib/candidateJobs";
import { buildInsights, insightsText } from "@/lib/insights";
import { addSwipeJobForCandidate } from "@/app/admin/actions";
import CandidateJobsPanel from "@/components/admin/CandidateJobsPanel";
import InsightsPanel from "@/components/admin/InsightsPanel";
import type { JobSummary } from "@/lib/swipeAdmin";

export const dynamic = "force-dynamic";
// AI 分析（数十秒かかる）のために長めに
export const maxDuration = 120;

const TABS = [
  { key: "crm", label: "📞 対応・架電" },
  { key: "jobs", label: "📋 提案・選考" },
  { key: "swipes", label: "♥ スワイプ履歴" },
  { key: "insights", label: "💡 傾向・AI 分析" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const FILTERS = [
  { key: "all", label: "すべて" },
  { key: "like", label: "Like" },
  { key: "pass", label: "Pass" },
  { key: "applied", label: "応募済" },
] as const;

export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; filter?: string; saved?: string; error?: string; jobError?: string }>;
}) {
  const { id } = await params;
  const { filter = "all", saved, error, jobError } = await searchParams;
  const tabParam = (await searchParams).tab;
  const tab = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "crm";
  const me = await requireStaff();
  const userId = decodeURIComponent(id);

  let data;
  try {
    data = await getCandidate(userId);
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  if (!data) notFound();
  const { user, profile, swipes, appsWithoutSwipe } = data;

  let crmPanel: React.ReactNode;
  try {
    const [crm, staff] = await Promise.all([crmForUser(userId), listStaff()]);
    crmPanel = (
      <CrmPanel userId={userId} {...crm} staff={staff} me={me} saved={saved} error={error} />
    );
  } catch (e) {
    crmPanel = <ErrorBox error={e} />;
  }

  // Like / Pass の傾向
  const likedJobs = swipes.filter((s) => s.action === "like" && s.job).map((s) => s.job as JobSummary);
  const passedJobs = swipes.filter((s) => s.action !== "like" && s.job).map((s) => s.job as JobSummary);
  const ins = buildInsights(likedJobs, passedJobs);
  const candidateName = user.name || "（お名前）";

  // 提案・選考する求人（SwipeJob の応募は自動でリストに入れる）
  let jobsPanel: React.ReactNode;
  let jobsCount = 0;
  let listedJobIds: Set<string> | null = null; // null = 提案求人の表が使えない

  try {
    const appliedIds = [...swipes.filter((s) => s.application).map((s) => s.jobId), ...appsWithoutSwipe.map((a) => a.jobId)];
    await syncSwipeApplications(userId, appliedIds);
    const jobs: CandidateJob[] = await listCandidateJobs(userId);
    listedJobIds = new Set(jobs.map((j) => j.job_id).filter((x): x is string => !!x));
    jobsCount = jobs.length;
    const h = await headers();
    const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
    jobsPanel = (
      <CandidateJobsPanel
        userId={userId}
        candidateName={candidateName}
        staffName={me.name}
        jobs={jobs}
        views={await viewStats(jobs.map((j) => j.id))}
        origin={origin}
        saved={saved}
        error={jobError}
      />
    );
  } catch (e) {
    jobsPanel = <ErrorBox error={e} />;
  }

  const likes = swipes.filter((s) => s.action === "like").length;
  const passes = swipes.filter((s) => s.action === "pass").length;
  const applied = swipes.filter((s) => s.application).length + appsWithoutSwipe.length;
  const counts: Record<string, number> = { all: swipes.length, like: likes, pass: passes, applied };

  const shown = swipes.filter((s) =>
    filter === "like" ? s.action === "like"
    : filter === "pass" ? s.action === "pass"
    : filter === "applied" ? !!s.application
    : true,
  );

  const profileDl = profile ? (
          <dl className="mt-5 grid gap-x-6 gap-y-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
            <Field label="希望職種">
              {profile.desiredJobType || <Chips items={profile.desiredJobTypeSmallCategories?.length ? profile.desiredJobTypeSmallCategories : profile.desiredJobTypeLargeCategories} />}
            </Field>
            <Field label="希望勤務地"><Chips items={profile.desiredLocations} /></Field>
            <Field label="希望年収 / 現年収">
              {profile.desiredSalary || "—"} <span className="text-slate-400">/</span> {profile.currentSalary || "—"}
            </Field>
            <Field label="希望業界"><Chips items={profile.desiredIndustries} /></Field>
            <Field label="希望の働き方"><Chips items={profile.desiredWorkStyle} /></Field>
            <Field label="スキル"><Chips items={profile.skills} /></Field>
            <Field label="職歴" wide>
              {profile.workHistory?.length ? (
                <ul className="list-disc space-y-0.5 pl-5">
                  {profile.workHistory.map((w, i) => (
                    <li key={i}>{typeof w === "string" ? w : JSON.stringify(w)}</li>
                  ))}
                </ul>
              ) : "—"}
            </Field>
            <Field label="書類" wide>
              <div className="flex flex-wrap gap-3">
                {profile.resumeFileUrl && <a className="text-indigo-700 hover:underline" href={profile.resumeFileUrl} target="_blank" rel="noreferrer">履歴書：{profile.resumeFileName ?? "開く"}</a>}
                {profile.cvFileUrl && <a className="text-indigo-700 hover:underline" href={profile.cvFileUrl} target="_blank" rel="noreferrer">職務経歴書：{profile.cvFileName ?? "開く"}</a>}
                {!profile.resumeFileUrl && !profile.cvFileUrl && "—"}
              </div>
            </Field>
          </dl>
  ) : null;

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-slate-500 hover:text-slate-900">← 候補者一覧</Link>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{user.name || "（名前未登録）"}</h1>
            <div className="mt-1 space-x-3 text-sm text-slate-600">
              <span>{user.email ?? "メール未登録"}</span>
              {user.phone && <a href={`tel:${user.phone}`} className="text-indigo-700 hover:underline">📞 {user.phone}</a>}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              登録 {formatJst(user.createdAt)} ・ ID {user.id}
              {(user.utmSource || user.lp) && ` ・ 流入 ${[user.utmSource, user.utmCampaign, user.lp].filter(Boolean).join(" / ")}`}
            </div>
          </div>
          <div className="flex gap-3 text-center">
            <Count label="Like" value={likes} tone="text-emerald-600" />
            <Count label="Pass" value={passes} tone="text-slate-500" />
            <Count label="応募" value={applied} tone="text-indigo-600" />
          </div>
        </div>

        {profileDl && (
          <>
            {/* PC はそのまま表示、スマホは折りたたみ */}
            <div className="hidden md:block">{profileDl}</div>
            <details className="mt-4 border-t border-slate-100 pt-3 md:hidden">
              <summary className="cursor-pointer text-sm font-semibold text-slate-600">プロフィール（希望条件・職歴・書類）を見る</summary>
              {profileDl}
            </details>
          </>
        )}
      </section>

      <nav className="sticky top-[57px] z-[5] -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((t) => {
          const n = t.key === "jobs" ? jobsCount : t.key === "swipes" ? swipes.length : null;
          return (
            <Link
              key={t.key}
              href={`?tab=${t.key}`}
              scroll={false}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${
                tab === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t.label}
              {n !== null && <span className="ml-1.5 tabular-nums opacity-70">{n}</span>}
            </Link>
          );
        })}
      </nav>

      {tab === "crm" && crmPanel}

      {tab === "jobs" && jobsPanel}

      {tab === "insights" && <InsightsPanel ins={ins} text={insightsText(candidateName, ins)} userId={userId} />}

      {tab === "swipes" && (
        <>
          {saved === "job" && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              ✓ 提案リストに追加しました（「📋 提案・選考」タブで確認できます）
            </div>
          )}
          {jobError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{jobError}</div>}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <h2 className="mr-2 font-semibold">スワイプ履歴</h2>
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`?tab=swipes&filter=${f.key}`}
              scroll={false}
              className={`rounded-full px-3 py-1 text-sm ${
                filter === f.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
            </Link>
          ))}
        </div>
        <ul className="divide-y divide-slate-100">
          {shown.map((s) => (
            <li key={s.id} className="flex items-stretch hover:bg-slate-50">
              <Link href={`/admin/jobs/${encodeURIComponent(s.jobId)}?from=${encodeURIComponent(user.id)}`} className="flex min-w-0 flex-1 items-start gap-4 px-4 py-3">
                <div className="w-16 shrink-0 pt-0.5"><ActionBadge action={s.action} /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">
                    {s.job?.title ?? <span className="text-slate-400">求人が見つかりません（{s.jobId}）</span>}
                  </div>
                  <div className="mt-0.5 text-sm text-slate-600">
                    {[s.job?.company, s.job?.location, s.job?.salary, s.job?.jobType].filter(Boolean).join(" ・ ")}
                  </div>
                  {s.application && (
                    <div className="mt-1.5">
                      <AppliedBadge status={s.application.status} />
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-slate-400">
                  <div>{formatJst(s.createdAt)}</div>
                  <div className="mt-0.5">{s.jobId}</div>
                </div>
              </Link>
              <div className="flex w-32 shrink-0 items-center justify-center pr-3">
                {!listedJobIds ? null : listedJobIds.has(s.jobId) ? (
                  <span className="text-xs text-emerald-700">✓ 提案リスト済</span>
                ) : s.job ? (
                  <form action={addSwipeJobForCandidate}>
                    <input type="hidden" name="userId" value={userId} />
                    <input type="hidden" name="jobId" value={s.jobId} />
                    <button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">＋ 提案リストへ</button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
          {shown.length === 0 && <li className="px-4 py-10 text-center text-slate-400">該当するスワイプはありません</li>}
        </ul>
      </section>

      {appsWithoutSwipe.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 p-3 font-semibold">スワイプ記録のない応募</h2>
          <ul className="divide-y divide-slate-100">
            {appsWithoutSwipe.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/jobs/${encodeURIComponent(a.jobId)}?from=${encodeURIComponent(user.id)}`} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50">
                  <AppliedBadge status={a.status} />
                  <span className="font-medium">{a.job?.title ?? a.jobId}</span>
                  <span className="text-sm text-slate-500">{a.job?.company}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
        </>
      )}
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-16 rounded-lg bg-slate-50 px-3 py-2">
      <div className={`text-xl font-bold tabular-nums ${tone}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}
