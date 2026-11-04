import { loadRubric, saveConfig } from "@/lib/adops/config";
import { act, assertValid } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { num, validateRubric } from "@/lib/adops/validate";
import type { Rubric, RubricItem } from "@/lib/adops/types";
import { Button, Card, Field, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

const EMPTY_ROWS = 2;

async function save(form: FormData) {
  "use server";
  await requireAdmin();
  await act("/admin/rubric", "保存しました。次の定期実行から、この基準で採点します", async () => {
    const cur = await loadRubric();
    const count = Number(form.get("count") ?? 0);
    const items: RubricItem[] = [];
    for (let i = 0; i < count; i++) {
      const f = (k: string) => String(form.get(`items.${i}.${k}`) ?? "").trim();
      if (form.get(`items.${i}.delete`) === "yes") continue;
      if (!f("id") && !f("label")) continue; // 空の行
      const levels = Object.fromEntries((["1", "3", "5"] as const).map((k) => [k, f(`level${k}`)]).filter(([, v]) => v));
      const weight = num(form.get(`items.${i}.weight`));
      items.push({
        id: f("id"),
        label: f("label"),
        description: f("description"),
        ...(Object.keys(levels).length ? { levels } : {}),
        ...(weight !== undefined && weight !== 1 ? { weight } : {}),
        ...(form.get(`items.${i}.hypothesis`) === "on" ? { appliesWhen: "hypothesis" as const } : {}),
      });
    }
    const rubric: Rubric = { version: String(form.get("version") ?? "").trim(), items };
    assertValid(validateRubric(rubric));
    if (cur.value && cur.value.version === rubric.version && JSON.stringify(cur.value.items) !== JSON.stringify(items)) {
      throw new Error("項目を変えたときは「版」も変えてください（採点と実績の突き合わせを版ごとに分けるため）");
    }
    await saveConfig("rubric.json", rubric, cur.sha, `採点基準 ${rubric.version} を保存`);
  });
}

export default async function RubricPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const r = await loadRubric();
  const items: Partial<RubricItem>[] = [...(r.value?.items ?? []), ...Array.from({ length: EMPTY_ROWS }, () => ({}))];
  return (
    <>
      <PageTitle sub="「ブルーカラー向けに良い広告とは何か」を項目と点数の目安で書きます。AI は項目ごとに1〜5点で採点し、重みつきで100点満点にします。採点は広告ごとに残り、配信結果と並べて基準を見直せます。">
        採点基準
      </PageTitle>
      <Notice {...n} />
      <form action={save}>
        <input type="hidden" name="count" value={items.length} />
        <Card>
          <Field label="版" hint="項目を変えたら上げる（例: 2026-11-v2）">
            <input name="version" defaultValue={r.value?.version ?? "v1"} required className={`${inputCls} max-w-xs`} />
          </Field>
        </Card>
        {items.map((it, i) => (
          <Card key={i} title={it.id ? it.label : "新しい項目（使うときだけ記入）"}>
            <div className="grid gap-x-4 md:grid-cols-3">
              <Field label="ID" hint="英数字（例: trust）">
                <input name={`items.${i}.id`} defaultValue={it.id} className={inputCls} />
              </Field>
              <Field label="項目名">
                <input name={`items.${i}.label`} defaultValue={it.label} className={inputCls} />
              </Field>
              <Field label="重み" hint="既定 1。大事な項目は 1.5〜2">
                <input name={`items.${i}.weight`} inputMode="decimal" defaultValue={it.weight ?? (it.id ? 1 : "")} className={inputCls} />
              </Field>
            </div>
            <Field label="何を見るか">
              <textarea name={`items.${i}.description`} rows={2} defaultValue={it.description} className={inputCls} />
            </Field>
            <div className="grid gap-x-4 md:grid-cols-3">
              {(["1", "3", "5"] as const).map((k) => (
                <Field key={k} label={`${k}点の目安`}>
                  <input name={`items.${i}.level${k}`} defaultValue={it.levels?.[k]} className={inputCls} />
                </Field>
              ))}
            </div>
            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name={`items.${i}.hypothesis`} defaultChecked={it.appliesWhen === "hypothesis"} /> 仮説に沿った広告だけ採点する
              </label>
              {it.id ? (
                <label className="flex items-center gap-2 text-red-700">
                  <input type="checkbox" name={`items.${i}.delete`} value="yes" /> この項目を削除
                </label>
              ) : null}
            </div>
          </Card>
        ))}
        <Button>保存する</Button>
      </form>
    </>
  );
}
