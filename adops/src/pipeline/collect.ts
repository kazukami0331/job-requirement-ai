/** 段階1: 配信中・停止中の広告の実績を媒体から取り込む。 */
import type { Ctx } from './context.ts';
import { mergeMetrics } from '../optimize/stats.ts';
import { addDays } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('collect');

/**
 * 媒体側の配信状態・審査結果を取り込む。
 * - 下書き入稿した広告を人が ON にしたら live=true（停止判断・同時配信数の対象になる）
 * - 審査落ち（全媒体）なら failed にして理由を残す
 * - こちらで止めた広告を人が管理画面で再開したら published に戻す（人の判断を優先）
 */
export async function syncStatuses(ctx: Ctx): Promise<string> {
  const { store } = ctx;
  const targets = store.creatives({ status: ['published', 'paused'] });
  const metaIds = targets.flatMap((c) => c.platformRefs.meta?.adIds ?? []);
  const googleAds = targets.flatMap((c) => (c.platformRefs.google?.linkedTo ?? []).filter((rn) => rn.includes('/adGroupAds/')));
  const meta = ctx.meta && metaIds.length ? await ctx.meta.adStatuses(metaIds) : new Map<string, { status: string; review?: string }>();
  const google = ctx.google && googleAds.length ? await ctx.google.adStatuses(googleAds) : new Map<string, { status: string; approval: string; topics: string }>();
  let disapproved = 0;
  let resumed = 0;
  for (const c of targets) {
    const m = (c.platformRefs.meta?.adIds ?? []).map((id) => meta.get(id)).filter((x): x is { status: string; review?: string } => Boolean(x));
    const g = (c.platformRefs.google?.linkedTo ?? []).map((rn) => google.get(rn)).filter((x): x is { status: string; approval: string; topics: string } => Boolean(x));
    if (m.length === 0 && g.length === 0) continue; // 取得できなかった（P-MAX のみ等）は触らない
    const metaLive = m.some((x) => x.status === 'ACTIVE');
    const googleLive = g.some((x) => x.status === 'ENABLED' && x.approval !== 'DISAPPROVED');
    c.live = metaLive || googleLive;
    if (c.platformRefs.meta && m.length) c.platformRefs.meta.status = [...new Set(m.map((x) => x.status))].join(',');
    if (c.platformRefs.google && g.length) c.platformRefs.google.status = [...new Set(g.map((x) => `${x.status}/${x.approval}`))].join(',');
    const hasPmax = (c.platformRefs.google?.linkedTo ?? []).some((rn) => rn.includes('/assetGroupAssets/'));
    const allDisapproved = !hasPmax && m.every((x) => x.status === 'DISAPPROVED') && g.every((x) => x.approval === 'DISAPPROVED');
    if (allDisapproved) {
      const why = [...m.map((x) => x.review), ...g.map((x) => x.topics)].filter(Boolean).join(' / ');
      store.setStatus(c, 'failed', `媒体審査で不承認: ${why || '理由不明'}`);
      disapproved++;
    } else if (c.status === 'paused' && c.live) {
      store.setStatus(c, 'published', '管理画面で再開されたため配信中として扱います');
      resumed++;
    }
  }
  return `状態同期 ${targets.length} 本（不承認 ${disapproved} / 人が再開 ${resumed}）`;
}

export async function collectMetrics(ctx: Ctx, days = 14): Promise<string> {
  let statusNote = '';
  try {
    statusNote = await syncStatuses(ctx);
  } catch (e) {
    statusNote = `状態同期に失敗: ${(e as Error).message}`;
    log.warn(statusNote);
  }
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

  const note = `対象 ${targets.length} 本 / Meta ${metaRows} 行 / Google ${googleRows} 行（${since}〜${today}）/ ${statusNote}`;
  log.info(note);
  return note;
}
