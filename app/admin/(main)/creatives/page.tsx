import { loadFeedback, loadHypotheses, loadJobs, loadPersonas, loadPolicy, loadRubric, loadState, submitFeedback } from "@/lib/adops/config";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { assetUrl } from "@/lib/adops/assets";
import { ANGLE_LABELS, type BriefView, type CreativeView } from "@/lib/adops/types";
import { Badge, Button, Card, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";
import { FeedbackStatus } from "@/components/admin/feedback";

const ID = /^cr_[\w-]+$/;

async function request(form: FormData) {
  "use server";
  await requireAdmin();
  const id = String(form.get("id") ?? "");
  const action = String(form.get("action") ?? "");
  const note = String(form.get("note") ?? "").trim();
  const scope = String(form.get("scope") ?? "copy");
  const label: Record<string, string> = { approve: "採用", reject: "却下", revise: "修正の依頼", variant: "文言違いの依頼" };
  await act("/admin/creatives", `${label[action] ?? "依頼"}を受け付けました。数分で反映されます（処理の状況は下の「依頼の状況」）`, async () => {
    if (!ID.test(id) || !["approve", "reject", "revise", "variant"].includes(action)) throw new Error("操作が正しくありません");
    if ((action === "revise" || action === "variant") && !note) throw new Error("どう直してほしいかを書いてください");
    await submitFeedback({
      target: "creative",
      targetId: id,
      action: action as "approve" | "reject" | "revise" | "variant",
      ...(note ? { note } : {}),
      ...(action === "revise" && ["copy", "image", "both"].includes(scope) ? { scope: scope as "copy" | "image" | "both" } : {}),
    });
  });
}

const MOTIF: Record<string, string> = { real_person: "実写の人物", illustration: "イラスト", character: "キャラクター", scene_only: "人物なし", object: "物" };
const TASTE: Record<string, string> = { bright: "明るい", calm: "落ち着いた", energetic: "活気", warm: "あたたかい", premium: "上質", documentary: "ドキュメンタリー風" };
const TONE: Record<string, string> = { empathy: "共感", benefit: "メリット直球", question: "問いかけ", number: "数字", urgency: "急ぎ", story: "ストーリー" };

function RequestForms({ c }: { c: CreativeView }) {
  const canApprove = c.status === "produced" || c.status === "qa_failed";
  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <form action={request}>
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="action" value="approve" />
            <Button>採用する</Button>
          </form>
        ) : null}
      </div>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold">修正を依頼する</summary>
        <form action={request} className="mt-3">
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="action" value="revise" />
          <textarea name="note" rows={3} required placeholder="例: 人物を40代にして、もっと落ち着いた雰囲気に。給与を先に見せたい" className={inputCls} />
          <div className="my-2 flex flex-wrap gap-4 text-sm">
            {[
              ["copy", "文言だけ（画像はそのまま）"],
              ["image", "画像だけ作り直す"],
              ["both", "文言も画像も"],
            ].map(([v, l]) => (
              <label key={v} className="flex items-center gap-1">
                <input type="radio" name="scope" value={v} defaultChecked={v === "copy"} /> {l}
              </label>
            ))}
          </div>
          <Button variant="secondary">この内容で直してもらう</Button>
        </form>
      </details>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold">文言違いを作る（同じ画像で A/B テスト）</summary>
        <form action={request} className="mt-3">
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="action" value="variant" />
          <textarea name="note" rows={2} required placeholder="例: 問いかけの言い方で / 手取り額を前に出して" className={inputCls} />
          <div className="mt-2">
            <Button variant="secondary">文言違いを作ってもらう</Button>
          </div>
        </form>
      </details>
      {c.status !== "published" ? (
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-red-700">却下する</summary>
          <form action={request} className="mt-3">
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="action" value="reject" />
            <textarea name="note" rows={2} placeholder="理由（AI が以後の企画で同じことを繰り返さないように伝えます）" className={inputCls} />
            <div className="mt-2">
              <Button variant="danger">却下する</Button>
            </div>
          </form>
        </details>
      ) : null}
    </div>
  );
}

