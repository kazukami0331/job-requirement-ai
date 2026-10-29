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
  /** そのうち充足に効いた人数（校舎の目標までで頭打ち） */
  hireFilledActual: number;
  /** 集計基準日を含む月 */
  current: boolean;
  /** 按分期間より前の月。目標は無く、実績だけを出す。 */
  actualOnly: boolean;
  /** その月のうち何割が過ぎているか。当月だけ1未満になる。 */
  elapsed: number;
}

export interface ShopGoalRow {
  shopShortName: string;
  urgent: boolean;
  /** 採用目標（不足人数マスタの人数） */
  hireTarget: number;
  /** 採用できた人数。目標を超えて採れた場合はその数のまま入る。 */
  alreadyHired: number;
  /**
   * そのうち目標の充足に効いた人数（目標までで頭打ち）。
   * 目標1名の校舎で2名採れても、他の校舎の不足は埋まらないので1名として数える。
   * 合計の「採用 / 目標 / 残り」はこちらで揃える。足し算が合わなくなるため。
   */
  filledHired: number;
  /** 目標から採用ぶんを引いた、これから採る人数 */
  remainingTarget: number;
  /** 充足率。目標0なら出せないので null。 */
  fillRate: number | null;
  deadline: string;
  /** 期限など、その行の前提を伝える注記 */
  deadlineNote: string;
  /** 残りの採用目標を満たすのに必要な応募の総数 */
  requiredApplied: number;
  /** 採用済みとして数えた人の、採用が決まった日の最初と最後。1人も居なければ null。 */
  hiredFrom: string | null;
  hiredTo: string | null;
  /** 按分期間が始まる時点で充足していた人数。月ごとの目標はここを起点に配る。 */
  filledAtStart: number;
  /** 月へ配った人数の合計（＝按分開始時点の残り） */
  planRemaining: number;
  months: MonthGoal[];
}

