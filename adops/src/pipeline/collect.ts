/** 段階1: 配信中・停止中の広告の実績を媒体から取り込む。 */
import type { Ctx } from './context.ts';
import { mergeMetrics } from '../optimize/stats.ts';
import { addDays } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('collect');

export async function collectMetrics(ctx: Ctx, days = 14): Promise<string> {
  const { store, today } = ctx;
  const since = addDays(today, -(days - 1));
  const targets = store.creatives({ status: ['published', 'paused', 'retired'] }).filter((c) => !c.publishedAt || c.publishedAt.slice(0, 10) >= addDays(today, -60));
  let metaRows = 0;
  let googleRows = 0;

  if (ctx.meta) {
    const adToCreative = new Map<string, string>();
    for (const c of targets) for (const id of c.platformRefs.meta?.adIds ?? []) adToCreative.set(id, c.id);
    if (adToCreative.size) {
      const byAd = await ctx.meta.insights([...adToCreative.keys()], since, today);
      // 1クリエイティブを複数広告セットに入れている場合は日別に合算する
      const byCreative = new Map<string, Map<string, { impressions: number; clicks: number; spend: number; conversions: number; videoViews: number }>>();
      for (const [adId, rows] of byAd) {
        const cid = adToCreative.get(adId)!;
        const days = byCreative.get(cid) ?? new Map();
        for (const r of rows) {
          const d = days.get(r.date) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0, videoViews: 0 };
          d.impressions += r.impressions;
          d.clicks += r.clicks;
          d.spend += r.spend;
          d.conversions += r.conversions;
          d.videoViews += r.videoViews ?? 0;
          days.set(r.date, d);
          metaRows++;
        }
        byCreative.set(cid, days);
      }
      for (const [cid, days] of byCreative) {
        const c = store.state.creatives[cid];
        c.metrics = mergeMetrics(c.metrics, [...days.entries()].map(([date, d]) => ({ date, platform: 'meta' as const, ...d })));
      }
    }
  }

  if (ctx.google) {
    const adToCreative = new Map<string, string>();
    for (const c of targets) for (const rn of c.platformRefs.google?.linkedTo ?? []) if (rn.includes('/adGroupAds/')) adToCreative.set(rn, c.id);
    if (adToCreative.size) {
      const byAd = await ctx.google.adMetrics([...adToCreative.keys()], since, today);
      const grouped = new Map<string, Map<string, { impressions: number; clicks: number; spend: number; conversions: number }>>();
      for (const [rn, rows] of byAd) {
        const cid = adToCreative.get(rn);
        if (!cid) continue;
        const days = grouped.get(cid) ?? new Map();
        for (const r of rows) {
          const d = days.get(r.date) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
          d.impressions += r.impressions;
          d.clicks += r.clicks;
          d.spend += r.spend;
          d.conversions += r.conversions;
          days.set(r.date, d);
          googleRows++;
        }
        grouped.set(cid, days);
      }
      for (const [cid, days] of grouped) {
        const c = store.state.creatives[cid];
        c.metrics = mergeMetrics(c.metrics, [...days.entries()].map(([date, d]) => ({ date, platform: 'google' as const, ...d })));
      }
    }
  }

  const note = `対象 ${targets.length} 本 / Meta ${metaRows} 行 / Google ${googleRows} 行（${since}〜${today}）`;
  log.info(note);
  return note;
}
