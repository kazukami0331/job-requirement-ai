/** 管理画面: 設定ファイルの読み込みと保存（GitHub 経由）。 */
import { configBranch, readFile, stateBranch, writeFile } from "./github";
import type { Brand, Hypothesis, Job, Persona, Policy, Rubric, StateView } from "./types";

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

/** 運用の状態（無ければ空。まだ一度も実行していない場合など）。 */
export async function loadState(): Promise<StateView> {
  const f = await readFile("state.json", stateBranch()).catch(() => null);
  return f ? (JSON.parse(f.text) as StateView) : {};
}
