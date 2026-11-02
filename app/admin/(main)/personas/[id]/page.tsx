import { notFound } from "next/navigation";
import { loadHypotheses, loadJobs, loadPersonas, saveConfig } from "@/lib/adops/config";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import { ID_PATTERN, lines } from "@/lib/adops/validate";
import type { Persona } from "@/lib/adops/types";
import { Button, Card, Field, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

async function save(form: FormData) {
  "use server";
  await requireAdmin();
  const original = String(form.get("original") ?? "");
  // 既存のペルソナの ID は変えない（求人・仮説・広告が ID で参照しているため）
  const id = original || String(form.get("id") ?? "").trim();
  await act(
    "/admin/personas",
    "保存しました。次の定期実行から反映されます",
    async () => {
      const personas = await loadPersonas();
      const list = [...personas.value];
      const idx = original ? list.findIndex((p) => p.id === original) : -1;
      if (original && idx < 0) throw new Error("このペルソナは見つかりません");
      if (form.get("delete") === "yes" && idx >= 0) {
        const [jobs, hyps] = await Promise.all([loadJobs(), loadHypotheses()]);
        const used = [...jobs.value.filter((j) => j.personas.includes(original)).map((j) => `求人「${j.title}」`), ...hyps.value.filter((h) => h.personaId === original).map((h) => `仮説「${h.title}」`)];
        if (used.length) throw new Error(`使われているので削除できません: ${used.join("、")}`);
        list.splice(idx, 1);
        await saveConfig("personas.json", list, personas.sha, `ペルソナ ${original} を削除`);
        return;
      }
      if (!ID_PATTERN.test(id)) throw new Error("ID は英小文字・数字・ハイフン（2〜60字）にしてください");
      if (idx < 0 && list.some((p) => p.id === id)) throw new Error(`ID ${id} はもう使われています`);
      const name = String(form.get("name") ?? "").trim();
      const summary = String(form.get("summary") ?? "").trim();
      if (!name || !summary) throw new Error("名前と概要は必須です");
      const language = String(form.get("language") ?? "").trim();
      const p: Persona = {
        ...(idx >= 0 ? list[idx] : {}),
        id,
        name,
        summary,
        motivations: lines(form.get("motivations")),
        pains: lines(form.get("pains")),
        media: lines(form.get("media")),
        vocabulary: { use: lines(form.get("use")), avoid: lines(form.get("avoid")) },
      };
      if (language && language !== "ja") p.language = language;
      else delete p.language;
      if (idx >= 0) list[idx] = p;
      else list.push(p);
      await saveConfig("personas.json", list, personas.sha, `ペルソナ ${id} を${idx >= 0 ? "更新" : "追加"}`);
    },
    `/admin/personas/${encodeURIComponent(original || "new")}`,
  );
}

export default async function PersonaEdit({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const n = await notices(searchParams);
  const personas = await loadPersonas();
  const isNew = id === "new";
  const p: Partial<Persona> = isNew ? {} : (personas.value.find((x) => x.id === decodeURIComponent(id)) ?? notFound());
  return (
    <>
      <PageTitle>{isNew ? "ペルソナを追加" : p.name}</PageTitle>
      <Notice {...n} />
      <form action={save}>
        <input type="hidden" name="original" value={isNew ? "" : p.id} />
        <Card>
          <div className="grid gap-x-4 md:grid-cols-2">
            <Field label="ID" hint="英小文字・数字・ハイフン（例: young-switcher）">
              <input name="id" defaultValue={p.id} required readOnly={!isNew} className={`${inputCls} ${isNew ? "" : "bg-slate-100"}`} />
            </Field>
            <Field label="名前" hint="例: 20代の転職検討層">
              <input name="name" defaultValue={p.name} required className={inputCls} />
            </Field>
          </div>
          <Field label="概要（どんな人か）">
            <textarea name="summary" rows={3} defaultValue={p.summary} required className={inputCls} />
          </Field>
          <div className="grid gap-x-4 md:grid-cols-2">
            <Field label="動機（1行に1つ）">
              <textarea name="motivations" rows={4} defaultValue={p.motivations?.join("\n")} className={inputCls} />
            </Field>
            <Field label="不安（1行に1つ）">
              <textarea name="pains" rows={4} defaultValue={p.pains?.join("\n")} className={inputCls} />
            </Field>
            <Field label="響く言葉（1行に1つ）">
              <textarea name="use" rows={3} defaultValue={p.vocabulary?.use?.join("\n")} className={inputCls} />
            </Field>
            <Field label="避ける言葉（1行に1つ）">
              <textarea name="avoid" rows={3} defaultValue={p.vocabulary?.avoid?.join("\n")} className={inputCls} />
            </Field>
            <Field label="よく見る媒体・時間帯（1行に1つ）">
              <textarea name="media" rows={3} defaultValue={p.media?.join("\n")} className={inputCls} />
            </Field>
            <Field label="広告の言語" hint="外国人材向けは vi（ベトナム語）・en・pt・id など。日本語なら ja">
              <input name="language" defaultValue={p.language ?? "ja"} className={inputCls} />
            </Field>
          </div>
        </Card>
        <div className="flex flex-wrap items-center gap-4">
          <Button>保存する</Button>
          {!isNew ? (
            <label className="ml-auto flex items-center gap-2 text-sm text-red-700">
              <input type="checkbox" name="delete" value="yes" /> このペルソナを削除する（チェックして保存）
            </label>
          ) : null}
        </div>
      </form>
    </>
  );
}
