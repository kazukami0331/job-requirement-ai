/** AI への依頼の状況（処理待ち・反映済み・できなかった理由）。 */
import type { FeedbackRequest, StateView } from "@/lib/adops/types";
import { Badge } from "./ui";

const ACTION: Record<FeedbackRequest["action"], string> = { approve: "採用", reject: "却下", revise: "修正", variant: "文言違い" };

export function FeedbackStatus({ items, state, label }: { items: FeedbackRequest[]; state: StateView; label: (f: FeedbackRequest) => string }) {
  if (!items.length) return <p className="text-sm text-slate-600">依頼はまだありません。</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {[...items]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 20)
        .map((f) => {
          const d = state.feedbackDone?.[f.id];
          return (
            <li key={f.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={!d ? "amber" : d.ok ? "green" : "red"}>{!d ? "処理待ち" : d.ok ? "反映済み" : "できませんでした"}</Badge>
                <span className="font-medium">
                  {ACTION[f.action]}: {label(f)}
                </span>
                <span className="text-xs text-slate-500">{new Date(f.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</span>
              </div>
              {f.note ? <p className="mt-1 text-slate-700">「{f.note}」</p> : null}
              {d ? <p className={`mt-1 text-xs ${d.ok ? "text-slate-500" : "text-red-700"}`}>{d.result}</p> : null}
            </li>
          );
        })}
    </ul>
  );
}
