/** 段階2: 停止・入れ替え・予算調整の判断を出し、許可された範囲で媒体に反映する。 */
import type { Ctx } from './context.ts';
import type { Decision } from '../types.ts';
import { decide, type AdsetInfo } from '../optimize/decide.ts';
import { logger } from '../util/log.ts';
import { daysBetween } from '../util/id.ts';

const log = logger('optimize');

export async function optimize(ctx: Ctx): Promise<Decision[]> {
  const { store, catalog, today } = ctx;
  const adsetsByJob = new Map<string, AdsetInfo[]>();
  if (ctx.meta) {
    for (const job of catalog.jobs.filter((j) => j.active)) {
      const infos: AdsetInfo[] = [];
      for (const id of job.placements.meta?.adsetIds ?? []) {
        try {
          const a = await ctx.meta.getAdset(id);
          infos.push({ id: a.id, dailyBudget: a.dailyBudget });
        } catch (e) {
          log.warn(`広告セット ${id} の取得に失敗: ${(e as Error).message}`);
        }
      }
      if (infos.length) adsetsByJob.set(job.id, infos);
    }
  }

  // 同じ広告セットの予算は数日に1回だけ上げる（1日3回の実行のたびに上がらないように。学習のリセットも避ける）
  const cooldownDays = Number(process.env.ADOPS_BUDGET_COOLDOWN_DAYS ?? 3);
  const recentlyScaled = new Set(
    store.state.decisions
      .filter((d) => d.action === 'scale_budget' && d.applied && d.adsetId && daysBetween(d.date, today) < cooldownDays)
      .map((d) => d.adsetId!),
  );
  const decisions = decide({ creatives: store.creatives(), policy: catalog.policy, today, adsetsByJob, recentlyScaled });
  const auto = catalog.policy.autonomy === 'auto';

  for (const d of decisions) {
    try {
      if ((d.action === 'pause' || d.action === 'retire') && d.creativeId) {
        const c = store.state.creatives[d.creativeId];
        const metaAds = c.platformRefs.meta?.adIds ?? [];
        const googleRefs = c.platformRefs.google?.linkedTo ?? [];
        const onPlatform = metaAds.length + googleRefs.length > 0;
        if (onPlatform && !ctx.dryRun) {
          // 媒体に出ているのに API が未設定だと止められない。黙って「止めたこと」にしない
          if (metaAds.length && !ctx.meta) throw new Error('Meta の API が未設定のため停止できません');
          if (googleRefs.length && !ctx.google) throw new Error('Google 広告の API が未設定のため停止できません');
          for (const adId of metaAds) await ctx.meta!.stopAd(adId);
          for (const rn of googleRefs) if (rn.includes('/adGroupAds/')) await ctx.google!.setAdGroupAdStatus(rn, 'PAUSED');
          const pmax = googleRefs.filter((rn) => rn.includes('/assetGroupAssets/'));
          if (pmax.length) await ctx.google!.removeAssetGroupAssets(pmax);
          d.applied = true;
        }
        // 媒体に反映できたとき（または媒体に出ていないシミュレーション）だけ手元の状態を変える。
        // DRY RUN で状態だけ変えると、配信中の広告が監視対象から外れてしまう
        if (d.applied || !onPlatform) store.setStatus(c, d.action === 'retire' ? 'retired' : 'paused', d.reason);
      } else if (d.action === 'scale_budget' && d.adsetId) {
        // 予算を増やすのは auto モードのときだけ。draft モードでは提案として通知する
        if (auto && !ctx.dryRun && ctx.meta && !store.state.halted) {
          await ctx.meta.setAdsetDailyBudget(d.adsetId, Number(d.detail?.to));
          d.applied = true;
        }
      }
    } catch (e) {
      d.reason += `（反映失敗: ${(e as Error).message}）`;
      log.error(`判断の反映に失敗 ${d.action} ${d.creativeId ?? d.adsetId}: ${(e as Error).message}`);
    }
    store.state.decisions.push(d);
  }
  log.info(`判断 ${decisions.length} 件（停止 ${decisions.filter((d) => d.action === 'pause').length} / 疲弊入替 ${decisions.filter((d) => d.action === 'retire').length} / 予算増 ${decisions.filter((d) => d.action === 'scale_budget').length}）`);
  return decisions;
}
