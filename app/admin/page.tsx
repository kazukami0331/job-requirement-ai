import { listCandidates, scopeStartLabel } from "@/lib/swipeAdmin";
import { crmSummaries, CrmNotReadyError, type CandidateCrmSummary } from "@/lib/crm";
import { listStaff, requireStaff, type Staff } from "@/lib/auth";
import { ErrorBox } from "@/components/admin/ui";
import CandidateTable from "@/components/admin/CandidateTable";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const me = await requireStaff();
  let rows;
  let crm = new Map<string, CandidateCrmSummary>();
  let staff: Staff[] = [];
  let crmError: unknown = null;
  try {
    rows = await listCandidates();
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  try {
    [crm, staff] = await Promise.all([crmSummaries(), listStaff()]);
  } catch (e) {
    crmError = e instanceof CrmNotReadyError ? e : e;
  }

  const merged = rows.map((r) => {
    const c = crm.get(r.id);
    return {
      ...r,
      status: c?.status ?? "new",
      assigneeId: c?.assigneeId ?? null,
      calls: c?.calls ?? 0,
      lastContactAt: c?.lastContactAt ?? null,
    };
  });

  const totalLikes = rows.reduce((n, r) => n + r.likes, 0);
  const uncalled = merged.filter((r) => r.calls === 0 && r.status === "new").length;
  const mine = merged.filter((r) => r.assigneeId === me.id).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">候補者</h1>
        <p className="mt-1 text-sm text-slate-500">
          {scopeStartLabel()} 以降に登録した人だけを表示しています。名前を押すと、ステータス変更・架電記録・スワイプ履歴が見られます。
        </p>
      </div>
      {crmError ? <ErrorBox error={crmError} /> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="登録ユーザー" value={rows.length} />
        <Stat label="まだ架電していない" value={uncalled} tone="text-rose-600" />
        <Stat label="自分の担当" value={mine} tone="text-indigo-600" />
        <Stat label="Like 合計" value={totalLikes} tone="text-emerald-600" />
      </div>
      <CandidateTable
        rows={merged}
        staff={staff.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
        meId={me.id}
      />
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{value.toLocaleString()}</div>
    </div>
  );
}
