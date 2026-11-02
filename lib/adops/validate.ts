/**
 * 管理画面から保存する前の検証（adops/src/config.ts の validateCatalog と同じ基準の主要部分）。
 * 保存してから定期実行で失敗するより、保存の時点で止めて画面に理由を出す。
 * このファイルは他のファイルを読み込まない（node --test で単体で試せるように）。
 */
type AnyJob = { id: string; active?: boolean; title?: string; landingUrl?: string; applyUrl?: string; salary?: { min?: number; max?: number }; personas?: string[]; targetCpa?: number; monthlyApplicationTarget?: number };
type AnyHyp = { id: string; personaId: string; jobIds?: string[]; angle: string; title: string; message: string };
type AnyRubric = { version?: string; items?: { id: string; label?: string; description?: string; weight?: number; appliesWhen?: string }[] };

const ANGLE_IDS = ["pay", "housing", "beginner", "stability", "quick_cash", "lifestyle", "team", "skill", "pride", "speed"];
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,59}$/;

export function validateJobs(jobs: AnyJob[], personaIds: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const j of jobs) {
    const name = j.title || j.id;
    if (!ID_PATTERN.test(j.id ?? "")) errors.push(`${name}: ID は英小文字・数字・ハイフン（2〜60字）にしてください`);
    if (seen.has(j.id)) errors.push(`求人 ID が重複しています: ${j.id}`);
    seen.add(j.id);
    if (!j.title?.trim()) errors.push(`${j.id}: 職種名は必須です`);
    if (!/^https?:\/\//.test(j.landingUrl ?? "")) errors.push(`${name}: 応募ページの URL（landingUrl）は http(s):// で始めてください`);
    if (j.applyUrl && !/^https?:\/\//.test(j.applyUrl)) errors.push(`${name}: 応募フォームの URL は http(s):// で始めてください`);
    if (!(Number(j.salary?.min) > 0)) errors.push(`${name}: 給与の下限は必須です（給与の明示は法律上必要）`);
    if (j.salary?.max !== undefined && !(Number(j.salary.max) >= Number(j.salary.min))) errors.push(`${name}: 給与の上限は下限以上にしてください`);
    if (!j.personas?.length) errors.push(`${name}: 対象のペルソナを1つ以上選んでください`);
    for (const p of j.personas ?? []) if (!personaIds.includes(p)) errors.push(`${name}: 未定義のペルソナ ${p}`);
    if (j.targetCpa !== undefined && !(j.targetCpa > 0)) errors.push(`${name}: 目標応募単価は正の数にしてください`);
    if (j.monthlyApplicationTarget !== undefined && !(j.monthlyApplicationTarget > 0)) errors.push(`${name}: 月の応募目標は1以上にしてください`);
  }
  return errors;
}

export function validateHypotheses(hyps: AnyHyp[], personaIds: string[], jobIds: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const h of hyps) {
    if (!ID_PATTERN.test(h.id ?? "")) errors.push(`仮説 ${h.title || h.id}: ID は英小文字・数字・ハイフン（2〜60字）にしてください`);
    if (seen.has(h.id)) errors.push(`仮説 ID が重複しています: ${h.id}`);
    seen.add(h.id);
    if (!personaIds.includes(h.personaId)) errors.push(`仮説 ${h.id}: ペルソナを選んでください`);
    if (!ANGLE_IDS.includes(h.angle)) errors.push(`仮説 ${h.id}: 訴求軸を選んでください`);
    for (const j of h.jobIds ?? []) if (!jobIds.includes(j)) errors.push(`仮説 ${h.id}: 未定義の求人 ${j}`);
    if (!h.title?.trim() || !h.message?.trim()) errors.push(`仮説 ${h.id}: 仮説と打ち出し方は必須です`);
  }
  return errors;
}

export function validateRubric(r: AnyRubric): string[] {
  const errors: string[] = [];
  if (!r.version?.trim()) errors.push("採点基準の版は必須です（基準を直したら上げる）");
  const items = r.items ?? [];
  if (!items.length) errors.push("採点項目が1つもありません");
  else if (items.every((i) => i.appliesWhen === "hypothesis")) errors.push("すべての項目が仮説専用です（仮説の無い広告を採点できません）");
  const seen = new Set<string>();
  for (const it of items) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(it.id ?? "")) errors.push(`採点項目 ${it.label || it.id}: ID は英数字にしてください`);
    if (seen.has(it.id)) errors.push(`採点項目の ID が重複しています: ${it.id}`);
    seen.add(it.id);
    if (!it.label?.trim() || !it.description?.trim()) errors.push(`採点項目 ${it.id}: 名前と説明は必須です`);
    if (it.weight !== undefined && !(it.weight > 0)) errors.push(`採点項目 ${it.id}: 重みは正の数にしてください`);
  }
  return errors;
}

/** 改行区切りの入力を配列にする（空行は捨てる）。 */
export function lines(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 数値の入力（空なら undefined）。 */
export function num(v: FormDataEntryValue | null): number | undefined {
  const s = String(v ?? "").replace(/[,，円\s]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
