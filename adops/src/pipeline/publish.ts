/**
 * 段階6: 入稿。制作が済んだクリエイティブを Meta / Google に入れる。
 * draft モードでは「停止状態」で入れ、人が媒体の管理画面で ON にする。
 */
import { existsSync } from 'node:fs';
import type { Ctx } from './context.ts';
import type { Creative } from '../types.ts';
import { publishToMeta } from '../platforms/meta.ts';
import { publishToGoogle } from '../platforms/google.ts';
import { uploadToYoutube } from '../platforms/youtube.ts';
import { logger } from '../util/log.ts';

const log = logger('publish');

export interface PublishSummary {
  published: Creative[];
  skipped: { creative: Creative; reason: string }[];
  failed: { creative: Creative; error: string }[];
}

export async function publish(ctx: Ctx): Promise<PublishSummary> {
  const { store, catalog } = ctx;
  const active = catalog.policy.autonomy === 'auto';
  const summary: PublishSummary = { published: [], skipped: [], failed: [] };

  for (const c of store.creatives({ status: 'produced' })) {
    const brief = store.state.briefs[c.briefId];
    const job = catalog.jobs.find((j) => j.id === c.jobId)!;
    if (!job.active) {
      summary.skipped.push({ creative: c, reason: '求人が停止中' });
      continue;
    }
    const wantMeta = Boolean(ctx.meta && job.placements.meta?.adsetIds?.length);
    const wantGoogle = Boolean(ctx.google && ((job.placements.google?.adGroupIds?.length ?? 0) + (job.placements.google?.assetGroupIds?.length ?? 0) > 0));
    if (!wantMeta && !wantGoogle) {
      summary.skipped.push({ creative: c, reason: '入稿先の媒体が未設定（API キーまたは jobs.json の placements）' });
      continue;
    }
    if (c.assets.some((a) => !existsSync(a.path))) {
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
        c.platformRefs.meta = { adIds: r.adIds, creativeIds: r.creativeIds, status: active ? 'ACTIVE' : 'PAUSED' };
      } catch (e) {
        errors.push(`Meta: ${(e as Error).message}`);
      }
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
        }
        const r = await publishToGoogle(ctx.google!, c, brief, job, active, { youtubeVideoId });
        c.platformRefs.google = { ...r, youtubeVideoId, status: active ? 'ENABLED' : 'PAUSED' };
      } catch (e) {
        errors.push(`Google: ${(e as Error).message}`);
      }
    }
    const anyOk = Boolean(c.platformRefs.meta?.adIds?.length || c.platformRefs.google?.linkedTo?.length);
    if (anyOk) {
      c.publishedAt = new Date().toISOString();
      store.setStatus(c, 'published', errors.length ? `一部失敗: ${errors.join(' / ')}` : active ? '配信開始' : '停止状態で入稿（管理画面で ON にしてください）');
      summary.published.push(c);
    } else {
      // 媒体審査で落ちる等の恒久的な失敗が多いので、何度も再送しないよう failed にする
      store.setStatus(c, 'failed', errors.join(' / ').slice(0, 800));
      summary.failed.push({ creative: c, error: errors.join(' / ') });
    }
    if (errors.length) log.warn(`${c.id}: ${errors.join(' / ')}`);
    store.save();
  }
  return summary;
}
