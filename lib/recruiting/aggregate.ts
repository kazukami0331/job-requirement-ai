import { Application, FunnelStage, MergedApplication } from "@/types/recruiting";
import { ACTIVE_STAGES, FUNNEL_STEPS, STAGES, stageOf } from "./status";
import { Week, weekOf, weekOfIso, weekRange } from "./week";

export type Dimension = "shopShortName" | "employmentType" | "media" | "route" | "jobTitle";

export const DIMENSION_LABEL: Record<Dimension, string> = {
  shopShortName: "校舎",
  employmentType: "雇用形態",
  media: "媒体",
  route: "応募経路",
  jobTitle: "職種",
};

function emptyStageCount(): Record<FunnelStage, number> {
  return {
    applied: 0,
    untouched: 0,
    scheduling: 0,
    interviewScheduled: 0,
    interviewed: 0,
    hired: 0,
    rejectedBefore: 0,
    rejectedAfter: 0,
  };
}

export interface WeeklyPoint {
  week: Week;
  /** その週に受け付けた応募数 */
  applied: number;
  /** その週の応募者の「現在地」の内訳 */
  byStage: Record<FunnelStage, number>;
  /** 面接設定まで到達した数 */
  scheduled: number;
  /** 面接実施まで到達した数 */
  interviewed: number;
  /** 採用に至った数 */
  hired: number;
  /** まだ選考中の数 */
  activePool: number;
}

/** 応募受付日ベースの週次推移。データの無い週も0で埋める。 */
export function weeklyTrend(apps: Application[]): WeeklyPoint[] {
  if (apps.length === 0) return [];

  const sorted = [...apps].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const weeks = weekRange(sorted[0].receivedAt, sorted[sorted.length - 1].receivedAt);

  const buckets = new Map<string, WeeklyPoint>();
  for (const week of weeks) {
    buckets.set(week.key, {
      week,
      applied: 0,
      byStage: emptyStageCount(),
      scheduled: 0,
      interviewed: 0,
      hired: 0,
      activePool: 0,
    });
  }

  for (const app of apps) {
    const point = buckets.get(weekOfIso(app.receivedAt).key);
    if (!point) continue;
    const stage = stageOf(app.statusId);
    point.applied++;
    point.byStage[stage]++;
    if (FUNNEL_STEPS[1].reached(stage)) point.scheduled++;
    if (FUNNEL_STEPS[2].reached(stage)) point.interviewed++;
    if (stage === "hired") point.hired++;
    if (ACTIVE_STAGES.includes(stage)) point.activePool++;
  }

  return [...buckets.values()];
}

/** 現在の選考ステータス別プール（＝いま何人がどこに溜まっているか） */
export function stagePool(apps: Application[]): { stage: FunnelStage; label: string; count: number; color: string }[] {
  const counts = emptyStageCount();
  for (const app of apps) counts[stageOf(app.statusId)]++;
  return STAGES.map((s) => ({ stage: s.key, label: s.label, count: counts[s.key], color: s.color }));
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** 直前ステップからの転換率（0〜1）。先頭ステップはnull。 */
  conversionFromPrev: number | null;
  /** 応募数に対する通過率（0〜1） */
  conversionFromTop: number;
}

/** 応募 → 面接設定 → 面接実施 → 採用 の通過ファネル */
export function funnel(apps: Application[]): FunnelStep[] {
  const counts = FUNNEL_STEPS.map((step) => apps.filter((a) => step.reached(stageOf(a.statusId))).length);
  const top = counts[0] || 0;
  return FUNNEL_STEPS.map((step, i) => ({
    key: step.key,
    label: step.label,
    count: counts[i],
    conversionFromPrev: i === 0 ? null : counts[i - 1] > 0 ? counts[i] / counts[i - 1] : 0,
    conversionFromTop: top > 0 ? counts[i] / top : 0,
  }));
}

export interface BreakdownRow {
  key: string;
  applied: number;
  byStage: Record<FunnelStage, number>;
  activePool: number;
  scheduled: number;
  interviewed: number;
  hired: number;
  /** 直近週の応募数 */
  lastWeekApplied: number;
  /** その前の週の応募数 */
  prevWeekApplied: number;
}

/** 任意の軸（校舎・雇用形態・媒体…）での内訳 */
export function breakdown(
  apps: Application[],
  dimension: Dimension,
  weeks: { lastWeekKey?: string; prevWeekKey?: string } = {}
): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();

  for (const app of apps) {
    const key = (app[dimension] || "(不明)") as string;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        applied: 0,
        byStage: emptyStageCount(),
        activePool: 0,
        scheduled: 0,
        interviewed: 0,
        hired: 0,
        lastWeekApplied: 0,
        prevWeekApplied: 0,
      };
      rows.set(key, row);
    }

    const stage = stageOf(app.statusId);
    row.applied++;
    row.byStage[stage]++;
    if (ACTIVE_STAGES.includes(stage)) row.activePool++;
    if (FUNNEL_STEPS[1].reached(stage)) row.scheduled++;
    if (FUNNEL_STEPS[2].reached(stage)) row.interviewed++;
    if (stage === "hired") row.hired++;

    const wk = weekOfIso(app.receivedAt).key;
    if (weeks.lastWeekKey && wk === weeks.lastWeekKey) row.lastWeekApplied++;
    if (weeks.prevWeekKey && wk === weeks.prevWeekKey) row.prevWeekApplied++;
  }

  return [...rows.values()].sort((a, b) => b.applied - a.applied || a.key.localeCompare(b.key, "ja"));
}

