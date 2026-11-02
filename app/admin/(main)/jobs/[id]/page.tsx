import { notFound } from "next/navigation";
import { loadHypotheses, loadJobs, loadPersonas, saveConfig } from "@/lib/adops/config";
import { act, assertValid } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { lines, num, validateJobs } from "@/lib/adops/validate";
import { SALARY_TYPES, type Job } from "@/lib/adops/types";
import { Button, Card, Field, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

async function save(form: FormData) {
  "use server";
  await requireAdmin();
  const original = String(form.get("original") ?? "");
  const id = String(form.get("id") ?? "").trim();
  const back = `/admin/jobs/${encodeURIComponent(original || "new")}`;
  await act(
    "/admin/jobs",
    "保存しました。次の定期実行から反映されます",
    async () => {
      const [jobs, personas] = await Promise.all([loadJobs(), loadPersonas()]);
      const list = [...jobs.value];
      const idx = original ? list.findIndex((j) => j.id === original) : -1;
      if (original && idx < 0) throw new Error("この求人は見つかりません（ほかの人が削除した可能性があります）");
      if (form.get("delete") === "yes" && idx >= 0) {
        const hyps = await loadHypotheses();
        const used = hyps.value.filter((h) => h.jobIds?.includes(original)).map((h) => `仮説「${h.title}」`);
        if (used.length) throw new Error(`仮説の対象になっているので削除できません（先に仮説から外すか、募集中をオフにしてください）: ${used.join("、")}`);
        list.splice(idx, 1);
        await saveConfig("jobs.json", list, jobs.sha, `求人 ${original} を削除`);
        return;
      }
      let placements: Record<string, unknown>;
      try {
        placements = JSON.parse(String(form.get("placements") || "{}"));
      } catch {
        throw new Error("入稿先（placements）の JSON の形が正しくありません");
      }
      const opt = (k: string) => String(form.get(k) ?? "").trim() || undefined;
      const max = num(form.get("salaryMax"));
      const job: Job = {
        ...(idx >= 0 ? list[idx] : {}),
        // 既存の求人の ID は変えない（広告・LP・仮説が ID で参照しているため）
        id: idx >= 0 ? original : id,
        active: form.get("active") === "on",
        title: String(form.get("title") ?? "").trim(),
        category: String(form.get("category") ?? "").trim(),
        location: String(form.get("location") ?? "").trim(),
        employmentType: String(form.get("employmentType") ?? "").trim(),
        salary: {
          ...(idx >= 0 ? list[idx].salary : {}),
          type: String(form.get("salaryType")) as Job["salary"]["type"],
          min: num(form.get("salaryMin")) ?? 0,
          ...(max !== undefined ? { max } : {}),
          ...(opt("salaryNote") ? { note: opt("salaryNote") } : {}),
        },
        perks: lines(form.get("perks")),
        hours: opt("hours"),
        holidays: opt("holidays"),
        requirements: opt("requirements"),
        personas: form.getAll("personas").map(String),
        landingUrl: String(form.get("landingUrl") ?? "").trim(),
        applyUrl: opt("applyUrl"),
        targetCpa: num(form.get("targetCpa")),
        monthlyApplicationTarget: num(form.get("monthlyApplicationTarget")),
        dailyCreativeQuota: num(form.get("dailyCreativeQuota")),
        placements,
      };
      if (max === undefined) delete job.salary.max;
      if (!opt("salaryNote")) delete job.salary.note;
      // 空の任意項目は書かない（jobs.json を読みやすく保つ）
      for (const k of Object.keys(job)) if (job[k] === undefined) delete job[k];
      if (idx >= 0) list[idx] = job;
      else list.push(job);
      assertValid(validateJobs(list, personas.value.map((p) => p.id)));
      await saveConfig("jobs.json", list, jobs.sha, `求人 ${id} を${idx >= 0 ? "更新" : "追加"}`);
    },
    back,
  );
}

export default async function JobEdit({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const n = await notices(searchParams);
  const [jobs, personas] = await Promise.all([loadJobs(), loadPersonas()]);
  const isNew = id === "new";
  const j: Partial<Job> = isNew ? { active: false, personas: [], perks: [], placements: {}, salary: { type: "月給", min: 0 } } : (jobs.value.find((x) => x.id === decodeURIComponent(id)) ?? notFound());
  return (
    <>
      <PageTitle sub={isNew ? "追加した求人は「募集中」にするまで広告を作りません。" : undefined}>{isNew ? "求人を追加" : j.title}</PageTitle>
      <Notice {...n} />
      <form action={save}>
        <input type="hidden" name="original" value={isNew ? "" : j.id} />
        <Card title="基本">
          <Field label="求人 ID" hint="英小文字・数字・ハイフン（例: factory-aichi）。広告や LP の管理に使います。あとから変えないでください">
            <input name="id" defaultValue={j.id} required readOnly={!isNew} className={`${inputCls} ${isNew ? "" : "bg-slate-100"}`} />
          </Field>
          <label className="mb-4 flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="active" defaultChecked={j.active} /> 募集中（オフにすると広告を止め、新しく作らない）
          </label>
          <div className="grid gap-x-4 md:grid-cols-2">
            <Field label="職種名">
              <input name="title" defaultValue={j.title} required className={inputCls} />
            </Field>
            <Field label="職種の分類" hint="例: 製造 / ドライバー / 建設">
              <input name="category" defaultValue={j.category} className={inputCls} />
            </Field>
            <Field label="勤務地">
              <input name="location" defaultValue={j.location} className={inputCls} />
            </Field>
            <Field label="雇用形態">
              <input name="employmentType" defaultValue={j.employmentType} className={inputCls} />
            </Field>
          </div>
        </Card>
        <Card title="給与・条件">
          <div className="grid gap-x-4 md:grid-cols-4">
            <Field label="給与の種類">
              <select name="salaryType" defaultValue={j.salary?.type} className={inputCls}>
                {SALARY_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="下限（円）">
              <input name="salaryMin" inputMode="numeric" defaultValue={j.salary?.min || ""} required className={inputCls} />
            </Field>
            <Field label="上限（円・任意）">
              <input name="salaryMax" inputMode="numeric" defaultValue={j.salary?.max ?? ""} className={inputCls} />
            </Field>
            <Field label="給与の補足（任意）">
              <input name="salaryNote" defaultValue={j.salary?.note} className={inputCls} />
            </Field>
          </div>
          <Field label="待遇（1行に1つ）" hint="ここに書いた待遇だけが広告に使われます（書いていない待遇を広告に出すとレビューで止まります）">
            <textarea name="perks" rows={5} defaultValue={j.perks?.join("\n")} className={inputCls} />
          </Field>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="勤務時間">
              <input name="hours" defaultValue={j.hours} className={inputCls} />
            </Field>
            <Field label="休日">
              <input name="holidays" defaultValue={j.holidays} className={inputCls} />
            </Field>
            <Field label="応募条件">
              <input name="requirements" defaultValue={j.requirements} className={inputCls} />
            </Field>
          </div>
        </Card>
        <Card title="対象のペルソナ">
          <div className="flex flex-wrap gap-4">
            {personas.value.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="personas" value={p.id} defaultChecked={j.personas?.includes(p.id)} /> {p.name}
              </label>
            ))}
          </div>
        </Card>
        <Card title="ページ・目標">
          <Field label="広告の飛び先（応募ページの URL）" hint="adops が作った LP を使うなら、公開した LP の URL に変えてください">
            <input name="landingUrl" type="url" defaultValue={j.landingUrl} required className={inputCls} />
          </Field>
          <Field label="応募フォームの URL（任意）" hint="adops が作る LP の応募ボタンの行き先。空なら上の URL">
            <input name="applyUrl" type="url" defaultValue={j.applyUrl} className={inputCls} />
          </Field>
          <div className="grid gap-x-4 md:grid-cols-3">
            <Field label="目標応募単価（円・任意）" hint="空なら基本設定の値">
              <input name="targetCpa" inputMode="numeric" defaultValue={j.targetCpa ?? ""} className={inputCls} />
            </Field>
            <Field label="今月の応募目標（件・任意）" hint="達したら新しい広告を作らない">
              <input name="monthlyApplicationTarget" inputMode="numeric" defaultValue={j.monthlyApplicationTarget ?? ""} className={inputCls} />
            </Field>
            <Field label="1日に作る広告の上限（本・任意）">
              <input name="dailyCreativeQuota" inputMode="numeric" defaultValue={j.dailyCreativeQuota ?? ""} className={inputCls} />
            </Field>
          </div>
        </Card>
        <Card title="入稿先（詳しい人向け）">
          <Field label="placements（JSON）" hint='Meta の広告セット ID・Google の広告グループ ID など。例: {"meta":{"adsetIds":["2385..."]},"google":{"searchAdGroupIds":["1234"]}}'>
            <textarea name="placements" rows={4} defaultValue={JSON.stringify(j.placements ?? {}, null, 2)} className={`${inputCls} font-mono`} />
          </Field>
        </Card>
        <div className="flex flex-wrap items-center gap-4">
          <Button>保存する</Button>
          {!isNew ? (
            <label className="ml-auto flex items-center gap-2 text-sm text-red-700">
              <input type="checkbox" name="delete" value="yes" /> この求人を削除する（チェックして保存）
            </label>
          ) : null}
        </div>
      </form>
    </>
  );
}
