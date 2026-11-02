import { loadBrand, loadPolicy, saveConfig } from "@/lib/adops/config";
import { act, assertValid } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { lines, num } from "@/lib/adops/validate";
import { Button, Card, Field, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

async function saveBrand(form: FormData) {
  "use server";
  await requireAdmin();
  await act("/admin/settings", "会社の情報を保存しました", async () => {
    const cur = await loadBrand();
    const name = String(form.get("name") ?? "").trim();
    if (!name) throw new Error("社名は必須です");
    const next = {
      ...cur.value,
      name,
      tone: String(form.get("tone") ?? "").trim(),
      mandatoryText: String(form.get("mandatoryText") ?? "").trim(),
      bannedPhrases: lines(form.get("bannedPhrases")),
    };
    await saveConfig("brand.json", next, cur.sha, "会社の情報を更新");
  });
}

async function savePolicy(form: FormData) {
  "use server";
  await requireAdmin();
  await act("/admin/settings", "運用の設定を保存しました。次の定期実行から反映されます", async () => {
    const cur = await loadPolicy();
    if (!cur.value) throw new Error("policy.json が見つかりません");
    const v = (k: string) => num(form.get(k));
    const autonomy = String(form.get("autonomy"));
    const errors: string[] = [];
    const briefs = v("briefsPerCycle");
    const explore = v("exploreShare");
    const pass = v("passScore");
    const cpa = v("targetCpa");
    const maxBudget = v("maxDailyBudget");
    const perCycle = v("lpPerCycle");
    if (autonomy !== "draft" && autonomy !== "auto") errors.push("運用モードを選んでください");
    if (!(briefs !== undefined && briefs >= 0 && briefs <= 50 && Number.isInteger(briefs))) errors.push("1日に作る広告の本数は 0〜50 の整数");
    if (!(explore !== undefined && explore >= 0 && explore <= 1)) errors.push("新しい訴求を試す割合は 0〜1（例: 0.3）");
    if (!(pass !== undefined && pass >= 0 && pass <= 100)) errors.push("合格点は 0〜100");
    if (!(cpa !== undefined && cpa > 0)) errors.push("目標応募単価は正の数");
    if (!(maxBudget !== undefined && maxBudget > 0)) errors.push("自動で増やす日予算の上限は正の数");
    if (perCycle !== undefined && !(perCycle >= 0 && perCycle <= 10 && Number.isInteger(perCycle))) errors.push("1回に作る LP の数は 0〜10 の整数");
    assertValid(errors);
    const p = cur.value;
    const next = {
      ...p,
      autonomy,
      briefsPerCycle: briefs,
      exploreShare: explore,
      review: { ...p.review, passScore: pass },
      guardrails: { ...p.guardrails, targetCpa: cpa, maxDailyBudget: maxBudget },
      lp: { enabled: form.get("lpEnabled") === "on", perCycle: perCycle ?? p.lp?.perCycle ?? 2 },
    };
    await saveConfig("policy.json", next, cur.sha, "運用の設定を更新");
  });
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [brand, policy] = await Promise.all([loadBrand(), loadPolicy()]);
  const p = policy.value;
  return (
    <>
      <PageTitle>基本設定</PageTitle>
      <Notice {...n} />
      <form action={saveBrand}>
        <Card title="会社の情報">
          <Field label="社名" hint="LP のフッターなどに出ます。サンプルのままだと入稿・LP 公開をしません">
            <input name="name" defaultValue={brand.value.name} required className={inputCls} />
          </Field>
          <Field label="文章のトーン" hint="例: 親しみやすく、具体的で、誇張しない">
            <textarea name="tone" rows={2} defaultValue={brand.value.tone} className={inputCls} />
          </Field>
          <Field label="必ず入れる表記（任意）" hint="例: 有料職業紹介事業許可番号 13-ユ-000000">
            <input name="mandatoryText" defaultValue={brand.value.mandatoryText} className={inputCls} />
          </Field>
          <Field label="社内で使わない表現（1行に1つ）">
            <textarea name="bannedPhrases" rows={4} defaultValue={brand.value.bannedPhrases.join("\n")} className={inputCls} />
          </Field>
          <Button>会社の情報を保存</Button>
        </Card>
      </form>
      {p ? (
        <form action={savePolicy}>
          <Card title="運用">
            <Field label="運用モード" hint="最初は「下書き入稿」にしてください。広告を出すかどうかは、Actions の ADOPS_DRY_RUN（試運転）でも決まります">
              <select name="autonomy" defaultValue={p.autonomy} className={`${inputCls} max-w-md`}>
                <option value="draft">下書き入稿（停止状態で入稿し、人が配信開始する。予算増は提案だけ）</option>
                <option value="auto">完全自動（審査を通れば配信開始。予算増も自動）</option>
              </select>
            </Field>
            <div className="grid gap-x-4 md:grid-cols-3">
              <Field label="1日に作る広告の本数（全求人合計）">
                <input name="briefsPerCycle" inputMode="numeric" defaultValue={p.briefsPerCycle} className={inputCls} />
              </Field>
              <Field label="新しい訴求を試す割合（0〜1）">
                <input name="exploreShare" inputMode="decimal" defaultValue={p.exploreShare} className={inputCls} />
              </Field>
              <Field label="レビューの合格点（100点満点）">
                <input name="passScore" inputMode="numeric" defaultValue={p.review.passScore} className={inputCls} />
              </Field>
              <Field label="目標応募単価（円）">
                <input name="targetCpa" inputMode="numeric" defaultValue={p.guardrails.targetCpa} className={inputCls} />
              </Field>
              <Field label="自動で増やす日予算の上限（円）">
                <input name="maxDailyBudget" inputMode="numeric" defaultValue={p.guardrails.maxDailyBudget} className={inputCls} />
              </Field>
            </div>
          </Card>
          <Card title="応募ページ（LP）">
            <label className="mb-4 flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="lpEnabled" defaultChecked={p.lp?.enabled} /> LP を自動で作る（下書きを作り、人が公開する）
            </label>
            <Field label="1回の実行で作る下書きの数">
              <input name="lpPerCycle" inputMode="numeric" defaultValue={p.lp?.perCycle ?? 2} className={`${inputCls} max-w-[8rem]`} />
            </Field>
            <Button>運用の設定を保存</Button>
          </Card>
        </form>
      ) : null}
    </>
  );
}