/** 軸 × 週 のクロス集計（週次で校舎ごとの動きを見るための表） */
export interface Matrix {
  weeks: Week[];
  rows: { key: string; counts: number[]; total: number }[];
}

export function weeklyMatrix(apps: Application[], dimension: Dimension, maxWeeks = 12): Matrix {
  const trend = weeklyTrend(apps);
  const weeks = trend.slice(-maxWeeks).map((p) => p.week);
  const index = new Map(weeks.map((w, i) => [w.key, i]));

  const rows = new Map<string, number[]>();
  for (const app of apps) {
    const i = index.get(weekOfIso(app.receivedAt).key);
    if (i === undefined) continue;
    const key = (app[dimension] || "(不明)") as string;
    let counts = rows.get(key);
    if (!counts) {
      counts = new Array(weeks.length).fill(0);
      rows.set(key, counts);
    }
    counts[i]++;
  }

  return {
    weeks,
    rows: [...rows.entries()]
      .map(([key, counts]) => ({ key, counts, total: counts.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key, "ja")),
  };
}

export interface Kpis {
  totalApplied: number;
  activePool: number;
  hired: number;
  interviewScheduled: number;
  lastWeekApplied: number;
  prevWeekApplied: number;
  /** 前週差 */
  wowDelta: number;
  /** 直近4週の平均応募数 */
  avg4w: number;
  /** 応募→採用の転換率 */
  hireRate: number;
}

export function kpis(apps: Application[], weeks?: RecentWeeks): Kpis {
  const trend = weeklyTrend(apps);
  const at = (key?: string) => (key ? (trend.find((p) => p.week.key === key)?.applied ?? 0) : 0);
  // 週の指定があればそれに従う。無ければ「データがある最後の週」を直近週とみなす。
  const lastWeekApplied = weeks?.lastWeek ? at(weeks.lastWeekKey) : (trend[trend.length - 1]?.applied ?? 0);
  const prevWeekApplied = weeks?.prevWeek ? at(weeks.prevWeekKey) : (trend[trend.length - 2]?.applied ?? 0);
  const recent = trend.slice(-4);
  const pool = stagePool(apps);
  const activePool = pool.filter((p) => ACTIVE_STAGES.includes(p.stage)).reduce((a, b) => a + b.count, 0);
  const hired = pool.find((p) => p.stage === "hired")?.count ?? 0;

  return {
    totalApplied: apps.length,
    activePool,
    hired,
    interviewScheduled: pool.find((p) => p.stage === "interviewScheduled")?.count ?? 0,
    lastWeekApplied,
    prevWeekApplied,
    wowDelta: lastWeekApplied - prevWeekApplied,
    avg4w: recent.length > 0 ? recent.reduce((a, b) => a + b.applied, 0) / recent.length : 0,
    hireRate: apps.length > 0 ? hired / apps.length : 0,
  };
}

export interface RecentWeeks {
  lastWeekKey?: string;
  prevWeekKey?: string;
  lastWeek?: Week;
  prevWeek?: Week;
}

/**
 * 直近週と前週（前週比や週別の数字に使う）。
 *
 * asOfIso（データを書き出した日）を渡すと、その日を含む週を直近週にする。
 * 渡さないと「応募が1件でもある最後の週」が直近週になるため、週の頭にまだ応募が
 * 無いだけで直近週が1週ズレ、前週の数字が前々週のものになってしまう。
 * 定例が週の途中にある運用ではこのズレがそのまま報告の誤りになる。
 */
export function recentWeekKeys(apps: Application[], asOfIso?: string): RecentWeeks {
  let lastWeek: Week | undefined;
  if (asOfIso) {
    lastWeek = weekOfIso(asOfIso);
  } else {
    const trend = weeklyTrend(apps);
    lastWeek = trend[trend.length - 1]?.week;
  }
  if (!lastWeek) return {};
  const before = new Date(`${lastWeek.start}T00:00:00`);
  before.setDate(before.getDate() - 7);
  const prevWeek = weekOf(before);
  return { lastWeekKey: lastWeek.key, prevWeekKey: prevWeek.key, lastWeek, prevWeek };
}

/** 不採用・辞退の理由内訳 */
export function rejectReasons(apps: MergedApplication[] | Application[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const app of apps) {
    const stage = stageOf(app.statusId);
    if (stage !== "rejectedBefore" && stage !== "rejectedAfter") continue;
    const reason = app.rejectReason || "(理由未入力)";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}
