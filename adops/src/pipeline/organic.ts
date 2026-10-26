/**
 * 段階7: Instagram のオーガニック投稿。
 * 広告で反応の良かった素材（CTR が基準以上）を優先し、無ければ当日制作した素材を投稿する。
 * 動画があればリール、無ければフィード画像。キャプションは SNS 投稿エージェントが書き、広告と同じ機械チェックを通す。
 */
import { existsSync } from 'node:fs';
import type { Ctx } from './context.ts';
import type { Creative } from '../types.ts';
import { InstagramClient } from '../platforms/instagram.ts';
import { FacebookPageClient } from '../platforms/facebookPage.ts';
import { uploadToYoutube } from '../platforms/youtube.ts';
import { writeCaption } from '../agents/socialWriter.ts';
import { checkTexts, hasBlocker } from '../compliance/rules.ts';
import { lastNDays, totals } from '../optimize/stats.ts';
import { jstDate } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('organic');

/** 投稿候補を良い順に並べる。 */
export function organicCandidates(ctx: Ctx): { c: Creative; kind: 'feed' | 'reels' | 'carousel'; path: string; paths?: string[]; score: number }[] {
  const o = ctx.catalog.policy.organic!;
  const out: { c: Creative; kind: 'feed' | 'reels' | 'carousel'; path: string; paths?: string[]; score: number }[] = [];
  const draft = ctx.catalog.policy.autonomy === 'draft';
  const activeJobs = new Set(ctx.catalog.jobs.filter((j) => j.active).map((j) => j.id));
  for (const c of ctx.store.creatives({ status: ['produced', 'published', 'paused', 'retired'] })) {
    if (c.organic) continue;
    // 募集が終わった求人の素材は投稿しない
    if (!activeJobs.has(c.jobId)) continue;
    // 2回失敗した素材は使わない（同じ素材が毎日枠を占めて他が投稿されなくなるのを防ぐ）
    if ((c.organicFailures ?? 0) >= 2) continue;
    // draft モードでは、人が管理画面で ON にした（＝人が確認した）広告の素材だけを公開投稿に使う
    if (draft && c.live !== true) continue;
    const cards = c.assets.filter((a) => a.card !== undefined && existsSync(a.path)).sort((a, b) => a.card! - b.card!);
    const reel = c.assets.find((a) => a.kind === 'video' && a.ratio === '9:16' && existsSync(a.path));
    const feed = c.assets.find((a) => a.kind === 'image' && a.ratio === '4:5' && existsSync(a.path));
    if (!reel && !feed && cards.length < 2) continue;
    const t = totals(lastNDays(c.metrics, ctx.today, 14));
    const proven = t.impressions >= 2000 && t.ctr >= o.minAdCtrForRepost;
    // 実績のある素材 > 新しい素材。動画は少し優先（リールは非フォロワーに届きやすい）
    // カルーセルと動画は非フォロワーにも届きやすいので少し優先
    const score = (proven ? 100 + t.ctr * 10 : 0) + (reel || cards.length >= 2 ? 5 : 0) + (c.status === 'produced' ? 1 : 0);
    if (cards.length >= 2) out.push({ c, kind: 'carousel', path: cards[0].path, paths: cards.map((a) => a.path), score });
    else out.push({ c, kind: reel ? 'reels' : 'feed', path: (reel ?? feed)!.path, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function postOrganic(ctx: Ctx): Promise<string> {
  const o = ctx.catalog.policy.organic;
  if (!o?.enabled) return 'オーガニック投稿は無効（policy.organic.enabled）';
  const postedToday = ctx.store.creatives().filter((c) => c.organic && jstDate(new Date(c.organic.postedAt)) === ctx.today).length;
  const quota = Math.max(0, o.postsPerDay - postedToday);
  if (quota === 0) return '本日の投稿数の上限に達しています';
  const candidates = organicCandidates(ctx);
  if (candidates.length === 0) return '投稿できる素材がありません';
  const channels = o.channels?.length ? o.channels : ['instagram'];
  const meta = ctx.settings.meta;
  const g = ctx.settings.google;
  const ig = !ctx.dryRun && channels.includes('instagram') && meta.instagramUserId && meta.accessToken ? new InstagramClient(meta) : null;
  const fb = !ctx.dryRun && channels.includes('facebook') && meta.pageId && meta.accessToken ? new FacebookPageClient(meta) : null;
  const ytAuth =
    !ctx.dryRun && channels.includes('youtube') && g.clientId && (process.env.YOUTUBE_REFRESH_TOKEN || g.refreshToken)
      ? { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || g.refreshToken }
      : null;

  const done: string[] = [];
  let posted = 0;
  for (const { c, kind, path, paths } of candidates) {
    if (posted >= quota) break;
    const brief = ctx.store.state.briefs[c.briefId];
    const job = ctx.catalog.jobs.find((j) => j.id === c.jobId);
    if (!brief || !job) continue;
    try {
      const caption = await writeCaption(ctx.llm, brief, ctx.catalog, kind, o.baseHashtags);
      const issues = checkTexts([['caption', caption]], job, ctx.catalog.brand);
      if (hasBlocker(issues)) {
        c.organicFailures = (c.organicFailures ?? 0) + 1;
        log.warn(`${c.id}: キャプションが機械チェックで不合格のため投稿しません: ${issues.filter((i) => i.severity === 'blocker').map((i) => i.problem).join(' / ')}`);
        continue;
      }
      const video = c.assets.find((a) => a.kind === 'video' && a.ratio === '9:16' && existsSync(a.path));
      if (!ig && !fb && !(ytAuth && video)) {
        posted++;
        done.push(`${c.id}(${kind}, 未投稿: ${ctx.dryRun ? 'DRY RUN' : '投稿先が未設定'})`);
        log.info(`[投稿予定] ${c.id} ${kind}\n${caption}`);
        continue;
      }
      // 投稿先ごとに独立して試す（1つ失敗しても他は投稿する）。公開できたものはすぐ記録して二重投稿を防ぐ
      const record = (patch: Partial<NonNullable<Creative['organic']>>) => {
        c.organic = { kind, mediaId: '', permalink: '', postedAt: new Date().toISOString(), caption, insights: [], ...c.organic, ...patch };
        ctx.store.save();
      };
      const results: string[] = [];
      if (ig) {
        try {
          const r = kind === 'reels' ? await ig.postReel(path, caption) : kind === 'carousel' ? await ig.postCarousel(paths!, caption) : await ig.postImage(path, caption);
          record({ mediaId: r.id, permalink: r.permalink });
          results.push(`Instagram ${r.permalink}`);
        } catch (e) {
          log.error(`${c.id}: Instagram 投稿に失敗 ${(e as Error).message}`);
        }
      }
      if (fb) {
        try {
          const id = video && kind === 'reels' ? await fb.postVideo(video.path, caption) : kind === 'carousel' ? await fb.postPhotos(paths!, caption) : await fb.postPhoto(path, caption);
          record({ facebookPostId: id });
          results.push(`Facebook ${id}`);
        } catch (e) {
          log.error(`${c.id}: Facebook ページ投稿に失敗 ${(e as Error).message}`);
        }
      }
      if (ytAuth && video) {
        try {
          const id = await uploadToYoutube(ytAuth, video.path, {
            title: `${brief.overlay.main}｜${job.title} #shorts`,
            description: `${caption}\n\n${job.landingUrl}`,
            privacy: 'public',
          });
          record({ youtubeVideoId: id });
          results.push(`YouTube https://youtube.com/shorts/${id}`);
        } catch (e) {
          log.error(`${c.id}: YouTube ショート投稿に失敗 ${(e as Error).message}`);
        }
      }
      if (results.length) {
        posted++;
        done.push(`${c.id}(${kind}) ${results.join(' / ')}`);
        log.info(`オーガニック投稿 ${c.id}: ${results.join(' / ')}`);
      } else {
        c.organicFailures = (c.organicFailures ?? 0) + 1;
      }
    } catch (e) {
      c.organicFailures = (c.organicFailures ?? 0) + 1;
      log.error(`${c.id}: オーガニック投稿の準備に失敗 ${(e as Error).message}`);
    }
  }
  return done.length ? done.join(' / ') : '投稿なし';
}

/** 直近14日の投稿の反応を取り込む。 */
export async function collectOrganic(ctx: Ctx): Promise<string> {
  if (!ctx.catalog.policy.organic?.enabled || !ctx.settings.meta.instagramUserId || !ctx.settings.meta.accessToken) return '対象外';
  const ig = new InstagramClient(ctx.settings.meta);
  // Instagram に投稿したものだけ（mediaId が空なのは Facebook / YouTube のみの投稿）
  const recent = ctx.store.creatives().filter((c) => c.organic?.mediaId && Date.now() - Date.parse(c.organic.postedAt) < 14 * 86_400_000);
  for (const c of recent) {
    try {
      const snap = await ig.insights(c.organic!.mediaId, ctx.today);
      c.organic!.insights = [...c.organic!.insights.filter((x) => x.date !== ctx.today), snap];
    } catch (e) {
      log.warn(`${c.id}: 投稿の反応を取得できませんでした ${(e as Error).message}`);
    }
  }
  return `投稿 ${recent.length} 件の反応を更新`;
}
