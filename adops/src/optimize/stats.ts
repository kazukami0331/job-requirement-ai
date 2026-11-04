/** 指標の集計（純粋関数）。 */
import type { Angle, Creative, DailyMetric, Platform } from '../types.ts';
import { addDays } from '../util/id.ts';

export interface Totals {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  videoViews: number;
  /** % */
  ctr: number;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  /** 応募率（%、クリック→応募） */
  cvr: number;
}

export function totals(metrics: DailyMetric[]): Totals {
  const t = metrics.reduce(
    (a, m) => ({
      impressions: a.impressions + m.impressions,
      clicks: a.clicks + m.clicks,
      spend: a.spend + m.spend,
      conversions: a.conversions + m.conversions,
      videoViews: a.videoViews + (m.videoViews ?? 0),
    }),
    { impressions: 0, clicks: 0, spend: 0, conversions: 0, videoViews: 0 },
  );
  return {
    ...t,
    ctr: t.impressions ? (t.clicks / t.impressions) * 100 : 0,
    cpc: t.clicks ? t.spend / t.clicks : null,
    cpm: t.impressions ? (t.spend / t.impressions) * 1000 : null,
    cpa: t.conversions ? t.spend / t.conversions : null,
    cvr: t.clicks ? (t.conversions / t.clicks) * 100 : 0,
  };
}

/** [from, to] の期間（両端含む）の指標だけ取り出す。 */
export function windowed(metrics: DailyMetric[], from: string, to: string, platform?: Platform): DailyMetric[] {
  return metrics.filter((m) => m.date >= from && m.date <= to && (!platform || m.platform === platform));
}

export function lastNDays(metrics: DailyMetric[], today: string, n: number): DailyMetric[] {
  return windowed(metrics, addDays(today, -(n - 1)), today);
}

/** 同じ日・同じ媒体の行は上書きする（再取得しても二重計上しない）。 */
export function mergeMetrics(existing: DailyMetric[], incoming: DailyMetric[]): DailyMetric[] {
  const key = (m: DailyMetric) => `${m.date}|${m.platform}`;
  const map = new Map(existing.map((m) => [key(m), m]));
  for (const m of incoming) map.set(key(m), m);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.platform < b.platform ? -1 : 1));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface GroupRow {
  key: string;
  count: number;
  totals: Totals;
}

/** 任意のキーで集計（訴求軸別・ペルソナ別・形式別など）。 */
export function groupBy(creatives: Creative[], keyOf: (c: Creative) => string, from: string, to: string): GroupRow[] {
  const groups = new Map<string, { count: number; metrics: DailyMetric[] }>();
  for (const c of creatives) {
    const k = keyOf(c);
    const g = groups.get(k) ?? { count: 0, metrics: [] };
    g.count++;
    g.metrics.push(...windowed(c.metrics, from, to));
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, count: g.count, totals: totals(g.metrics) }))
    .sort((a, b) => b.totals.impressions - a.totals.impressions);
}

/** 求人×訴求軸の累計（配分ロジックの事前分布に使う）。 */
export function angleTotals(creatives: Creative[], jobId: string, from: string, to: string): Map<Angle, Totals> {
  const out = new Map<Angle, Totals>();
  for (const row of groupBy(creatives.filter((c) => c.jobId === jobId), (c) => c.angle, from, to)) {
    out.set(row.key as Angle, row.totals);
  }
  return out;
}
