import { notFound } from "next/navigation";
import { loadHypotheses, loadJobs, loadPersonas, saveConfig } from "@/lib/adops/config";
import { act, assertValid } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { lines, validateHypotheses } from "@/lib/adops/validate";
import { ANGLES, ANGLE_LABELS, type Angle, type Hypothesis } from "@/lib/adops/types";
import { Button, Card, Field, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

async function save(form: FormData) {
  "use server";
  await requireAdmin();
  const original = String(form.get("original") ?? "");
  await act(
    "/admin/hypotheses",
    "保存しました。次の定期実行から反映されます",
    async () => {
      const [hyps, personas, jobs] = await Promise.all([loadHypotheses(), loadPersonas(), loadJobs()]);
      const list = [...hyps.value];
      const idx = original ? list.findIndex((h) => h.id === original) : -1;
      if (original && idx < 0) throw new Error("この仮説は見つかりません");
      if (form.get("delete") === "yes" && idx >= 0) {
        list.splice(idx, 1);
        await saveConfig("hypotheses.json", list, hyps.sha, `仮説 ${original} を削除`);
        return;
      }
      const h: Hypothesis = {
        // 画面に無い項目は残す。既存の仮説の ID は変えない（広告の記録が ID で参照しているため）
        ...(idx >= 0 ? list[idx] : {}),
        id: idx >= 0 ? original : String(form.get("id") ?? "").trim(),
        personaId: String(form.get("personaId") ?? ""),
        angle: String(form.get("angle") ?? "") as Angle,
        title: String(form.get("title") ?? "").trim(),
        message: String(form.get("message") ?? "").trim(),
      };
      const jobIds = form.getAll("jobIds").map(String);
      if (jobIds.length) h.jobIds = jobIds;
      else delete h.jobIds;
      const avoid = lines(form.get("avoid"));
      if (avoid.length) h.avoid = avoid;
      else delete h.avoid;
      if (form.get("active") !== "on") h.active = false;
      else delete h.active;
      if (idx >= 0) list[idx] = h;
      else list.push(h);
      assertValid(
        validateHypotheses(
          list,
          personas.value.map((p) => p.id),
          jobs.value.map((j) => j.id),
        ),
      );
      await saveConfig("hypotheses.json", list, hyps.sha, `仮説 ${h.id} を${idx >= 0 ? "更新" : "追加"}`);
    },
    `/admin/hypotheses/${encodeURIComponent(original || "new")}`,
  );
}

export default async function HypothesisEdit({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const n = await notices(searchParams);
  const [hyps, personas, jobs] = await Promise.all([loadHypotheses(), loadPersonas(), loadJobs()]);
  const isNew = id === "new";
  const h: Partial<Hypothesis> = isNew ? { personaId: String(sp.persona ?? ""), active: true } : (hyps.value.find((x) => x.id === decodeURIComponent(id)) ?? notFound());
  return (
    <>
      <PageTitle sub="何を・どう打ち出すかを具体的に書くほど、AI の広告と LP が仮説に沿います。">{isNew ? "仮説を追加" : h.title}</PageTitle>
      <Notice {...n} />
      <form action={save}>
        <input type="hidden" name="original" value={isNew ? "" : h.id} />
        <Card>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="ID" hint="英小文字・数字・ハイフン（例: young-earn-early）">
              <input name="id" defaultValue={h.id} required readOnly={!isNew} className={`${inputCls} ${isNew ? "" : "bg-slate-100"}`} />
            </Field>
            <Field label="ペルソナ">
              <select name="personaId" defaultValue={h.personaId} required className={inputCls}>
                <option value="">選んでください</option>
                {personas.value.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="訴求軸（集計の分類）">
              <select name="angle" defaultValue={h.angle} required className={inputCls}>
                <option value="">選んでください</option>
                {ANGLES.map((a) => (
                  <option key={a} value={a}>
                    {ANGLE_LABELS[a]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="仮説（一言で）" hint="例: 40〜50代には「体力勝負ではない仕事」と伝えると不安が減る">
            <input name="title" defaultValue={h.title} required className={inputCls} />
          </Field>
          <Field label="打ち出し方（AI への指示）" hint="何を・どう見せるかを具体的に。例: 座ってできる作業・機械の操作など体への負担が少ないことを具体的に見せる">
            <textarea name="message" rows={4} defaultValue={h.message} required className={inputCls} />
          </Field>
          <Field label="避けたい表現（1行に1つ・任意）">
            <textarea name="avoid" rows={2} defaultValue={h.avoid?.join("\n")} className={inputCls} />
          </Field>
          <div className="mb-4">
            <span className="mb-1 block text-sm font-medium text-slate-800">対象の求人（選ばなければ、このペルソナのすべての求人）</span>
            <div className="flex flex-wrap gap-4">
              {jobs.value.map((j) => (
                <label key={j.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="jobIds" value={j.id} defaultChecked={h.jobIds?.includes(j.id)} /> {j.title}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="active" defaultChecked={h.active !== false} /> 検証中（オフにすると配分しない）
          </label>
        </Card>
        <div className="flex flex-wrap items-center gap-4">
          <Button>保存する</Button>
          {!isNew ? (
            <label className="ml-auto flex items-center gap-2 text-sm text-red-700">
              <input type="checkbox" name="delete" value="yes" /> この仮説を削除する（チェックして保存）
            </label>
          ) : null}
        </div>
      </form>
    </>
  );
}
