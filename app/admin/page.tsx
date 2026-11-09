import { listCandidates } from "@/lib/swipeAdmin";
import { ErrorBox } from "@/components/admin/ui";
import CandidateTable from "@/components/admin/CandidateTable";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  let rows;
  try {
    rows = await listCandidates();
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  const totalLikes = rows.reduce((n, r) => n + r.likes, 0);
  const totalPasses = rows.reduce((n, r) => n + r.passes, 0);
  const swiped = rows.filter((r) => r.likes + r.passes > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">候補者一覧</h1>
        <p className="mt-1 text-sm text-slate-500">名前を押すと、その人のスワイプ履歴と求人の詳細が見られます。</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="登録ユーザー" value={rows.length} />
        <Stat label="スワイプした人" value={swiped} />
        <Stat label="Like 合計" value={totalLikes} tone="text-emerald-600" />
        <Stat label="Pass 合計" value={totalPasses} tone="text-slate-500" />
      </div>
      <CandidateTable rows={rows} />
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
