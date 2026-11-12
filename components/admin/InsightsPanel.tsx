import type { Insights } from "@/lib/insights";
import CopyButton from "@/components/admin/CopyButton";
import AiInsightButton from "@/components/admin/AiInsightButton";

export default function InsightsPanel({ ins, text, userId }: { ins: Insights; text: string; userId: string }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <h2 className="font-semibold">💡 Like / Pass から見える傾向</h2>
        <span className="text-sm text-slate-500">Like {ins.likes} 件 / Pass {ins.passes} 件</span>
        <div className="ml-auto"><CopyButton text={text} label="メモとしてコピー" /></div>
      </div>
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          {!ins.enough && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">スワイプがまだ少ないので、傾向は参考程度にしてください。</p>
          )}
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-800">
            {ins.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          {ins.search.length > 0 && (
            <div className="rounded-lg bg-indigo-50 p-3">
              <div className="mb-1.5 text-xs font-semibold text-indigo-800">他の求人を探すときの条件案</div>
              <dl className="space-y-1 text-sm">
                {ins.search.map((g) => (
                  <div key={g.label} className="flex gap-2">
                    <dt className="w-16 shrink-0 text-indigo-700">{g.label}</dt>
                    <dd className="text-slate-800">{g.values.join(" / ")}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FeatureList title="Like に多い特徴" items={ins.liked} tone="text-emerald-700" empty="まだ目立つ特徴はありません" />
          <FeatureList title="Pass に多い特徴" items={ins.avoided} tone="text-rose-700" empty="目立つ特徴はありません" />
        </div>
      </div>
      <AiInsightButton userId={userId} />
    </section>
  );
}

function FeatureList({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: { group: string; value: string; like: number; pass: number }[];
  tone: string;
  empty: string;
}) {
  return (
    <div>
      <div className={`mb-2 text-xs font-semibold ${tone}`}>{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((f) => (
            <li key={f.group + f.value} className="text-sm">
              <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{f.group}</span>
              {f.value}
              <span className="ml-1.5 text-xs tabular-nums text-slate-400">♥{f.like} ✕{f.pass}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
