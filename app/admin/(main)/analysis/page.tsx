import { loadHypotheses, loadRubric, loadState } from "@/lib/adops/config";
import { groupBy, rubricCalibration, type Row } from "@/lib/adops/analysis";
import { ANGLE_LABELS, type CreativeView } from "@/lib/adops/types";
import { Card, PageTitle } from "@/components/admin/ui";

const MOTIF: Record<string, string> = { real_person: "実写の人物", illustration: "イラスト", character: "キャラクター", scene_only: "人物なしの情景", object: "物" };
const TASTE: Record<string, string> = { bright: "明るい", calm: "落ち着いた", energetic: "活気", warm: "あたたかい", premium: "上質", documentary: "ドキュメンタリー風" };
const TONE: Record<string, string> = { empathy: "共感", benefit: "メリット直球", question: "問いかけ", number: "数字", urgency: "急ぎ", story: "ストーリー" };
const LAYOUT: Record<string, string> = { band: "帯", card: "カード", bold: "給与ドン" };
const MIN_IMP = 1000;

function Table({ rows, label = (k: string) => k }: { rows: Row[]; label?: (k: string) => string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">まだ配信の結果がありません。</p>;
  const best = Math.max(...rows.filter((r) => r.impressions >= MIN_IMP).map((r) => r.cvr), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            <th className="py-2 pr-3">値</th>
            <th className="py-2 pr-3 text-right">広告</th>
            <th className="py-2 pr-3 text-right">表示</th>
            <th className="py-2 pr-3 text-right">クリック率</th>
            <th className="py-2 pr-3 text-right">応募率</th>
            <th className="py-2 pr-3 text-right">応募</th>
            <th className="py-2 text-right">応募単価</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={`border-b border-slate-100 ${r.impressions < MIN_IMP ? "text-slate-400" : ""}`}>
              <td className="py-2 pr-3">
                {label(r.key)}
                {r.impressions >= MIN_IMP && r.cvr === best && best > 0 ? <span className="ml-2 text-xs font-semibold text-emerald-700">最良</span> : null}
              </td>
              <td className="py-2 pr-3 text-right">{r.ads}</td>
              <td className="py-2 pr-3 text-right">{r.impressions.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right">{r.ctr.toFixed(2)}%</td>
              <td className="py-2 pr-3 text-right">{r.cvr.toFixed(1)}%</td>
              <td className="py-2 pr-3 text-right">{r.conversions}</td>
              <td className="py-2 text-right">{r.cpa === null ? "-" : `${Math.round(r.cpa).toLocaleString()}円`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-slate-400">灰色は表示 {MIN_IMP.toLocaleString()} 回未満（まだ判断できない）。応募率はクリックあたり。</p>
    </div>
  );
}

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const days = [7, 28, 90].includes(Number(sp.days)) ? Number(sp.days) : 28;
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [state, hyps, rubric] = await Promise.all([loadState(), loadHypotheses(), loadRubric()]);
  const cs = Object.values(state.creatives ?? {});
  const el = (c: CreativeView) => state.briefs?.[c.briefId]?.elements;
  const items = rubric.value?.items ?? [];
  const totalBand = (s: number) => (s < 70 ? "69点以下" : s < 85 ? "70〜84点" : "85点以上");
  return (
    <>
      <PageTitle
        sub={
          <>
            直近 {days} 日の配信結果を、要素ごと・採点ごとに集計しています。
            {[7, 28, 90].map((d) => (
              <a key={d} href={`/admin/analysis?days=${d}`} className={`ml-2 ${d === days ? "font-bold text-slate-900" : "text-blue-700 underline"}`}>
                {d}日
              </a>
            ))}
            <a href="/admin/export/creatives.csv" className="ml-3 text-blue-700 underline">
              広告ごとの表（CSV）をダウンロード
            </a>
          </>
        }
      >
        分析
      </PageTitle>
      <Card title="仮説別">
        <Table rows={groupBy(cs, (c) => c.hypothesisId ?? "（仮説なし）", since)} label={(k) => hyps.value.find((h) => h.id === k)?.title ?? k} />
      </Card>
      <Card title="訴求軸別">
        <Table rows={groupBy(cs, (c) => c.angle, since)} label={(k) => ANGLE_LABELS[k as keyof typeof ANGLE_LABELS] ?? k} />
      </Card>
      <div className="grid gap-x-6 md:grid-cols-2">
        <Card title="モチーフ別">
          <Table rows={groupBy(cs, (c) => el(c)?.motif, since)} label={(k) => MOTIF[k] ?? k} />
        </Card>
        <Card title="テイスト別">
          <Table rows={groupBy(cs, (c) => el(c)?.taste, since)} label={(k) => TASTE[k] ?? k} />
        </Card>
        <Card title="コピーの型別">
          <Table rows={groupBy(cs, (c) => el(c)?.copyTone, since)} label={(k) => TONE[k] ?? k} />
        </Card>
        <Card title="文字のレイアウト別">
          <Table rows={groupBy(cs, (c) => c.layout, since)} label={(k) => LAYOUT[k] ?? k} />
        </Card>
      </div>
      <Card title="採点は当たっているか（合計点の帯別）">
        <p className="mb-3 text-xs text-slate-500">点が高い帯ほど応募率が高ければ、採点基準は実際の反応と合っています。逆なら基準を見直してください。</p>
        <Table rows={groupBy(cs, (c) => (c.review ? totalBand(c.review.score) : undefined), since).sort((a, b) => a.key.localeCompare(b.key))} />
      </Card>
      {items.length ? (
        <Card title="採点の項目ごと（点数の帯別）">
          <p className="mb-3 text-xs text-slate-500">高い点の帯が良い結果になっていない項目は、説明や点数の目安を直すか、重みを下げる候補です。</p>
          {rubricCalibration(cs, items.map((i) => i.id), since).map(({ id, rows }) => (
            <div key={id} className="mb-5">
              <p className="mb-1 text-sm font-semibold">{items.find((i) => i.id === id)?.label ?? id}</p>
              <Table rows={rows} />
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}
