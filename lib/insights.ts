// Like / Pass した求人から、候補者の「軸」の仮説を作る（AI を使わない集計）
import type { JobSummary } from "@/lib/swipeAdmin";

type J = JobSummary;

export type FeatureStat = {
  group: string;
  value: string;
  like: number;
  pass: number;
};

export type Insights = {
  likes: number;
  passes: number;
  /** Like に多い特徴（軸の候補） */
  liked: FeatureStat[];
  /** Pass に多い特徴（避けている可能性） */
  avoided: FeatureStat[];
  /** Like したほぼ全部に共通すること */
  common: FeatureStat[];
  salary: { like: Range | null; pass: Range | null };
  /** 他の求人を探すときの条件案 */
  search: { label: string; values: string[] }[];
  /** 文章にした示唆 */
  summary: string[];
  enough: boolean;
};

type Range = { min: number; max: number };

/** "550万円〜650万円" → {min:550,max:650} */
export function parseSalary(s: string | null | undefined): Range | null {
  if (!s) return null;
  const nums = [...s.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*万/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function sizeBucket(n: number | null | undefined) {
  if (!n) return null;
  if (n < 100) return "100 名未満";
  if (n < 1000) return "100〜999 名";
  return "1,000 名以上";
}

function features(j: J): [string, string][] {
  const out: [string, string][] = [];
  const pref = j.prefecture || j.location?.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/)?.[1];
  if (pref) out.push(["勤務地", pref]);
  const jt = j.jobTypeSmallCategory || j.jobType;
  if (jt) out.push(["職種", jt]);
  const ind = j.industryCategory || j.industry;
  if (ind) out.push(["業界", ind]);
  const size = sizeBucket(j.employeeCount);
  if (size) out.push(["企業規模", size]);
  if (j.workStyle) out.push(["働き方", j.workStyle]);
  for (const t of j.tags ?? []) if (t) out.push(["条件", t]);
  return out;
}

export function buildInsights(liked: J[], passed: J[]): Insights {
  const map = new Map<string, FeatureStat>();
  const add = (jobs: J[], key: "like" | "pass") => {
    for (const j of jobs) {
      const seen = new Set<string>();
      for (const [group, value] of features(j)) {
        const k = `${group}\u0000${value}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const f = map.get(k) ?? { group, value, like: 0, pass: 0 };
        f[key]++;
        map.set(k, f);
      }
    }
  };
  add(liked, "like");
  add(passed, "pass");

  const L = liked.length;
  const P = passed.length;
  const base = L + P ? L / (L + P) : 0;
  const all = [...map.values()];
  const rate = (f: FeatureStat) => f.like / (f.like + f.pass);
  const minLike = L >= 6 ? 2 : 1;

  const likedFeat = all
    .filter((f) => f.like >= minLike && (f.pass === 0 || rate(f) >= base + 0.15))
    .sort((a, b) => b.like - a.like || rate(b) - rate(a))
    .slice(0, 8);
  const avoided = all
    .filter((f) => f.pass >= 3 && rate(f) <= base * 0.5)
    .sort((a, b) => b.pass - a.pass)
    .slice(0, 6);
  const common = L >= 3 ? all.filter((f) => f.like / L >= 0.8).sort((a, b) => b.like - a.like).slice(0, 6) : [];

  // 年収：Like した求人の「下限」のうち一番低いもの（この金額以上なら検討対象になりそう）
  const likedFloors = liked.map((j) => parseSalary(j.salary)?.min).filter((n): n is number => n !== undefined);
  const salaryFloor = likedFloors.length ? Math.min(...likedFloors) : null;
  const salary = {
    like: salaryFloor === null ? null : { min: salaryFloor, max: Math.max(...liked.map((j) => parseSalary(j.salary)?.max ?? 0)) },
    pass: null as Range | null,
  };

  // Like した職種（Like が少なくても全部出す）
  const jobTypes = all
    .filter((f) => f.group === "職種" && f.like > 0)
    .sort((a, b) => b.like - a.like);

  // 検索条件案
  const search: Insights["search"] = [];
  if (jobTypes.length) search.push({ label: "職種", values: jobTypes.slice(0, 5).map((f) => f.value) });
  for (const group of ["勤務地", "業界", "条件"]) {
    const values = all
      .filter((f) => f.group === group && f.like >= minLike && rate(f) >= base)
      .sort((a, b) => b.like - a.like)
      .slice(0, group === "条件" ? 5 : 3)
      .map((f) => f.value);
    if (values.length) search.push({ label: group, values });
  }
  if (salaryFloor !== null) search.push({ label: "想定年収", values: [`${Math.round(salaryFloor)}万円〜（Like 求人の下限で一番低い額）`] });

  const summary: string[] = [];
  const fmt = (f: FeatureStat) => `「${f.value}」（Like ${f.like} 件 / Pass ${f.pass} 件）`;
  if (jobTypes.length) {
    summary.push(
      `Like した職種：${jobTypes.slice(0, 5).map((f) => `${f.value}（${f.like} 件）`).join("、")}。この職種を中心に探していそうです。`,
    );
  }
  if (salaryFloor !== null) {
    summary.push(`Like した求人の年収の下限は、一番低いもので ${Math.round(salaryFloor)}万円。この金額以上なら検討対象になりそうです。`);
  }
  if (common.length) summary.push(`Like した求人のほぼすべてが ${common.filter((f) => f.group !== "職種").slice(0, 3).map((f) => `「${f.value}」`).join("・") || "同じ条件"} に当てはまります。外せない条件の可能性があります。`);
  const nonCommon = likedFeat.filter((f) => !common.includes(f) && f.group !== "職種");
  if (nonCommon.length) summary.push(`Like に偏っている特徴：${nonCommon.slice(0, 4).map(fmt).join("、")}。`);
  if (avoided.length) summary.push(`Pass に偏っている特徴：${avoided.slice(0, 3).map(fmt).join("、")}。避けたい条件かもしれないので架電で確認を。`);
  if (L === 0) summary.push("まだ Like した求人がないため、傾向は出せません。");

  return {
    likes: L,
    passes: P,
    liked: likedFeat,
    avoided,
    common,
    salary,
    search,
    summary,
    enough: L + P >= 5 && L >= 1,
  };
}

/** エージェントに共有しやすいテキスト */
export function insightsText(name: string, ins: Insights) {
  const lines = [`【${name}様 スワイプ傾向】Like ${ins.likes} 件 / Pass ${ins.passes} 件`];
  for (const s of ins.summary) lines.push(`・${s}`);
  if (ins.search.length) {
    lines.push("", "■ 他求人を探すときの条件案");
    for (const g of ins.search) lines.push(`・${g.label}：${g.values.join(" / ")}`);
  }
  return lines.join("\n");
}
