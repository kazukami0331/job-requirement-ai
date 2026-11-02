import { dispatch } from "@/lib/adops/github";
import { loadFeedback, loadHypotheses, loadJobs, loadPersonas, loadPolicy, loadState, submitFeedback } from "@/lib/adops/config";
import { FeedbackStatus } from "@/components/admin/feedback";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { Badge, Button, Card, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

const ID = /^[a-z0-9-]{3,80}$/;

async function decide(form: FormData) {
  "use server";
  await requireAdmin();
  const id = String(form.get("id") ?? "");
  const op = String(form.get("op") ?? "");
  await act("/admin/lp", op === "approve" ? `${id} の公開を開始しました。数分で反映されます` : `${id} の取り下げを開始しました。数分で反映されます`, async () => {
    if (!ID.test(id) || (op !== "approve" && op !== "retire")) throw new Error("操作が正しくありません");
    await dispatch(op === "approve" ? { lp_approve: id } : { lp_retire: id });
  });
}

async function reviseLp(form: FormData) {
  "use server";
  await requireAdmin();
  const id = String(form.get("id") ?? "");
  const note = String(form.get("note") ?? "").trim();
  await act("/admin/lp", "修正の依頼を受け付けました。数分で修正した下書きがここに並びます", async () => {
    if (!ID.test(id)) throw new Error("操作が正しくありません");
    if (!note) throw new Error("どう直してほしいかを書いてください");
    await submitFeedback({ target: "lp", targetId: id, action: "revise", note });
  });
}

function ReviseForm({ id }: { id: string }) {
  return (
    <details className="mt-3 rounded-lg border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-semibold">修正を依頼する</summary>
      <form action={reviseLp} className="mt-3">
        <input type="hidden" name="id" value={id} />
        <textarea name="note" rows={3} required placeholder="例: 最初に寮の写真や設備の話を出して。よくある質問に「家族と住めるか」を入れて" className={inputCls} />
        <div className="mt-2">
          <Button variant="secondary">この内容で直してもらう</Button>
        </div>
      </form>
    </details>
  );
}

async function createNow() {
  "use server";
  await requireAdmin();
  await act("/admin/lp", "LP の作成を開始しました。数分で下書きがここに並びます", () => dispatch({ steps: "lp,report" }));
}

function publicUrl(id: string): string {
  const base = (process.env.ADOPS_LP_BASE_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/${id}` : `/lp/${id}`;
}

export default async function LpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [state, jobs, personas, hyps, policy, feedback] = await Promise.all([loadState(), loadJobs(), loadPersonas(), loadHypotheses(), loadPolicy(), loadFeedback()]);
  const lps = Object.values(state.lps ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = (id: string) => jobs.value.find((j) => j.id === id)?.title ?? id;
  const persona = (id: string) => personas.value.find((p) => p.id === id)?.name ?? id;
  const hyp = (id?: string) => (id ? hyps.value.find((h) => h.id === id)?.title : undefined);
  const drafts = lps.filter((l) => l.status === "draft");
  const live = lps.filter((l) => l.status === "live");
  const ended = lps.filter((l) => l.status === "retired" || l.status === "rejected").slice(0, 10);
  return (
    <>
      <PageTitle sub="AI が求人×ペルソナ×仮説ごとに作った応募ページです。給与・勤務地などは求人情報からそのまま表示されます。中身を見て、良ければ公開してください。">
        応募ページ（LP）
      </PageTitle>
      <Notice {...n} />
      {!policy.value?.lp?.enabled ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">LP の自動作成はオフです（基本設定でオンにできます）。</div>
      ) : null}
      <Card
        title={`確認待ちの下書き（${drafts.length}）`}
        actions={
          <form action={createNow}>
            <Button variant="secondary">今すぐ作る</Button>
          </form>
        }
      >
        {drafts.length === 0 ? <p className="text-sm text-slate-600">確認待ちの下書きはありません。</p> : null}
        <div className="space-y-8">
          {drafts.map((l) => (
            <div key={l.id} className="grid gap-4 md:grid-cols-[320px_1fr]">
              <iframe src={`/admin/lp-preview/${l.id}`} title={l.id} className="h-[560px] w-full rounded-lg border border-slate-200 bg-white" />
              <div className="text-sm">
                <p className="mb-1 text-lg font-semibold">{l.copy.heroTitle}</p>
                <p className="mb-3 text-slate-600">{l.copy.heroSub}</p>
                <dl className="mb-4 grid grid-cols-[6em_1fr] gap-y-1">
                  <dt className="text-slate-500">求人</dt>
                  <dd>{job(l.jobId)}</dd>
                  <dt className="text-slate-500">ペルソナ</dt>
                  <dd>{persona(l.personaId)}</dd>
                  <dt className="text-slate-500">仮説</dt>
                  <dd>{hyp(l.hypothesisId) ?? "（なし）"}</dd>
                  <dt className="text-slate-500">ID</dt>
                  <dd className="font-mono">{l.id}</dd>
                </dl>
                <div className="flex flex-wrap gap-3">
                  <form action={decide}>
                    <input type="hidden" name="id" value={l.id} />
                    <input type="hidden" name="op" value="approve" />
                    <Button>公開する</Button>
                  </form>
                  <form action={decide}>
                    <input type="hidden" name="id" value={l.id} />
                    <input type="hidden" name="op" value="retire" />
                    <Button variant="secondary">使わない</Button>
                  </form>
                </div>
                <p className="mt-3 text-xs text-slate-500">公開先: {publicUrl(l.id)}（広告の飛び先にするなら、求人の「広告の飛び先」をこの URL に変えてください）</p>
                <ReviseForm id={l.id} />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title={`公開中（${live.length}）`}>
        {live.length === 0 ? (
          <p className="text-sm text-slate-600">公開中の LP はありません。</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {live.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                <Badge tone="green">公開中</Badge>
                <a href={publicUrl(l.id)} target="_blank" rel="noreferrer" className="font-semibold text-blue-800 hover:underline">
                  {l.copy.heroTitle}
                </a>
                <span className="text-slate-600">
                  {job(l.jobId)}・{persona(l.personaId)}
                </span>
                <form action={decide} className="ml-auto">
                  <input type="hidden" name="id" value={l.id} />
                  <input type="hidden" name="op" value="retire" />
                  <Button variant="secondary">公開をやめる</Button>
                </form>
                <div className="w-full">
                  <ReviseForm id={l.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="修正の依頼の状況">
        <FeedbackStatus items={feedback.value.filter((f) => f.target === "lp")} state={state} label={(f) => state.lps?.[f.targetId]?.copy.heroTitle ?? f.targetId} />
      </Card>
      {ended.length ? (
        <Card title="終了・却下（最近の10件）">
          <ul className="divide-y divide-slate-100 text-sm">
            {ended.map((l) => (
              <li key={l.id} className="py-2">
                <Badge tone={l.status === "rejected" ? "red" : "slate"}>{l.status === "rejected" ? "却下" : "終了"}</Badge> <span className="ml-2">{l.copy.heroTitle}</span>
                <span className="ml-2 text-xs text-slate-500">{l.statusReason}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
