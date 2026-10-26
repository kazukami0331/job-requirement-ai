/**
 * 段階: Google 検索広告（レスポンシブ検索広告）の入れ替え。
 *
 * 広告グループごとに「現行 + 挑戦者」の2本を回す。
 * - 2本とも十分に表示され、片方の CTR（応募があれば応募率）が明らかに低ければ止める
 * - 2本未満なら、既存と違う言い回しで挑戦者を AI が作って入れる
 * 検索語・入札・予算は人（または Google の自動入札）に任せ、コピーの改善だけを自動化する。
 */
import type { Ctx } from './context.ts';
import { placeholderProblems } from '../config.ts';
import type { SearchAd } from '../types.ts';
import { writeRsa } from '../agents/searchWriter.ts';
import { withUtm } from '../platforms/meta.ts';
import { mergeMetrics, totals, windowed } from '../optimize/stats.ts';
import { addDays, daysBetween, newId } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('search');
const PER_AD_GROUP = 2;
const MIN_IMPRESSIONS = 2000;
const MIN_AGE_DAYS = 14;

export interface SearchDecision {
  adId: string;
  reason: string;
}

/** 負けている検索広告を選ぶ（純粋関数）。 */
export function pickSearchLosers(ads: SearchAd[], today: string): SearchDecision[] {
  const from = addDays(today, -13);
  const byGroup = new Map<string, SearchAd[]>();
  for (const a of ads.filter((a) => a.status === 'live')) byGroup.set(a.adGroupId, [...(byGroup.get(a.adGroupId) ?? []), a]);
  const out: SearchDecision[] = [];
  for (const list of byGroup.values()) {
    if (list.length < 2) continue;
    const scored = list
      .map((a) => ({ a, t: totals(windowed(a.metrics, from, today)) }))
      .filter((x) => x.t.impressions >= MIN_IMPRESSIONS && daysBetween(x.a.createdOn, today) >= MIN_AGE_DAYS);
    if (scored.length < 2) continue;
    // 応募が両方に3件以上あれば応募率（表示あたり）、なければ CTR で比べる
    const useConv = scored.every((x) => x.t.conversions >= 3);
    const rate = (x: (typeof scored)[number]) => (useConv ? x.t.conversions / x.t.impressions : x.t.ctr);
    scored.sort((p, q) => rate(q) - rate(p));
    const best = scored[0];
    for (const x of scored.slice(1)) {
      if (rate(x) < rate(best) * 0.7) {
        out.push({
          adId: x.a.id,
          reason: useConv
            ? `応募率が現行最良の7割未満（${((rate(x) / rate(best)) * 100).toFixed(0)}%）`
            : `CTR ${x.t.ctr.toFixed(2)}% が最良 ${best.t.ctr.toFixed(2)}% の7割未満`,
        });
      }
    }
  }
  return out;
}

