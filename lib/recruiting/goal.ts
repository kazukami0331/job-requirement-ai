import { Application, HiringPlan } from "@/types/recruiting";
import { FUNNEL_STEPS, stageOf } from "./status";
import { normalizeShopKey } from "./shops";
import { shortageByShop } from "./plan";

/**
 * 採用目標から逆算した月次の応募目標と、その進捗。
 *
 * 不足人数マスタにあるのは「何名採りたいか」だけなので、そこから
 *   採用 ← 面接 ← 応募
 * と歩留まりで割り戻して、月ごとに何件の応募が要るかを出す。
 */

export interface GoalRates {
  /** 応募 → 面接設定 の歩留まり */
  applyToInterview: number;
  /** 面接設定 → 採用 の歩留まり */
  interviewToHire: number;
}

export const DEFAULT_RATES: GoalRates = { applyToInterview: 0.3, interviewToHire: 0.6 };

/** 1名採るのに必要な応募数。歩留まりが0なら計算できないので null。 */
export function appliesPerHire(r: GoalRates): number | null {
  const through = r.applyToInterview * r.interviewToHire;
  return through > 0 ? 1 / through : null;
}

/** 目標を按分する期間。両端を含む。 */
export interface GoalWindow {
  /** YYYY-MM */
  from: string;
  /** YYYY-MM */
  to: string;
}

export interface MonthGoal {
  /** YYYY-MM */
  month: string;
  /** 表示用 例: 9月 */
  label: string;
  targetApplied: number;
  targetInterview: number;
  targetHire: number;
  appliedActual: number;
  interviewActual: number;
  hireActual: number;
  /** 集計基準日を含む月 */
  current: boolean;
  /** その月のうち何割が過ぎているか。当月だけ1未満になる。 */
  elapsed: number;
}

export interface ShopGoalRow {
  shopShortName: string;
  urgent: boolean;
  /** 採用目標（不足人数マスタの人数） */
  hireTarget: number;
  /** 期間が始まる前にすでに採用できていた人数。ここを起点に残りを積む。 */
  alreadyHired: number;
  /** 目標から既採用を引いた、これから採る人数 */
  remainingTarget: number;
  deadline: string;
  /** 期限など、その行の前提を伝える注記 */
  deadlineNote: string;
  /** 残りの採用目標を満たすのに必要な応募の総数 */
  requiredApplied: number;
  months: MonthGoal[];
}

export interface MonthlyGoals {
  window: GoalWindow;
  /** 期間の選択肢（当月から、マスタで一番遅い期限まで） */
  choices: { month: string; label: string }[];
  months: { month: string; label: string; current: boolean; elapsed: number }[];
  rows: ShopGoalRow[];
  /** 全校舎の合計 */
  total: ShopGoalRow | null;
  /** 実績から出した歩留まり。想定値が実態と合っているかを見るため。 */
  observed: { applied: number; interview: number; hire: number } | null;
}

const monthKey = (iso: string) => iso.slice(0, 7);
const monthLabel = (key: string) => `${Number(key.slice(5, 7))}月`;

function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));