function CreativeCard({ c, b, sub, rubricLabel }: { c: CreativeView; b?: BriefView; sub: string; rubricLabel: (id: string) => string }) {
  const img = c.assets?.find((a) => a.ratio === "4:5" && a.kind === "image") ?? c.assets?.find((a) => a.kind === "image");
  const url = assetUrl(img?.path);
  const e = b?.elements;
  return (
    <div className="grid gap-4 border-b border-slate-100 py-5 last:border-0 md:grid-cols-[240px_1fr]">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="w-full rounded-lg border border-slate-200" loading="lazy" />
      ) : (
        <div className="flex aspect-[4/5] items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-500">画像なし</div>
      )}
      <div className="text-sm">
        <div className="mb-2 flex flex-wrap gap-2">
          <Badge tone="blue">{ANGLE_LABELS[c.angle] ?? c.angle}</Badge>
          {c.variantOf ? <Badge>修正版・文言違い</Badge> : null}
          {c.status === "qa_failed" ? <Badge tone="red">最終チェックで指摘あり</Badge> : null}
          {c.humanApproved ? <Badge tone="green">採用済み</Badge> : null}
          <span className="text-xs text-slate-500">{sub}</span>
        </div>
        <p className="text-lg font-bold">{b?.overlay.main}</p>
        <p className="mb-2 text-slate-600">{b?.overlay.sub}</p>
        {b?.translationJa?.main ? <p className="mb-2 text-xs text-slate-500">日本語訳: {b.translationJa.main}</p> : null}
        <p className="font-semibold">{b?.headline}</p>
        <p className="mb-2 whitespace-pre-line text-slate-700">{b?.primaryText}</p>
        {c.review ? (
          <p className="mb-1 text-xs text-slate-600">
            採点 <b>{c.review.score}</b> 点（{Object.entries(c.review.scores).map(([k, v]) => `${rubricLabel(k)} ${v}`).join(" / ")}）
          </p>
        ) : null}
        {e ? (
          <p className="mb-1 text-xs text-slate-500">
            要素: {MOTIF[e.motif] ?? e.motif}・{e.person || "人物なし"}・{e.setting}・{e.palette}・{TASTE[e.taste] ?? e.taste}・{TONE[e.copyTone] ?? e.copyTone}
          </p>
        ) : null}
        {c.status === "qa_failed" && c.statusReason ? <p className="mb-1 text-xs text-red-700">{c.statusReason}</p> : null}
        <RequestForms c={c} />
      </div>
    </div>
  );
}

export default async function CreativesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [state, jobs, personas, hyps, rubric, policy, feedback] = await Promise.all([loadState(), loadJobs(), loadPersonas(), loadHypotheses(), loadRubric(), loadPolicy(), loadFeedback()]);
  const all = Object.values(state.creatives ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const brief = (c: CreativeView) => state.briefs?.[c.briefId];
  const sub = (c: CreativeView) =>
    [jobs.value.find((j) => j.id === c.jobId)?.title ?? c.jobId, personas.value.find((p) => p.id === c.personaId)?.name ?? c.personaId, c.hypothesisId ? `仮説: ${hyps.value.find((h) => h.id === c.hypothesisId)?.title ?? c.hypothesisId}` : ""]
      .filter(Boolean)
      .join("｜");
  const rubricLabel = (id: string) => rubric.value?.items.find((i) => i.id === id)?.label ?? id;
  const waiting = all.filter((c) => (c.status === "produced" && !c.humanApproved) || c.status === "qa_failed");
  const approved = all.filter((c) => c.status === "produced" && c.humanApproved);
  const making = all.filter((c) => c.status === "planned" || c.status === "awaiting_images");
  const live = all.filter((c) => c.status === "published").slice(0, 20);
  const label = (f: { targetId: string }) => brief(state.creatives?.[f.targetId] ?? ({} as CreativeView))?.overlay.main ?? f.targetId;
  return (
    <>
      <PageTitle
        sub={
          policy.value?.requireHumanSelection
            ? "AI が作った広告から、使うものを選んでください。採用したものだけが入稿されます。直してほしい点は「修正を依頼する」に書くと、AI が直してもう一度ここに並べます。"
            : "AI が作った広告です。直してほしい点は「修正を依頼する」に書くと、AI が直します。"
        }
      >
        広告の確認
      </PageTitle>
      <Notice {...n} />
      <Card title={`確認待ち（${waiting.length}）`}>
        {waiting.length === 0 ? <p className="text-sm text-slate-600">確認待ちの広告はありません。</p> : waiting.map((c) => <CreativeCard key={c.id} c={c} b={brief(c)} sub={sub(c)} rubricLabel={rubricLabel} />)}
      </Card>
      <Card title="依頼の状況">
        <FeedbackStatus items={feedback.value.filter((f) => f.target === "creative")} state={state} label={label} />
      </Card>
      {approved.length ? (
        <Card title={`採用済み・入稿待ち（${approved.length}）`}>
          <p className="mb-2 text-xs text-slate-500">次の入稿で媒体に入ります（試運転中は入りません）。</p>
          {approved.map((c) => (
            <p key={c.id} className="text-sm">
              ・{brief(c)?.overlay.main}（{sub(c)}）
            </p>
          ))}
        </Card>
      ) : null}
      <Card title={`制作中（${making.length}）`}>
        {making.length === 0 ? (
          <p className="text-sm text-slate-600">制作中の広告はありません。</p>
        ) : (
          making.map((c) => (
            <p key={c.id} className="text-sm">
              ・{brief(c)?.overlay.main}（{c.status === "awaiting_images" ? "画像待ち" : "制作待ち"}・{sub(c)}）{c.statusReason ? <span className="text-xs text-slate-500"> {c.statusReason}</span> : null}
            </p>
          ))
        )}
      </Card>
      {live.length ? (
        <Card title={`配信中（${live.length}）`}>
          <p className="mb-2 text-xs text-slate-500">配信中の広告は書き換えず、修正版・文言違いを別の広告として作ります。</p>
          {live.map((c) => (
            <CreativeCard key={c.id} c={c} b={brief(c)} sub={sub(c)} rubricLabel={rubricLabel} />
          ))}
        </Card>
      ) : null}
    </>
  );
}