export interface MonthlyGoals {
  window: GoalWindow;
  /** 期間の選択肢（当月から、マスタで一番遅い期限まで） */
  choices: { month: string; label: string }[];
  months: { month: string; label: string; current: boolean; elapsed: number; actualOnly: boolean }[];
  rows: ShopGoalRow[];
  /** 全校舎の合計 */
  total: ShopGoalRow | null;
  /** 実績から出した歩留まり。想定値が実態と合っているかを見るため。 */
  observed: { applied: number; interview: number; hire: number } | null;
  /**
   * 期間内の応募のうち、この表に出ている件数と全体の件数。
   * 不足人数マスタに無い校舎の応募は表に出てこないので、表の合計だけ見ると
   * 応募が実際より少なく見える。その差を数字で示すために持つ。
   */
  coverage: {
    inTable: number;
    all: number;
    /** 表に入らなかった校舎と件数（多い順）。どこが落ちているかを名前で出すため。 */
    missing: { shopShortName: string; count: number }[];
  };
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
 * その月が属する採用期の最初の月。期は9月始まり。
 * 不足人数マスタの期限が10/31・12/31で、募集も9月から動き出すため。
 */
function termStart(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return `${m >= 9 ? y : y - 1}-09`;
}

/**
 * 採用の残り人数を月へ配る。人は小数で採れないので必ず整数にする。
 *
 * 前の月から1名ずつ置いていき、足りなくなったら0。残り3名で3ヶ月なら 1/1/1、
 * 2名なら 1/1/0、1名なら 1/0/0。人数が月数より多いときだけ、前の月から2名以上を積む。
 */
function spreadHires(total: number, months: number): number[] {
  const out = new Array<number>(Math.max(months, 0)).fill(0);
  if (months <= 0 || total <= 0) return out;

  const base = Math.floor(total / months);
  let rest = total - base * months;
  for (let i = 0; i < months; i++) {
    out[i] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
  }
  return out;
}

/**
 * 按分期間の初期値。当月から、マスタで一番遅い期限の月まで。
 *
 * 月の終わりが近くても当月から始める。途中の月でも目標に対してどれだけ足りていないかが
 * 分かること自体に意味があるため（月末で始めると遅れが表に出ない）。
 */
/**
 * 合計を、採用目標を置いた月へ配る。
 * 端数は大きい月から1ずつ足して、月の合計が必ず元の数に戻るようにする。
 */
function spreadTotal(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((v) => Math.floor(v));
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (const [, i] of exact
    .map((v, i) => [v - Math.floor(v), i] as const)
    .sort((a, b) => b[0] - a[0])) {
    if (rest <= 0) break;
    out[i] += 1;
    rest -= 1;
  }
  return out;
}

export function defaultWindow(plan: HiringPlan | null, asOfIso?: string): GoalWindow {
  const asOf = asOfIso ?? new Date().toISOString();
  const thisMonth = monthKey(asOf);
  // 半分以上過ぎた月からは始めない。応募を集めて面接して採用するまでに数週間かかるので、
  // 残りわずかな月に採用目標を置いても達成しようがなく、他の月の目標まで軽くなる。
  const daysInMonth = new Date(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0).getDate();
  const elapsed = Number(asOf.slice(8, 10)) / daysInMonth;
  const from = elapsed < 0.5 ? thisMonth : addMonths(thisMonth, 1);

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
 * - 目標は指定した期間（既定は当月〜マスタで一番遅い期限）で、どの校舎も均等割り。
 *   期限は月の配分には使わず、注記として残すだけ。
 * - 期間が始まる前にすでに採用できている人数は差し引いてから割り戻す。
 * - 面接・採用の実績は「その月に応募した人がどこまで進んだか」で数える（コホート）。
 *   歩留まりは同じ人を追いかけたときの割合なので、月をまたいだ面接実施件数で割っても
 *   想定値と比べられないため。
 */
export function monthlyGoals(
  apps: Application[],
  plan: HiringPlan | null,
  rates: GoalRates,
  asOfIso?: string,
  window?: GoalWindow,
  /**
   * 「マスタに無い校舎の応募が何件あるか」を数えるための、校舎で絞る前の応募。
   * 画面側でマスタ掲載校舎だけに絞ってから渡すと、apps だけでは差が0件になり、
   * 取りこぼしに気づけなくなるため、絞る前のものを別に受け取る。
   */
  coverageApps?: Application[],
  /**
   * 「その月に起きたこと」で数える実績。
   *
   * 採用は応募した月ではなく、採用が決まった月に立てる。
   * 月ごとの目標は「その月に何名採るか」なので、実績も同じ数え方でないと
   * 予実として比べられない（週次グラフの採用とも食い違う）。
   * 渡すのは、画面と同じ絞り込みをかけたうえで、採用・面接に至った日が
   * 期間内のものだけ。省略すると応募月で数える（旧来の見方）。
   */
  events?: { hires: Application[]; interviews: Application[] },
  /**
   * 実績だけを並べる月の開始。既定は採用期の頭（9月）。
   * 施策の開始が7/23のように期の途中なら、その月から実績を出す。
   */
  actualFrom?: string
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
    coverage: { inTable: 0, all: 0, missing: [] },
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
  type Counts = { applied: number; interview: number; hire: number; hireFilled: number };
  const actual = new Map<string, Counts>();
  const bump = (shopKey: string, month: string, f: (c: Counts) => void) => {
    const k = `${shopKey}|${month}`;
    const c = actual.get(k) ?? { applied: 0, interview: 0, hire: 0, hireFilled: 0 };
    f(c);
    actual.set(k, c);
  };
  const observed: Counts = { applied: 0, interview: 0, hire: 0, hireFilled: 0 };
  // 充足に効いた採用。目標はここからの残りぶんだけ積む。
  const hiredSoFar = new Map<string, number>();
  const hiredDates = new Map<string, string[]>();

  /** 採用・面接に至った日。ジョブオプの選考ステータス最終更新日を使う。 */
  const movedOn = (a: Application) => (a.statusUpdatedAt ?? a.receivedAt).slice(0, 10);

  for (const a of apps) {
    const stage = stageOf(a.statusId);
    const reachedInterview = FUNNEL_STEPS[1].reached(stage);
    const hired = stage === "hired";
    const key = normalizeShopKey(a.shopShortName);
    bump(key, monthKey(a.receivedDate), (c) => {
      c.applied++;
      // events を渡されたときは、面接・採用はそちらで数える
      if (!events && reachedInterview) c.interview++;
      if (!events && hired) {
        c.hire++;
        c.hireFilled++;
      }
    });
    if (!events && hired) {
      hiredSoFar.set(key, (hiredSoFar.get(key) ?? 0) + 1);
      hiredDates.set(key, [...(hiredDates.get(key) ?? []), a.receivedDate]);
    }
    observed.applied++;
    if (reachedInterview) observed.interview++;
    if (hired) observed.hire++;
  }

  if (events) {
    for (const a of events.interviews) {
      bump(normalizeShopKey(a.shopShortName), monthKey(movedOn(a)), (c) => {
        c.interview++;
      });
    }
    /**
     * 採用を校舎ごとに決まった順へ並べ、目標の人数までを「充足に効いた採用」とする。
     *
     * 目標3名の校舎で5名採れても、充足は3名で止まる。残りの2名は
     * 他の校舎の不足を埋めないので、月の進捗にも乗せない（乗せると
     * 「10月 15/20」のように、充足していないぶんで達成に見えてしまう）。
     */
    const target = new Map(shortages.map((x) => [normalizeShopKey(x.shopShortName), x.shortage]));
    const seen = new Map<string, number>();
    for (const a of [...events.hires].sort((x, y) => movedOn(x).localeCompare(movedOn(y)))) {
      const key = normalizeShopKey(a.shopShortName);
      const rank = seen.get(key) ?? 0;
      seen.set(key, rank + 1);
      const counted = rank < (target.get(key) ?? 0);
      bump(key, monthKey(movedOn(a)), (c) => {
        c.hire++;
        if (counted) c.hireFilled++;
      });
      hiredSoFar.set(key, (hiredSoFar.get(key) ?? 0) + 1);
      // 「いつ決まった採用か」を出せるように、決まった日を控えておく
      hiredDates.set(key, [...(hiredDates.get(key) ?? []), movedOn(a)]);
    }
  }

  const windowSpan = Math.min(Math.max(monthsBetween(startMonth, endMonth), 0), 23);
  const nowMonth = monthKey(asOf);

  /**
   * 按分期間より前の月も、実績だけは並べる。
   *
   * 期の頭（9月）から今期ぶんをすべて出す。10月に入った途端に9月の列が消えると、
   * その月に何件来たのかが追えなくなるため。目標は持たせない。
   */
  const leading: string[] = [];
  for (
    let m = actualFrom ?? termStart(nowMonth);
    monthsBetween(m, startMonth) > 0 && leading.length < 12;
    m = addMonths(m, 1)
  ) {
    leading.push(m);
  }

  // 集計基準日を含む月は途中なので、何割過ぎたかを持たせる。目標のペースと突き合わせるのに使う。
  const months = [
    ...leading.map((month) => ({ month, actualOnly: true })),
    ...Array.from({ length: windowSpan + 1 }, (_, i) => ({ month: addMonths(startMonth, i), actualOnly: false })),
  ].map(({ month, actualOnly }) => {
    const current = month === nowMonth;
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    return {
      month,
      label: monthLabel(month),
      current,
      actualOnly,
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
    const alreadyHired = hiredSoFar.get(key) ?? 0;
    const filledHired = Math.min(alreadyHired, s.shortage);
    const remainingTarget = s.shortage - filledHired;
    const dates = [...(hiredDates.get(key) ?? [])].sort();

    /**
     * 月へ配るのは「按分期間が始まる時点で残っていた人数」。
     *
     * いまの残り（期間中に採れたぶんも引いた数）を配ると、その採用が
     * 「残りを減らす」と「その月の目標を埋める」の両方に効いてしまう。
     * 10月に15名採れたのに10月の目標も15名のまま、という状態になる。
     */
    const filledAtStart = events
      ? Math.min(
          (events.hires ?? []).filter(
            (h) => normalizeShopKey(h.shopShortName) === key && monthKey(movedOn(h)) < startMonth
          ).length,
          s.shortage
        )
      : filledHired;
    const planRemaining = Math.max(s.shortage - filledAtStart, 0);
    // 期限の早い校舎も含め、どの校舎も同じ月に配る。
    // 期限は目安として注記に残すだけで、月の配分は変えない。
    const planned = spreadHires(planRemaining, windowSpan + 1);
    // 先頭に付けた実績のみの月には目標を置かない
    const hirePerMonth = [...leading.map(() => 0), ...planned];
    // 採用目標から歩留まりで割り戻す。
    //
    // 切り上げるのは校舎ごとに1回だけ。月ごとに割り戻して切り上げると、
    // 1名あたり5.6件が6件になり、校舎の数だけ積み上がって1割近く膨らむ。
    const requiredApplied = Math.ceil(planRemaining * perHire);
    const requiredInterview = Math.ceil(planRemaining / rates.interviewToHire);
    const appliedPerMonth = spreadTotal(requiredApplied, hirePerMonth);
    const interviewPerMonth = spreadTotal(requiredInterview, hirePerMonth);
    const deadlineNote = [
      `${windowLabel} で均等に按分`,
      s.deadline && s.deadline !== "-" ? `期限 ${s.deadline}` : "期限未記入",
      alreadyHired > 0 ? `採用${alreadyHired}名ぶんを引いた残り${remainingTarget}名で計算` : null,
      alreadyHired > s.shortage ? `目標より${alreadyHired - s.shortage}名多く採用` : null,
    ]
      .filter(Boolean)
      .join(" / ");

    return {
      shopShortName: s.shopShortName,
      urgent: s.urgent,
      hireTarget: s.shortage,
      alreadyHired,
      filledHired,
      remainingTarget,
      fillRate: s.shortage > 0 ? filledHired / s.shortage : null,
      deadline: s.deadline,
      deadlineNote,
      requiredApplied,
      hiredFrom: dates[0] ?? null,
      hiredTo: dates[dates.length - 1] ?? null,
      filledAtStart,
      planRemaining,
      months: months.map((m, i) => {
        const c = actual.get(`${key}|${m.month}`) ?? { applied: 0, interview: 0, hire: 0, hireFilled: 0 };
        return {
          ...m,
          targetApplied: appliedPerMonth[i] ?? 0,
          targetInterview: interviewPerMonth[i] ?? 0,
          targetHire: hirePerMonth[i] ?? 0,
          appliedActual: c.applied,
          interviewActual: c.interview,
          hireActual: c.hire,
          hireFilledActual: c.hireFilled,
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
          filledHired: rows.reduce((a, r) => a + r.filledHired, 0),
          remainingTarget: rows.reduce((a, r) => a + r.remainingTarget, 0),
          fillRate: (() => {
            const t = rows.reduce((a, r) => a + r.hireTarget, 0);
            return t > 0 ? rows.reduce((a, r) => a + r.filledHired, 0) / t : null;
          })(),
          deadline: "",
          deadlineNote: `${windowLabel} で均等に按分`,
          requiredApplied: rows.reduce((a, r) => a + r.requiredApplied, 0),
          hiredFrom: rows.map((r) => r.hiredFrom).filter((d): d is string => d !== null).sort()[0] ?? null,
          hiredTo: rows.map((r) => r.hiredTo).filter((d): d is string => d !== null).sort().pop() ?? null,
          filledAtStart: rows.reduce((a, r) => a + r.filledAtStart, 0),
          planRemaining: rows.reduce((a, r) => a + r.planRemaining, 0),
          months: months.map((m, i) => ({
            ...m,
            targetApplied: rows.reduce((a, r) => a + r.months[i].targetApplied, 0),
            targetInterview: rows.reduce((a, r) => a + r.months[i].targetInterview, 0),
            targetHire: rows.reduce((a, r) => a + r.months[i].targetHire, 0),
            appliedActual: rows.reduce((a, r) => a + r.months[i].appliedActual, 0),
            interviewActual: rows.reduce((a, r) => a + r.months[i].interviewActual, 0),
            hireActual: rows.reduce((a, r) => a + r.months[i].hireActual, 0),
            hireFilledActual: rows.reduce((a, r) => a + r.months[i].hireFilledActual, 0),
          })),
        };

  // 期間内の応募のうち、表に出ている（＝マスタにある校舎の）件数と全体の件数
  const known = new Set(shortages.map((x) => normalizeShopKey(x.shopShortName)));
  const inWindow = months.map((m) => m.month);
  let inTable = 0;
  let all = 0;
  const missed = new Map<string, number>();
  for (const a of coverageApps ?? apps) {
    if (!inWindow.includes(monthKey(a.receivedDate))) continue;
    all++;
    if (known.has(normalizeShopKey(a.shopShortName))) {
      inTable++;
    } else {
      // 校舎名の揺れで落ちているのか、そもそも目標が無い校舎なのかを
      // 名前で見分けられるようにしておく
      missed.set(a.shopShortName, (missed.get(a.shopShortName) ?? 0) + 1);
    }
  }
  const missing = [...missed.entries()]
    .map(([shopShortName, count]) => ({ shopShortName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    window: { from: startMonth, to: endMonth },
    choices,
    months,
    rows,
    total,
    observed: observed.applied > 0 ? observed : null,
    coverage: { inTable, all, missing },
  };
}

/** 目標に対する進捗。目標0のときは比率が出せないので null。 */
export function progress(actual: number, target: number): number | null {
  return target > 0 ? actual / target : null;
}