/** 期限セルを月キーに直す。"即日" や "-" や日付でないものは null。 */
function deadlineMonth(raw: string): string | null {
  const m = raw.match(/(\d{4})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
}

/**
 * 合計が total になるように n 個へ配る（最大剰余法）。
 * 単純に四捨五入すると月の合計が目標総数とずれて、表を足し算した人が混乱する。
 */
function spread(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const out = new Array<number>(n).fill(base);
  let rest = total - base * n;
  // 余りは前の月から乗せる。後ろに回すと期限直前だけ急に重くなる。
  for (let i = 0; i < n && rest > 0; i++, rest--) out[i]++;
  return out;
}

/**
 * 按分期間の初期値。
 *
 * 当月から、マスタで一番遅い期限の月まで。ただし当月の残りが4分の1を切っていたら翌月から始める。
 * 残り数日の月にひと月ぶんの目標を割り当てても、達成できないうえに他の月の目標まで軽くなるため。
 */
export function defaultWindow(plan: HiringPlan | null, asOfIso?: string): GoalWindow {
  const asOf = asOfIso ?? new Date().toISOString();
  const thisMonth = monthKey(asOf);
  const daysInMonth = new Date(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0).getDate();
  const left = (daysInMonth - Number(asOf.slice(8, 10)) + 1) / daysInMonth;
  const from = left < 0.25 ? addMonths(thisMonth, 1) : thisMonth;

  const latest = plan
    ? shortageByShop(plan)
        .filter((x) => x.shortage > 0)
        .map((x) => deadlineMonth(x.deadline))
        .filter((m): m is string => m !== null)
        .sort()
        .pop()
    : undefined;

  const to = latest && monthsBetween(from, latest) > 0 ? latest : from;
  return { from, to };
}

/**
 * 月次目標と進捗。
 *
 * - 目標は指定した期間（既定は当月〜マスタで一番遅い期限）で均等割り。
 *   期限がその期間より前に来る校舎はその月までで割り、期限超過・即日は先頭の月に寄せる。
 * - 面接・内定の実績は「その月に応募した人がどこまで進んだか」で数える（コホート）。
 *   歩留まりは同じ人を追いかけたときの割合なので、月をまたいだ面接実施件数で割っても
 *   想定値と比べられないため。
 */
export function monthlyGoals(
  apps: Application[],
  plan: HiringPlan | null,
  rates: GoalRates,
  asOfIso?: string,
  window?: GoalWindow
): MonthlyGoals {
  const asOf = asOfIso ?? new Date().toISOString();
  const win = window ?? defaultWindow(plan, asOf);
  const empty: MonthlyGoals = {
    window: win,
    choices: [],
    months: [],
    rows: [],
    total: null,
    observed: null,
  };

  const perHire = appliesPerHire(rates);
  if (!plan || perHire === null) return empty;

  // 緊急の校舎を先頭に。そのあとは採用目標が大きい順。
  const shortages = shortageByShop(plan)
    .filter((s) => s.shortage > 0)
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.shortage - a.shortage);
  if (shortages.length === 0) return empty;

  const startMonth = win.from;
  // 期間の終わり。開始より前を指定されても1ヶ月にはなるようにする。
  const endMonth = monthsBetween(startMonth, win.to) > 0 ? win.to : startMonth;

  // 実績を 校舎 × 応募月 で数える
  type Counts = { applied: number; interview: number; hire: number };
  const actual = new Map<string, Counts>();
  const bump = (shopKey: string, month: string, f: (c: Counts) => void) => {
    const k = `${shopKey}|${month}`;
    const c = actual.get(k) ?? { applied: 0, interview: 0, hire: 0 };
    f(c);
    actual.set(k, c);
  };
  const observed: Counts = { applied: 0, interview: 0, hire: 0 };
  // 期間が始まる前にすでに採用できている人数。目標はここからの残りぶんだけ積む。
  const hiredBefore = new Map<string, number>();
  for (const a of apps) {
    const stage = stageOf(a.statusId);
    const reachedInterview = FUNNEL_STEPS[1].reached(stage);
    const hired = stage === "hired";
    const key = normalizeShopKey(a.shopShortName);
    const month = monthKey(a.receivedDate);
    bump(key, month, (c) => {
      c.applied++;
      if (reachedInterview) c.interview++;
      if (hired) c.hire++;
    });
    if (hired && month < startMonth) hiredBefore.set(key, (hiredBefore.get(key) ?? 0) + 1);
    observed.applied++;
    if (reachedInterview) observed.interview++;
    if (hired) observed.hire++;
  }

  const windowSpan = Math.min(Math.max(monthsBetween(startMonth, endMonth), 0), 23);
  // 集計基準日を含む月は途中なので、何割過ぎたかを持たせる。目標のペースと突き合わせるのに使う。
  const nowMonth = monthKey(asOf);
  const months = Array.from({ length: windowSpan + 1 }, (_, i) => {
    const month = addMonths(startMonth, i);
    const current = month === nowMonth;
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    return {
      month,
      label: monthLabel(month),
      current,
      // 過ぎた月は満了、これからの月は0、当月だけ途中になる
      elapsed: current ? Math.min(Number(asOf.slice(8, 10)) / daysInMonth, 1) : month < nowMonth ? 1 : 0,
    };
  });

  // 期間の選択肢。当月の前後も選べるように、1ヶ月前からマスタで一番遅い期限の1ヶ月後まで並べる。
  const latestDeadline = shortages
    .map((x) => deadlineMonth(x.deadline))
    .filter((m): m is string => m !== null)
    .sort()
    .pop();
  const choiceFrom = addMonths(nowMonth, -1);
  const choiceTo = [latestDeadline ?? nowMonth, endMonth].sort().pop() as string;
  const choiceSpan = Math.min(Math.max(monthsBetween(choiceFrom, choiceTo), 0) + 1, 23);
  const choices = Array.from({ length: choiceSpan + 1 }, (_, i) => {
    const month = addMonths(choiceFrom, i);
    return { month, label: `${month.slice(0, 4)}年${monthLabel(month)}` };
  });

  const windowLabel = `${monthLabel(startMonth)}〜${monthLabel(endMonth)}`;

  const rows: ShopGoalRow[] = shortages.map((s) => {
    const key = normalizeShopKey(s.shopShortName);
    const alreadyHired = hiredBefore.get(key) ?? 0;
    const remainingTarget = Math.max(s.shortage - alreadyHired, 0);
    const requiredApplied = Math.ceil(remainingTarget * perHire);

    // 期限の早い校舎も含め、どの校舎も期間ぜんぶで均等に割る。
    // 期限は目安として注記に残すだけで、月の配分は変えない。
    const shopSpan = windowSpan + 1;
    const perMonth = spread(requiredApplied, shopSpan);
    const deadlineNote = [
      `${windowLabel} で均等に按分`,
      s.deadline && s.deadline !== "-" ? `期限 ${s.deadline}` : "期限未記入",
      alreadyHired > 0 ? `${monthLabel(startMonth)}より前に${alreadyHired}名採用済み（目標${s.shortage}名の残り${remainingTarget}名ぶん）` : null,
    ]
      .filter(Boolean)
      .join(" / ");

    return {
      shopShortName: s.shopShortName,
      urgent: s.urgent,
      hireTarget: s.shortage,
      alreadyHired,
      remainingTarget,
      deadline: s.deadline,
      deadlineNote,
      requiredApplied,
      months: months.map((m, i) => {
        const targetApplied = perMonth[i] ?? 0;
        const c = actual.get(`${key}|${m.month}`) ?? { applied: 0, interview: 0, hire: 0 };
        return {
          ...m,
          targetApplied,
          targetInterview: targetApplied * rates.applyToInterview,
          targetHire: targetApplied * rates.applyToInterview * rates.interviewToHire,
          appliedActual: c.applied,
          interviewActual: c.interview,
          hireActual: c.hire,
        };
      }),
    };
  });

  const total: ShopGoalRow | null =
    rows.length === 0
      ? null
      : {
          shopShortName: "合計",
          urgent: false,
          hireTarget: rows.reduce((a, r) => a + r.hireTarget, 0),
          alreadyHired: rows.reduce((a, r) => a + r.alreadyHired, 0),
          remainingTarget: rows.reduce((a, r) => a + r.remainingTarget, 0),
          deadline: "",
          deadlineNote: `${windowLabel} で均等に按分`,
          requiredApplied: rows.reduce((a, r) => a + r.requiredApplied, 0),
          months: months.map((m, i) => ({
            ...m,
            targetApplied: rows.reduce((a, r) => a + r.months[i].targetApplied, 0),
            targetInterview: rows.reduce((a, r) => a + r.months[i].targetInterview, 0),
            targetHire: rows.reduce((a, r) => a + r.months[i].targetHire, 0),
            appliedActual: rows.reduce((a, r) => a + r.months[i].appliedActual, 0),
            interviewActual: rows.reduce((a, r) => a + r.months[i].interviewActual, 0),
            hireActual: rows.reduce((a, r) => a + r.months[i].hireActual, 0),
          })),
        };

  return {
    window: { from: startMonth, to: endMonth },
    choices,
    months,
    rows,
    total,
    observed: observed.applied > 0 ? observed : null,
  };
}

/** 目標に対する進捗。目標0のときは比率が出せないので null。 */
export function progress(actual: number, target: number): number | null {
  return target > 0 ? actual / target : null;
}
