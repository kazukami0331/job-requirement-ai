/**
 * 段階6: 入稿。制作が済んだクリエイティブを Meta / Google に入れる。
 * draft モードでは「停止状態」で入れ、人が媒体の管理画面で ON にする。
 */
import { existsSync } from 'node:fs';
import type { Ctx } from './context.ts';
import type { Creative, Platform } from '../types.ts';
import { publishToMeta } from '../platforms/meta.ts';
import { publishToGoogle } from '../platforms/google.ts';
import { uploadToYoutube } from '../platforms/youtube.ts';
import { logger } from '../util/log.ts';

const log = logger('publish');
const MAX_RETRIES = 3;

export interface PublishSummary {
  published: Creative[];
  skipped: { creative: Creative; reason: string }[];
  failed: { creative: Creative; error: string }[];
}

export async function publish(ctx: Ctx): Promise<PublishSummary> {
  const { store, catalog } = ctx;
  const active = catalog.policy.autonomy === 'auto';
  const summary: PublishSummary = { published: [], skipped: [], failed: [] };

  // 制作済みに加え、一部の媒体だけ入稿に失敗したもの（最大3回まで）を再試行する
  const queue = [
    ...store.creatives({ status: 'produced' }),
    ...store.creatives({ status: 'published' }).filter((c) => c.pendingPlatforms?.length && (c.publishRetries ?? 0) < MAX_RETRIES),
  ];
  for (const c of queue) {
    const retrying = c.status === 'published';
    const brief = store.state.briefs[c.briefId];
    const job = catalog.jobs.find((j) => j.id === c.jobId);
    if (!job || !brief) {
      summary.skipped.push({ creative: c, reason: '求人または企画が見つからない（jobs.json から削除された等）' });
      continue;
    }
    if (!job.active) {
      summary.skipped.push({ creative: c, reason: '求人が停止中' });
      continue;
    }
    const wantMeta = Boolean(ctx.meta && job.placements.meta?.adsetIds?.length) && (!retrying || c.pendingPlatforms!.includes('meta'));
    // P-MAX は停止状態で入れられないので、draft モードでは対象外（デマンド ジェネレーションだけ）
    // カルーセルは Meta だけ（Google には同じ形式が無いので入れない）
    const googleTargets =
      c.format === 'carousel' ? 0 : (job.placements.google?.adGroupIds?.length ?? 0) + (active ? job.placements.google?.assetGroupIds?.length ?? 0 : 0);
    const wantGoogle =
      Boolean(ctx.google && googleTargets > 0) &&
      (!retrying || c.pendingPlatforms!.includes('google'));
    if (!wantMeta && !wantGoogle) {
      if (retrying) c.pendingPlatforms = [];
      else summary.skipped.push({ creative: c, reason: '入稿先の媒体が未設定（API キーまたは jobs.json の placements）' });
      continue;
    }
    if (c.assets.some((a) => !existsSync(a.path))) {
      if (retrying) {
        // 配信中のものを作り直すと二重入稿になるので、再試行はあきらめる
        c.pendingPlatforms = [];
        continue;
      }
      // 前回の実行環境で作った素材が無い → 作り直す（画像生成の依頼結果は残っているので再合成だけ）
      c.assets = [];
      store.setStatus(c, 'planned', '素材ファイルが見つからないため再制作します');
      summary.skipped.push({ creative: c, reason: '素材ファイルなし（次回再制作）' });
      continue;
    }
    if (ctx.dryRun) {
      summary.skipped.push({ creative: c, reason: 'DRY RUN（ADOPS_DRY_RUN=false で入稿）' });
      continue;
    }
    const errors: string[] = [];
    if (wantMeta && !c.platformRefs.meta?.adIds?.length) {
      try {
        const r = await publishToMeta(ctx.meta!, c, brief, job, active);
        // 一部の広告セットだけ成功した場合も、作成済みの広告は必ず記録する
        if (r.adIds.length) c.platformRefs.meta = { adIds: r.adIds, creativeIds: r.creativeIds, status: active ? 'ACTIVE' : 'PAUSED', previewUrl: r.previewUrl };
        errors.push(...r.errors.map((e) => `Meta: ${e}`));
      } catch (e) {
        errors.push(`Meta: ${(e as Error).message}`);
      }
      store.save();
    }
    if (wantGoogle && !c.platformRefs.google?.linkedTo?.length) {
      try {
        let youtubeVideoId = c.platformRefs.google?.youtubeVideoId;
        const video = c.assets.find((a) => a.kind === 'video' && a.ratio === '9:16');
        if (video && !youtubeVideoId) {
          const g = ctx.settings.google;
          youtubeVideoId = await uploadToYoutube(
            { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || g.refreshToken },
            video.path,
            { title: `${brief.overlay.main}｜${job.title}`, description: `${brief.primaryText}\n${job.landingUrl}` },
          );
          // 後段で失敗しても同じ動画を再アップロードしないよう、すぐ記録する
          c.platformRefs.google = { assetResourceNames: [], linkedTo: [], youtubeVideoId };
          store.save();
        }
        const r = await publishToGoogle(ctx.google!, c, brief, job, active, { youtubeVideoId });
        c.platformRefs.google = { assetResourceNames: r.assetResourceNames, linkedTo: r.linkedTo, youtubeVideoId, status: active ? 'ENABLED' : 'PAUSED' };
        errors.push(...r.errors.map((e) => `Google: ${e}`));
      } catch (e) {
        errors.push(`Google: ${(e as Error).message}`);
      }
      store.save();
    }
    const metaOk = Boolean(c.platformRefs.meta?.adIds?.length);
    const googleOk = Boolean(c.platformRefs.google?.linkedTo?.length);
    const pending: Platform[] = [];
    if (wantMeta && !metaOk) pending.push('meta');
    if (wantGoogle && !googleOk) pending.push('google');
    if (metaOk || googleOk) {
      if (retrying) c.publishRetries = (c.publishRetries ?? 0) + 1;
      c.pendingPlatforms = pending;
      if (!retrying) {
        c.publishedAt = new Date().toISOString();
        store.setStatus(c, 'published', errors.length ? `一部失敗: ${errors.join(' / ')}` : active ? '配信開始' : '停止状態で入稿（管理画面で ON にしてください）');
        summary.published.push(c);
      } else if (errors.length) {
        c.statusReason = `再入稿の一部失敗: ${errors.join(' / ')}`.slice(0, 800);
      }
    } else {
      // 媒体審査で落ちる等の恒久的な失敗が多いので、何度も再送しないよう failed にする
      store.setStatus(c, 'failed', errors.join(' / ').slice(0, 800));
      summary.failed.push({ creative: c, error: errors.join(' / ') });
    }
    if (errors.length) {
      log.warn(`${c.id}: ${errors.join(' / ')}`);
      if (metaOk || googleOk) summary.failed.push({ creative: c, error: `一部の入稿先で失敗: ${errors.join(' / ')}` });
    }
    store.save();
  }
  return summary;
}
