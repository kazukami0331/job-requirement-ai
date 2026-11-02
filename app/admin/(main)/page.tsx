import { dispatch } from "@/lib/adops/github";
import { loadJobs, loadState, type Loaded } from "@/lib/adops/config";
import type { Job, StateView } from "@/lib/adops/types";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { Badge, Button, Card, Notice, PageTitle, notices } from "@/components/admin/ui";
import Link from "next/link";

async function runNow() {
  "use server";
  await requireAdmin();
  await act("/admin", "実行を開始しました。数分〜数十分で Slack に結果が届きます", () => dispatch({}));
}

async function emergency(form: FormData) {
  "use server";
  await requireAdmin();
  const control = String(form.get("control"));
  if (control !== "stop" && control !== "resume") return;
  await act("/admin", control === "stop" ? "緊急停止を開始しました。数分で adops の広告がすべて止まります" : "緊急停止の解除を開始しました", async () => {
    if (control === "stop" && form.get("confirm") !== "yes") throw new Error("緊急停止するには「本当に止める」にチェックしてください");
    await dispatch({ control });
  });
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  let error = n.error;
  const [state, jobs] = await Promise.all([loadState(), loadJobs()]).catch((e): [StateView, Loaded<Job[]>] => {
    error = error ?? (e as Error).message;
    return [{}, { value: [] }];
  });
  const creatives = Object.values(state.creatives ?? {});
  const live = creatives.filter((c) => c.status === "published").length;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const m = creatives.flatMap((c) => (c.metrics ?? []).filter((x) => x.date >= since));
  const spend = m.reduce((a, x) => a + x.spend, 0);
  const conv = m.reduce((a, x) => a + x.conversions, 0);
  const lps = Object.values(state.lps ?? {});
  const drafts = lps.filter((l) => l.status === "draft").length;
  const toSelect = creatives.filter((c) => (c.status === "produced" && !c.humanApproved) || c.status === "qa_failed").length;
  const last = state.cycles?.at(-1);
  return (
    <>
      <PageTitle sub="設定の変更は次の定期実行（毎朝6時）から反映されます。">ホーム</PageTitle>
      <Notice ok={n.ok} error={error} />
      {state.halted ? (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <b>緊急停止中</b>（{state.halted.reason}）。企画・入稿を止めています。
        </div>
      ) : null}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["配信中の広告", `${live} 本`],
          ["直近7日の広告費", `${Math.round(spend).toLocaleString()} 円`],
          ["直近7日の応募", `${conv} 件`],
          ["稼働中の求人", `${jobs.value.filter((j) => j.active).length} 件`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">{k}</div>
            <div className="mt-1 text-xl font-bold">{v}</div>
          </div>
        ))}
      </div>
      {drafts || toSelect ? (
        <Card title="確認待ち">
          {toSelect ? (
            <p className="mb-1 text-sm">
              完成した広告が <b>{toSelect} 本</b> あります。<Link href="/admin/creatives" className="text-blue-700 underline">確認して採用・修正を依頼する</Link>
            </p>
          ) : null}
          {drafts ? (
            <p className="text-sm">
              応募ページ（LP）の下書きが <b>{drafts} 本</b> あります。<Link href="/admin/lp" className="text-blue-700 underline">確認して公開する</Link>
            </p>
          ) : null}
        </Card>
      ) : null}
      <Card title="前回の実行">
        {last ? (
          <div className="text-sm">
            <p className="mb-2 text-slate-600">{new Date(last.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
            <div className="flex flex-wrap gap-2">
              {last.steps.map((s) => (
                <Badge key={s.name} tone={s.ok ? "green" : "red"}>
                  {s.name} {s.ok ? "OK" : "失敗"}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">まだ一度も実行されていません。</p>
        )}
      </Card>
      <Card title="操作">
        <div className="flex flex-wrap items-start gap-6">
          <form action={runNow}>
            <Button variant="secondary">今すぐ1回実行する</Button>
            <p className="mt-1 text-xs text-slate-500">企画〜入稿〜レポートまで（試運転中は入稿しません）</p>
          </form>
          {state.halted ? (
            <form action={emergency}>
              <input type="hidden" name="control" value="resume" />
              <Button>緊急停止を解除する</Button>
            </form>
          ) : (
            <form action={emergency}>
              <input type="hidden" name="control" value="stop" />
              <label className="mb-2 flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm" value="yes" /> 本当に止める
              </label>
              <Button variant="danger">緊急停止（すべての広告を止める）</Button>
            </form>
          )}
        </div>
      </Card>
    </>
  );
}
