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
  /** 面接設定 → 内定 の歩留まり */
  interviewToOffer: number;
}

export const DEFAULT_RATES: GoalRates = { applyToInterview: 0.3, interviewToOffer: 0.6 };

/** 1名採るのに必要な応募数。歩留まりが0なら計算できないので null。 */
export function appliesPerHire(r: GoalRates): number | null {
  const through = r.applyToInterview * r.interviewToOffer;
  return through > 0 ? 1 / through : null;
}

export interface MonthGoal {
  /** YYYY-MM */
  month: string;
  /** 表示用 例: 9月 */
  label: string;
  targetApplied: number;
  targetInterview: number;
  targetOffer: number;
  appliedActual: number;
  interviewActual: number;
  offerActual: number;
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
  deadline: string;
  /** 期限の解釈。表になぜその月数で割ったのかを出すために持つ。 */
  deadlineNote: string;
  /** 採用目標を満たすのに必要な応募の総数 */
  requiredApplied: number;
  months: MonthGoal[];
}

export interface MonthlyGoals {
  months: { month: string; label: string; current: boolean; elapsed: number }[];
  rows: ShopGoalRow[];
  /** 全校舎の合計 */
  total: ShopGoalRow | null;
  /** 実績から出した歩留まり。想定値が実態と合っているかを見るため。 */
  observed: { applied: number; interview: number; offer: number } | null;
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
 * 月次目標と進捗。
 *
 * - 目標は「当月から期限の月まで」で均等割り。期限が過ぎているもの・即日・未記入は当月に寄せる
 *   （未記入はマスタ内で一番遅い期限に合わせる）。
 * - 面接・内定の実績は「その月に応募した人がどこまで進んだか」で数える（コホート）。
 *   歩留まりは同じ人を追いかけたときの割合なので、月をまたいだ面接実施件数で割っても
 *   想定値と比べられないため。
 */
export function monthlyGoals(
  apps: Application[],
  plan: HiringPlan | null,
  rates: GoalRates,
  asOfIso?: string
): MonthlyGoals {
  const perHire = appliesPerHire(rates);
  if (!plan || perHire === null) return { months: [], rows: [], total: null, observed: null };

  const shortages = shortageByShop(plan).filter((s) => s.shortage > 0);
  if (shortages.length === 0) return { months: [], rows: [], total: null, observed: null };

  const asOf = asOfIso ?? new Date().toISOString();
  const startMonth = monthKey(asOf);

  // マスタ内で一番遅い期限。期限が入っていない校舎はここに合わせる。
  const latest = shortages
    .map((s) => deadlineMonth(s.deadline))
    .filter((m): m is string => m !== null && monthsBetween(startMonth, m) >= 0)
    .sort()
    .pop();

  // 実績を 校舎 × 応募月 で数える
  type Counts = { applied: number; interview: number; offer: number };
  const actual = new Map<string, Counts>();
  const bump = (shopKey: string, month: string, f: (c: Counts) => void) => {
    const k = `${shopKey}|${month}`;
    const c = actual.get(k) ?? { applied: 0, interview: 0, offer: 0 };
    f(c);
    actual.set(k, c);
  };
  const observed: Counts = { applied: 0, interview: 0, offer: 0 };
  for (const a of apps) {
    const stage = stageOf(a.statusId);
    const reachedInterview = FUNNEL_STEPS[1].reached(stage);
    const hired = stage === "hired";
    bump(normalizeShopKey(a.shopShortName), monthKey(a.receivedDate), (c) => {
      c.applied++;
      if (reachedInterview) c.interview++;
      if (hired) c.offer++;
    });
    observed.applied++;
    if (reachedInterview) observed.interview++;
    if (hired) observed.offer++;
  }

  // 表に出す月の範囲。どの校舎かによらず同じ列にしたいので、一番遠い期限まで並べる。
  const lastMonth = shortages
    .map((s) => deadlineMonth(s.deadline) ?? latest ?? startMonth)
    .filter((m) => monthsBetween(startMonth, m) >= 0)
    .sort()
    .pop();
  const windowSpan = Math.min(Math.max(monthsBetween(startMonth, lastMonth ?? startMonth), 0), 11);
  // 当月は途中なので、何割過ぎたかを持たせる。月末までの見込みと突き合わせるために使う。
  const asOfDay = Number(asOf.slice(8, 10));
  const daysInMonth = new Date(Number(startMonth.slice(0, 4)), Number(startMonth.slice(5, 7)), 0).getDate();
  const months = Array.from({ length: windowSpan + 1 }, (_, i) => {
    const month = addMonths(startMonth, i);
    return {
      month,
      label: monthLabel(month),
      current: i === 0,
      elapsed: i === 0 ? Math.min(asOfDay / daysInMonth, 1) : 0,
    };
  });

  const rows: ShopGoalRow[] = shortages.map((s) => {
    const key = normalizeShopKey(s.shopShortName);
    const requiredApplied = Math.ceil(s.shortage * perHire);

    const dm = deadlineMonth(s.deadline);
    let endMonth: string;
    let deadlineNote: string;
    if (dm && monthsBetween(startMonth, dm) >= 0) {
      endMonth = dm;
      deadlineNote = `${s.deadline} まで`;
    } else if (dm) {
      // 期限がもう過ぎている
      endMonth = startMonth;
      deadlineNote = `期限超過（${s.deadline}）のため今月に寄せています`;
    } else if (/即日/.test(s.deadline)) {
      endMonth = startMonth;
      deadlineNote = "即日のため今月に寄せています";
    } else {
      endMonth = latest ?? startMonth;
      deadlineNote = latest
        ? `期限未記入のため、マスタで一番遅い ${monthLabel(latest)} までで割っています`
        : "期限未記入のため今月に寄せています";
    }

    const shopSpan = Math.max(monthsBetween(startMonth, endMonth), 0) + 1;
    const perMonth = spread(requiredApplied, shopSpan);

    return {
      shopShortName: s.shopShortName,
      urgent: s.urgent,
      hireTarget: s.shortage,
      deadline: s.deadline,
      deadlineNote,
      requiredApplied,
      months: months.map((m, i) => {
        const targetApplied = i < shopSpan ? perMonth[i] : 0;
        const c = actual.get(`${key}|${m.month}`) ?? { applied: 0, interview: 0, offer: 0 };
        return {
          ...m,
          targetApplied,
          targetInterview: targetApplied * rates.applyToInterview,
          targetOffer: targetApplied * rates.applyToInterview * rates.interviewToOffer,
          appliedActual: c.applied,
          interviewActual: c.interview,
          offerActual: c.offer,
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
          deadline: "",
          deadlineNote: "",
          requiredApplied: rows.reduce((a, r) => a + r.requiredApplied, 0),
          months: months.map((m, i) => ({
            ...m,
            targetApplied: rows.reduce((a, r) => a + r.months[i].targetApplied, 0),
            targetInterview: rows.reduce((a, r) => a + r.months[i].targetInterview, 0),
            targetOffer: rows.reduce((a, r) => a + r.months[i].targetOffer, 0),
            appliedActual: rows.reduce((a, r) => a + r.months[i].appliedActual, 0),
            interviewActual: rows.reduce((a, r) => a + r.months[i].interviewActual, 0),
            offerActual: rows.reduce((a, r) => a + r.months[i].offerActual, 0),
          })),
        };

  return { months, rows, total, observed: observed.applied > 0 ? observed : null };
}

/** 目標に対する進捗。目標0のときは比率が出せないので null。 */
export function progress(actual: number, target: number): number | null {
  return target > 0 ? actual / target : null;
}