export async function rotateSearchAds(ctx: Ctx): Promise<string> {
  const { store, catalog, today } = ctx;
  store.state.searchAds ??= {};
  const ads = store.state.searchAds;
  const jobs = catalog.jobs.filter((j) => j.active && j.placements.google?.searchAdGroupIds?.length);
  if (jobs.length === 0 && !Object.values(ads).some((a) => a.status === 'live')) return '検索広告の入稿先なし（jobs.json の placements.google.searchAdGroupIds）';
  const notes: string[] = [];

  // 1) 実績の取り込み
  const live = Object.values(ads).filter((a) => a.resourceName && a.status !== 'failed');
  if (ctx.google && live.length) {
    const byRn = await ctx.google.adMetrics(live.map((a) => a.resourceName!), addDays(today, -13), today);
    for (const a of live) a.metrics = mergeMetrics(a.metrics, byRn.get(a.resourceName!) ?? []);
  }

  // 2) 負けている広告と、募集が終わった求人の広告を止める
  const activeJobs = new Set(catalog.jobs.filter((j) => j.active).map((j) => j.id));
  const ended = Object.values(ads)
    .filter((a) => a.status === 'live' && !activeJobs.has(a.jobId))
    .map((a) => ({ adId: a.id, reason: '求人の募集が終了したため停止' }));
  for (const d of [...ended, ...pickSearchLosers(Object.values(ads).filter((a) => activeJobs.has(a.jobId)), today)]) {
    const a = ads[d.adId];
    if (ctx.dryRun || !ctx.google) {
      notes.push(`停止候補 ${a.id}: ${d.reason}（${ctx.dryRun ? 'DRY RUN' : 'Google 未設定'}）`);
      continue;
    }
    try {
      await ctx.google.setAdGroupAdStatus(a.resourceName!, 'PAUSED');
      a.status = 'paused';
      a.statusReason = d.reason;
      notes.push(`停止 ${a.id}: ${d.reason}`);
    } catch (e) {
      log.error(`${a.id} の停止に失敗: ${(e as Error).message}`);
    }
  }

  // 3) 足りない広告グループに挑戦者を作る（1回の実行で1グループ1本まで）
  const active = catalog.policy.autonomy === 'auto';
  for (const job of jobs) {
    for (const adGroupId of job.placements.google!.searchAdGroupIds!) {
      const inGroup = Object.values(ads).filter((a) => a.adGroupId === adGroupId && a.status === 'live');
      const drafts = Object.values(ads).filter((a) => a.adGroupId === adGroupId && a.status === 'draft');
      if (inGroup.length >= PER_AD_GROUP) continue;
      // DRY RUN の下書きは広告グループに1本だけ（確認用）。本番では下書きを捨てて実物を作る
      if ((ctx.dryRun || !ctx.google) && drafts.length) continue;
      if (!ctx.dryRun && ctx.google) for (const d of drafts) delete ads[d.id];
      // 同じ日に何度も作らない
      if (Object.values(ads).some((a) => a.adGroupId === adGroupId && a.status === 'live' && a.createdOn === today)) continue;
      // サンプル設定のままなら作らない（実際にお金がかかる入稿なので）
      if (!ctx.dryRun && placeholderProblems(catalog, job.id).length) {
        notes.push(`${job.id}: サンプル設定のままのため検索広告を作りません（${placeholderProblems(catalog, job.id).join(' / ')}）`);
        continue;
      }
      try {
        // 実際の検索語句があれば、それに答える見出しを作る（取得できなくても続行）
        const google = ctx.google;
        const terms = google ? await Promise.resolve().then(() => google.searchTerms(adGroupId)).catch(() => []) : [];
        const rsa = await writeRsa(ctx.llm, job, catalog, inGroup.flatMap((a) => a.headlines), terms);
        if (rsa.headlines.length < 8 || rsa.descriptions.length < 2) {
          notes.push(`${job.id}: 使える見出し・説明文が足りないため見送り（見出し ${rsa.headlines.length} / 説明文 ${rsa.descriptions.length}）`);
          continue;
        }
        const ad: SearchAd = {
          id: newId('rsa'),
          jobId: job.id,
          adGroupId,
          headlines: rsa.headlines,
          descriptions: rsa.descriptions,
          path1: rsa.path1 || undefined,
          path2: rsa.path2 || undefined,
          status: 'draft',
          metrics: [],
          createdAt: new Date().toISOString(),
          createdOn: today,
        };
        if (rsa.dropped.length) log.info(`${ad.id}: 除外 ${rsa.dropped.length} 件\n${rsa.dropped.join('\n')}`);
        if (!ctx.dryRun && ctx.google) {
          ad.resourceName = await ctx.google.createDemandGenAd(
            adGroupId,
            {
              finalUrls: [withUtm(job.landingUrl, 'google', ad.id)],
              responsiveSearchAd: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
                ...(ad.path1 ? { path1: ad.path1 } : {}),
                ...(ad.path2 ? { path2: ad.path2 } : {}),
              },
            },
            active,
          );
          ad.status = 'live';
          ad.statusReason = active ? '配信開始' : '停止状態で入稿（管理画面で ON にしてください）';
        }
        ads[ad.id] = ad;
        store.save();
        notes.push(`${ad.status === 'live' ? '入稿' : '下書き'} ${ad.id}（${job.id} / 見出し ${ad.headlines.length}本）`);
      } catch (e) {
        notes.push(`${job.id}: 検索広告の作成に失敗 ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  return notes.join(' / ') || '変更なし';
}
