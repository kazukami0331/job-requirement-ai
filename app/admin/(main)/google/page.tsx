import { loadFeedback, loadJobs, loadState, submitFeedback } from "@/lib/adops/config";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { Button, Card, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";
import { FeedbackStatus } from "@/components/admin/feedback";

async function revise(form: FormData) {
  "use server";
  await requireAdmin();
  const jobId = String(form.get("jobId") ?? "");
  const note = String(form.get("note") ?? "").trim();
  await act("/admin/google", "修正の依頼を受け付けました。数分で反映されます", async () => {
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(jobId)) throw new Error("操作が正しくありません");
    if (!note) throw new Error("どう直してほしいかを書いてください");
    await submitFeedback({ target: "google", targetId: jobId, action: "revise", note });
  });
}

export default async function GooglePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [state, jobs, feedback] = await Promise.all([loadState(), loadJobs(), loadFeedback()]);
  const active = jobs.value.filter((j) => j.active);
  return (
    <>
      <PageTitle
        sub={
          <>
            稼働中の求人ごとの Google 検索広告（レスポンシブ検索広告）の見出し・説明文です。文字数と法令チェックに通ったものだけ並んでいます。
            <a href="/admin/export/google-rsa.csv" className="ml-1 text-blue-700 underline">
              Google 広告エディタ用の CSV をダウンロード
            </a>
          </>
        }
      >
        Google 検索広告のテキスト
      </PageTitle>
      <Notice {...n} />
      {active.map((j) => {
        const t = state.googleTexts?.[j.id];
        return (
          <Card key={j.id} title={j.title}>
            {!t ? (
              <p className="text-sm text-slate-600">まだ作られていません（次の定期実行で作ります）。</p>
            ) : (
              <div className="grid gap-4 text-sm md:grid-cols-2">
                <div>
                  <p className="mb-1 font-semibold">見出し（{t.headlines.length}）</p>
                  <ol className="list-decimal pl-5">
                    {t.headlines.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="mb-1 font-semibold">説明文（{t.descriptions.length}）</p>
                  <ol className="list-decimal space-y-1 pl-5">
                    {t.descriptions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ol>
                  <p className="mt-2 text-slate-600">
                    パス: /{t.path1}/{t.path2}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">作成日 {t.createdOn}</p>
                </div>
              </div>
            )}
            <details className="mt-4 rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold">{t ? "修正を依頼する" : "今すぐ作る（依頼を書いて作る）"}</summary>
              <form action={revise} className="mt-3">
                <input type="hidden" name="jobId" value={j.id} />
                <textarea name="note" rows={2} required placeholder="例: 「寮付き」「日払い」を見出しの前の方に。勤務地の駅名も入れて" className={inputCls} />
                <div className="mt-2">
                  <Button variant="secondary">この内容で作り直してもらう</Button>
                </div>
              </form>
            </details>
          </Card>
        );
      })}
      <Card title="修正の依頼の状況">
        <FeedbackStatus items={feedback.value.filter((f) => f.target === "google")} state={state} label={(f) => jobs.value.find((j) => j.id === f.targetId)?.title ?? f.targetId} />
      </Card>
    </>
  );
}
