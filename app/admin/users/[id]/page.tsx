import Link from "next/link";
import { notFound } from "next/navigation";
import { formatJst, getCandidate } from "@/lib/swipeAdmin";
import { ActionBadge, AppliedBadge, Chips, ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ filter?: string }>;
}) {
  const { id } = await params;
  const { filter = "all" } = await searchParams;
  const userId = decodeURIComponent(id);

  let data;
  try {
    data = await getCandidate(userId);
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  if (!data) notFound();
  const { user, profile, swipes, appsWithoutSwipe } = data;

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

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-slate-500 hover:text-slate-900">← 候補者一覧</Link>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{user.name || "（名前未登録）"}</h1>
            <div className="mt-1 space-x-3 text-sm text-slate-600">
              <span>{user.email ?? "メール未登録"}</span>
              {user.phone && <span>{user.phone}</span>}
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

        {profile && (
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
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <h2 className="mr-2 font-semibold">スワイプ履歴</h2>
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`?filter=${f.key}`}
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
            <li key={s.id}>
              <Link href={`/admin/jobs/${encodeURIComponent(s.jobId)}?from=${encodeURIComponent(user.id)}`} className="flex items-start gap-4 px-4 py-3 hover:bg-slate-50">
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
