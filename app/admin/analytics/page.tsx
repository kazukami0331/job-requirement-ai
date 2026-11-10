import { listStaff, requireStaff } from "@/lib/auth";
import { computeAnalytics } from "@/lib/crm";
import { scopeStartLabel } from "@/lib/swipeAdmin";
import { StaffChip } from "@/components/admin/bits";
import { ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");

function hours(h: number | null) {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} 分`;
  if (h < 48) return `${Math.round(h * 10) / 10} 時間`;
  return `${Math.round((h / 24) * 10) / 10} 日`;
}
const days = (d: number | null) => (d === null ? "—" : `${Math.round(d * 10) / 10} 日`);

export default async function AnalyticsPage() {
  await requireStaff();
  let data;
  let staff;
  try {
    staff = await listStaff();
    data = await computeAnalytics(staff);
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const appliedStage = data.funnel.find((f) => f.key === "applied")?.count ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">分析</h1>
        <p className="mt-1 text-sm text-slate-500">
          {scopeStartLabel()} 以降に登録した人が対象です。時刻はすべて日本時間です。
        </p>
      </div>

      <Card title="スワイプ">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Like / Pass" value={`${data.swipe.likes} / ${data.swipe.passes}`} sub={`Like 率 ${pct(data.swipe.likes, data.swipe.likes + data.swipe.passes)}`} />
          <Kpi label="スワイプした人" value={`${data.swipe.users} 人`} sub={pct(data.swipe.users, data.registered) + "（登録のうち）"} />
          <Kpi label="1 人あたりスワイプ数" value={data.swipe.users ? `${Math.round(((data.swipe.likes + data.swipe.passes) / data.swipe.users) * 10) / 10} 枚` : "—"} sub="スワイプした人の平均" />
          <Kpi label="1 件以上 Like した人" value={`${data.swipe.likedUsers} 人`} sub={pct(data.swipe.likedUsers, data.swipe.users) + "（スワイプした人のうち）"} />
        </div>
      </Card>

      <h2 className="pt-2 text-lg font-bold">架電・対応</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="登録" value={`${data.registered} 人`} />
        <Kpi label="架電した人" value={`${data.calledPeople} 人`} sub={pct(data.calledPeople, data.registered)} />
        <Kpi label="登録→初回架電（中央値）" value={hours(data.firstCallLeadHoursMedian)} />
        <Kpi
          label="つながるまでの架電回数（平均）"
          value={data.callsUntilConnectAvg === null ? "—" : `${Math.round(data.callsUntilConnectAvg * 10) / 10} 回`}
        />
        <Kpi label="架電の接続率" value={pct(data.totalConnected, data.totalCalls)} sub={`${data.totalConnected} / ${data.totalCalls} 件`} />
        <Kpi label="つながった人" value={`${data.connectedPeople} 人`} sub={pct(data.connectedPeople, data.calledPeople) + "（架電した人のうち）"} />
        <Kpi label="応募段階まで進んだ人" value={`${appliedStage} 人`} sub={pct(appliedStage, data.registered) + "（登録のうち）"} />
        <Kpi label="SwipeJob 上で応募した人" value={`${data.swipeApplied} 人`} sub={pct(data.swipeApplied, data.registered)} />
      </div>

      <Card title="ステータス別の到達人数" note="その段階まで一度でも進んだ人数。日数は登録からその段階に変えるまでの中央値です。">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-2 font-medium">ステータス</th>
              <th className="py-2 text-right font-medium">人数</th>
              <th className="py-2 text-right font-medium">登録比</th>
              <th className="py-2 text-right font-medium">前の段階から</th>
              <th className="py-2 text-right font-medium">登録からの日数</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.funnel.map((f, i) => (
              <tr key={f.key}>
                <td className="py-2">{f.label}</td>
                <td className="py-2 text-right font-semibold tabular-nums">{f.count}</td>
                <td className="py-2 text-right tabular-nums text-slate-600">{pct(f.count, data.registered)}</td>
                <td className="py-2 text-right tabular-nums text-slate-600">{i === 0 ? "—" : pct(f.count, data.funnel[i - 1].count)}</td>
                <td className="py-2 text-right tabular-nums text-slate-600">{i === 0 ? "—" : days(f.leadDaysMedian)}</td>
              </tr>
            ))}
            <tr>
              <td className="py-2 text-rose-700">見送り・辞退（現在）</td>
              <td className="py-2 text-right font-semibold tabular-nums">{data.closed}</td>
              <td className="py-2 text-right tabular-nums text-slate-600">{pct(data.closed, data.registered)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title="担当者別">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-2 font-medium">担当</th>
                <th className="py-2 text-right font-medium">担当人数</th>
                <th className="py-2 text-right font-medium">架電数</th>
                <th className="py-2 text-right font-medium">接続率</th>
                <th className="py-2 text-right font-medium">初回架電まで</th>
                <th className="py-2 text-right font-medium">応募段階</th>
                <th className="py-2 text-right font-medium">内定</th>
                <th className="py-2 text-right font-medium">内定承諾</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.perStaff.map((p) => (
                <tr key={p.staffId ?? "none"}>
                  <td className="py-2 whitespace-nowrap"><StaffChip staff={p.staffId ? staffById.get(p.staffId) : null} /></td>
                  <td className="py-2 text-right tabular-nums">{p.candidates}</td>
                  <td className="py-2 text-right tabular-nums">{p.calls}</td>
                  <td className="py-2 text-right tabular-nums">{pct(p.connected, p.calls)}</td>
                  <td className="py-2 text-right tabular-nums">{hours(p.firstCallLeadHoursMedian)}</td>
                  <td className="py-2 text-right tabular-nums">{p.applied} <span className="text-xs text-slate-400">{pct(p.applied, p.candidates)}</span></td>
                  <td className="py-2 text-right tabular-nums">{p.offered}</td>
                  <td className="py-2 text-right tabular-nums">{p.accepted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-400">担当人数・応募・内定は「担当者」ごと、架電数・接続率は「架電した人」ごとに数えています。</p>
      </Card>

      <Card title="時間帯別の接続率" note="何時にかけるとつながりやすいか。">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-2 font-medium">時間帯</th>
              <th className="py-2 text-right font-medium">架電数</th>
              <th className="py-2 text-right font-medium">つながった</th>
              <th className="py-2 text-right font-medium">接続率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.bands.map((b) => (
              <tr key={b.label}>
                <td className="py-2">{b.label}</td>
                <td className="py-2 text-right tabular-nums">{b.calls}</td>
                <td className="py-2 text-right tabular-nums">{b.connected}</td>
                <td className="py-2 text-right font-semibold tabular-nums">{pct(b.connected, b.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-slate-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
