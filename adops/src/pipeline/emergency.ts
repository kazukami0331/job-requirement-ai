/**
 * 緊急停止: adops が入稿した広告（Meta / Google デマンドジェネレーション / 検索広告）を媒体側ですべて停止する。
 * DRY RUN の設定に関係なく実行する（止める方向の操作なので）。P-MAX のアセットは外す。
 */
import type { Ctx } from './context.ts';
import { allPlacements } from '../config.ts';
import { logger } from '../util/log.ts';

const log = logger('emergency');

export async function emergencyStop(ctx: Ctx, reason = '緊急停止'): Promise<{ paused: number; errors: string[] }> {
  const { store } = ctx;
  let paused = 0;
  const errors: string[] = [];
  // 審査落ち（failed）も、再審査で配信が始まっている可能性があるので止める
  for (const c of store.creatives({ status: ['published', 'paused', 'retired', 'failed'] })) {
    const metaAds = c.platformRefs.meta?.adIds ?? [];
    const googleRefs = c.platformRefs.google?.linkedTo ?? [];
    let ok = true;
    for (const id of metaAds) {
      try {
        if (!ctx.meta) throw new Error('Meta の API が未設定');
        await ctx.meta.stopAd(id);
      } catch (e) {
        ok = false;
        errors.push(`${c.id} Meta ${id}: ${(e as Error).message}`);
      }
    }
    for (const rn of googleRefs) {
      try {
        if (!ctx.google) throw new Error('Google 広告の API が未設定');
        if (rn.includes('/adGroupAds/')) await ctx.google.setAdGroupAdStatus(rn, 'PAUSED');
        else if (rn.includes('/assetGroupAssets/')) await ctx.google.removeAssetGroupAssets([rn]);
      } catch (e) {
        ok = false;
        errors.push(`${c.id} Google ${rn}: ${(e as Error).message}`);
      }
    }
    if (ok && (metaAds.length || googleRefs.length) && c.status === 'published') {
      store.setStatus(c, 'paused', reason);
      c.live = false;
      paused++;
    }
  }
  // 記録に残る前に実行が打ち切られた広告（入稿の途中で緊急停止した等）も、広告セットを見て止める
  if (ctx.meta?.liveAdopsAds) {
    const known = new Set(store.creatives().flatMap((c) => c.platformRefs.meta?.adIds ?? []));
    for (const adsetId of new Set(ctx.catalog.jobs.flatMap((j) => allPlacements(j).flatMap((p) => p.meta?.adsetIds ?? [])))) {
      try {
        for (const ad of await ctx.meta.liveAdopsAds(adsetId)) {
          if (known.has(ad.id)) continue;
          await ctx.meta.stopAd(ad.id);
          log.warn(`記録に無い adops の広告 ${ad.id}（${ad.name}）を停止`);
          paused++;
        }
      } catch (e) {
        errors.push(`広告セット ${adsetId} の確認: ${(e as Error).message}`);
      }
    }
  }
  for (const a of Object.values(store.state.searchAds ?? {})) {
    if (a.status !== 'live' || !a.resourceName) continue;
    try {
      if (!ctx.google) throw new Error('Google 広告の API が未設定');
      await ctx.google.setAdGroupAdStatus(a.resourceName, 'PAUSED');
      a.status = 'paused';
      a.statusReason = reason;
      paused++;
    } catch (e) {
      errors.push(`${a.id}: ${(e as Error).message}`);
    }
  }
  store.state.decisions.push({ date: ctx.today, action: 'pause', reason: `${reason}（${paused} 件）`, applied: errors.length === 0 });
  // 解除（resume）するまで、定期実行でも新しい広告を作らない・出さない
  store.state.halted = { at: new Date().toISOString(), reason };
  store.save();
  log.warn(`緊急停止: ${paused} 件を停止 / 失敗 ${errors.length} 件`);
  return { paused, errors };
}
