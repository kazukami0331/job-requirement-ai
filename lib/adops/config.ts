/** 管理画面: 設定ファイルの読み込みと保存（GitHub 経由）。 */
import { configBranch, dispatch, readFile, stateBranch, writeFile } from "./github";
import type { Brand, Directive, FeedbackRequest, Hypothesis, Job, Persona, Policy, Reference, Rubric, StateView } from "./types";

export const CONFIG_DIR = "adops/config";

export interface Loaded<T> {
  value: T;
  sha?: string;
}

export async function loadConfig<T>(name: string, fallback: T): Promise<Loaded<T>> {
  const f = await readFile(`${CONFIG_DIR}/${name}`, configBranch());
  if (!f) return { value: fallback };
  return { value: JSON.parse(f.text) as T, sha: f.sha };
}

export async function saveConfig(name: string, value: unknown, sha: string | undefined, what: string): Promise<void> {
  await writeFile(`${CONFIG_DIR}/${name}`, `${JSON.stringify(value, null, 2)}\n`, sha, `adops 設定: ${what}（管理画面）`, configBranch());
}

export const loadJobs = () => loadConfig<Job[]>("jobs.json", []);
export const loadPersonas = () => loadConfig<Persona[]>("personas.json", []);
export const loadHypotheses = () => loadConfig<Hypothesis[]>("hypotheses.json", []);
export const loadRubric = () => loadConfig<Rubric | null>("rubric.json", null);
export const loadBrand = () => loadConfig<Brand>("brand.json", { name: "", tone: "", bannedPhrases: [] });
export const loadPolicy = () => loadConfig<Policy | null>("policy.json", null);
export const loadDirectives = () => loadConfig<Directive[]>("directives.json", []);
export const loadReferences = () => loadConfig<Reference[]>("references.json", []);
export const loadFeedback = () => loadConfig<FeedbackRequest[]>("feedback.json", []);

/**
 * AI への依頼（採用・却下・修正など）を feedback.json に追加し、すぐ処理されるようワークフローを起動する。
 * 処理済みで2週間たった依頼はこのときに片付ける（ファイルが大きくならないように）。
 */
export async function submitFeedback(req: Omit<FeedbackRequest, "id" | "at">, state?: StateView): Promise<void> {
  const cur = await loadFeedback();
  const done = (state ?? (await loadState())).feedbackDone ?? {};
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const kept = cur.value.filter((f) => !(done[f.id] && done[f.id].at < cutoff));
  const item: FeedbackRequest = { ...req, id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() };
  if (item.note) item.note = item.note.slice(0, 1000);
  await saveConfig("feedback.json", [...kept, item], cur.sha, `AI への依頼（${req.target} ${req.targetId}: ${req.action}）`);
  // 広告の依頼は、反映（制作し直し）と入稿まで続けて行う。LP・検索広告は反映と報告だけ
  await dispatch({ steps: req.target === "creative" ? "feedback,produce,publish,report" : "feedback,report" });
}

/** 運用の状態（無ければ空。まだ一度も実行していない場合など）。 */
export async function loadState(): Promise<StateView> {
  const f = await readFile("state.json", stateBranch()).catch(() => null);
  return f ? (JSON.parse(f.text) as StateView) : {};
}
