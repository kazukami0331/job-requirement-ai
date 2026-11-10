import { listCandidates, scopeStartLabel } from "@/lib/swipeAdmin";
import { crmSummaries, CrmNotReadyError, type CandidateCrmSummary } from "@/lib/crm";
import { listStaff, requireStaff, type Staff } from "@/lib/auth";
import { ErrorBox } from "@/components/admin/ui";
import CandidateTable from "@/components/admin/CandidateTable";

const SELECTION = ["applied", "before_interview", "awaiting_result"];

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
  const totalPasses = rows.reduce((n, r) => n + r.passes, 0);
  const untouched = merged.filter((r) => r.status === "new").length;
  const inSelection = merged.filter((r) => SELECTION.includes(r.status)).length;

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
        <Stat label="ユーザー数" value={rows.length.toLocaleString()} />
        <Stat label="登録後 未対応" value={untouched.toLocaleString()} tone="text-rose-600" note="ステータスが「登録・連絡中」のまま" />
        <Stat label="選考中" value={inSelection.toLocaleString()} tone="text-indigo-600" note="書類選考中〜面接結果待ち" />
        <Stat
          label="Like / Pass"
          value={
            <>
              <span className="text-emerald-600">{totalLikes.toLocaleString()}</span>
              <span className="mx-1 text-slate-300">/</span>
              <span className="text-slate-500">{totalPasses.toLocaleString()}</span>
            </>
          }
          note={totalLikes + totalPasses ? `Like 率 ${Math.round((totalLikes / (totalLikes + totalPasses)) * 100)}%` : undefined}
        />
      </div>
      <CandidateTable
        rows={merged}
        staff={staff.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
        meId={me.id}
      />
    </div>
  );
}

function Stat({ label, value, tone = "", note }: { label: string; value: React.ReactNode; tone?: string; note?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{value}</div>
      {note && <div className="mt-0.5 text-xs text-slate-400">{note}</div>}
    </div>
  );
}
