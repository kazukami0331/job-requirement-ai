import { loadDirectives, loadReferences, saveConfig } from "@/lib/adops/config";
import { act } from "@/lib/adops/actions";
import { requireAdmin } from "@/lib/adops/auth";
import type { Directive, Reference } from "@/lib/adops/types";
import { Button, Card, Notice, PageTitle, inputCls, notices } from "@/components/admin/ui";

const EMPTY = 2;
const SCOPES = [
  ["ads", "広告（画像・文言）"],
  ["lp", "応募ページ（LP）"],
  ["google", "Google 検索広告"],
] as const;

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function saveDirectives(form: FormData) {
  "use server";
  await requireAdmin();
  await act("/admin/directives", "AI への指示を保存しました。次の制作から反映されます", async () => {
    const cur = await loadDirectives();
    const count = Number(form.get("count") ?? 0);
    const list: Directive[] = [];
    for (let i = 0; i < count; i++) {
      const text = String(form.get(`d.${i}.text`) ?? "").trim();
      if (!text || form.get(`d.${i}.delete`) === "yes") continue;
      const scope = form.getAll(`d.${i}.scope`).map(String).filter((s): s is "ads" | "lp" | "google" => ["ads", "lp", "google"].includes(s));
      const d: Directive = { id: String(form.get(`d.${i}.id`) || newId("d")), text: text.slice(0, 500) };
      if (scope.length && scope.length < 3) d.scope = scope;
      if (form.get(`d.${i}.active`) !== "on") d.active = false;
      list.push(d);
    }
    await saveConfig("directives.json", list, cur.sha, "AI への指示を更新");
  });
}

async function saveReferences(form: FormData) {
  "use server";
  await requireAdmin();
  await act("/admin/directives", "参考にしたい広告を保存しました。次の企画から反映されます", async () => {
    const cur = await loadReferences();
    const count = Number(form.get("count") ?? 0);
    const list: Reference[] = [];
    for (let i = 0; i < count; i++) {
      const text = String(form.get(`r.${i}.text`) ?? "").trim();
      if (!text || form.get(`r.${i}.delete`) === "yes") continue;
      const r: Reference = { id: String(form.get(`r.${i}.id`) || newId("r")), source: String(form.get(`r.${i}.source`) ?? "").trim() || "（出どころ未記入）", text: text.slice(0, 1000) };
      const note = String(form.get(`r.${i}.note`) ?? "").trim();
      if (note) r.note = note.slice(0, 500);
      if (form.get(`r.${i}.active`) !== "on") r.active = false;
      list.push(r);
    }
    await saveConfig("references.json", list, cur.sha, "参考にしたい広告を更新");
  });
}

export default async function DirectivesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const n = await notices(searchParams);
  const [ds, rs] = await Promise.all([loadDirectives(), loadReferences()]);
  const drows: Partial<Directive>[] = [...ds.value, ...Array.from({ length: EMPTY }, () => ({}))];
  const rrows: Partial<Reference>[] = [...rs.value, ...Array.from({ length: EMPTY }, () => ({}))];
  return (
    <>
      <PageTitle sub="AI が広告・LP・検索広告を作るときに毎回守る指示と、参考にしたい広告です。個別の広告への修正は「広告の確認」から依頼してください。">AI への指示</PageTitle>
      <Notice {...n} />
      <form action={saveDirectives}>
        <input type="hidden" name="count" value={drows.length} />
        <Card title="全体への指示" actions={<Button>指示を保存</Button>}>
          <p className="mb-4 text-xs text-slate-500">例: 「今月は寮の訴求を強めに」「“底辺”“きつい”など職業を下げる言葉は使わない」「写真は女性スタッフも入れる」</p>
          {drows.map((d, i) => (
            <div key={i} className="mb-4 rounded-lg border border-slate-200 p-3">
              <input type="hidden" name={`d.${i}.id`} value={d.id ?? ""} />
              <textarea name={`d.${i}.text`} rows={2} defaultValue={d.text} placeholder={d.id ? "" : "新しい指示（使うときだけ記入）"} className={inputCls} />
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                {SCOPES.map(([v, l]) => (
                  <label key={v} className="flex items-center gap-1">
                    <input type="checkbox" name={`d.${i}.scope`} value={v} defaultChecked={!d.scope?.length || d.scope.includes(v)} /> {l}
                  </label>
                ))}
                <label className="flex items-center gap-1">
                  <input type="checkbox" name={`d.${i}.active`} defaultChecked={d.active !== false} /> 有効
                </label>
                {d.id ? (
                  <label className="flex items-center gap-1 text-red-700">
                    <input type="checkbox" name={`d.${i}.delete`} value="yes" /> 削除
                  </label>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      </form>
      <form action={saveReferences}>
        <input type="hidden" name="count" value={rrows.length} />
        <Card title="参考にしたい広告（他社・過去の広告）" actions={<Button>参考を保存</Button>}>
          <p className="mb-4 text-xs text-slate-500">見つけた良い広告の文言や構成を貼ってください。AI は真似せず、良い点の考え方だけを取り入れます（他社名や他社の数字は使いません）。</p>
          {rrows.map((r, i) => (
            <div key={i} className="mb-4 rounded-lg border border-slate-200 p-3">
              <input type="hidden" name={`r.${i}.id`} value={r.id ?? ""} />
              <input name={`r.${i}.source`} defaultValue={r.source} placeholder="どこの広告か（例: 他社A の Instagram 広告）" className={`${inputCls} mb-2`} />
              <textarea name={`r.${i}.text`} rows={3} defaultValue={r.text} placeholder={r.id ? "" : "広告の文言・構成（使うときだけ記入）"} className={`${inputCls} mb-2`} />
              <input name={`r.${i}.note`} defaultValue={r.note} placeholder="何が良いと思ったか" className={inputCls} />
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1">
                  <input type="checkbox" name={`r.${i}.active`} defaultChecked={r.active !== false} /> 使う
                </label>
                {r.id ? (
                  <label className="flex items-center gap-1 text-red-700">
                    <input type="checkbox" name={`r.${i}.delete`} value="yes" /> 削除
                  </label>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      </form>
    </>
  );
}
