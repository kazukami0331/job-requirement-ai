/**
 * 段階7: Instagram のオーガニック投稿。
 * 広告で反応の良かった素材（CTR が基準以上）を優先し、無ければ当日制作した素材を投稿する。
 * 動画があればリール、無ければフィード画像。キャプションは SNS 投稿エージェントが書き、広告と同じ機械チェックを通す。
 */
import { existsSync } from 'node:fs';
import type { Ctx } from './context.ts';
import type { Creative } from '../types.ts';
import { InstagramClient } from '../platforms/instagram.ts';
import { writeCaption } from '../agents/socialWriter.ts';
import { checkTexts, hasBlocker } from '../compliance/rules.ts';
import { lastNDays, totals } from '../optimize/stats.ts';
import { jstDate } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('organic');

/** 投稿候補を良い順に並べる。 */
export function organicCandidates(ctx: Ctx): { c: Creative; kind: 'feed' | 'reels'; path: string; score: number }[] {
  const o = ctx.catalog.policy.organic!;
  const out: { c: Creative; kind: 'feed' | 'reels'; path: string; score: number }[] = [];
  for (const c of ctx.store.creatives({ status: ['produced', 'published', 'paused', 'retired'] })) {
    if (c.organic) continue;
    const reel = c.assets.find((a) => a.kind === 'video' && a.ratio === '9:16' && existsSync(a.path));
    const feed = c.assets.find((a) => a.kind === 'image' && a.ratio === '4:5' && existsSync(a.path));
    if (!reel && !feed) continue;
    const t = totals(lastNDays(c.metrics, ctx.today, 14));
    const proven = t.impressions >= 2000 && t.ctr >= o.minAdCtrForRepost;
    // 実績のある素材 > 新しい素材。動画は少し優先（リールは非フォロワーに届きやすい）
    const score = (proven ? 100 + t.ctr * 10 : 0) + (reel ? 5 : 0) + (c.status === 'produced' ? 1 : 0);
    out.push({ c, kind: reel ? 'reels' : 'feed', path: (reel ?? feed)!.path, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function postOrganic(ctx: Ctx): Promise<string> {
  const o = ctx.catalog.policy.organic;
  if (!o?.enabled) return 'オーガニック投稿は無効（policy.organic.enabled）';
  const postedToday = ctx.store.creatives().filter((c) => c.organic && jstDate(new Date(c.organic.postedAt)) === ctx.today).length;
  const quota = Math.max(0, o.postsPerDay - postedToday);
  if (quota === 0) return '本日の投稿数の上限に達しています';
  const candidates = organicCandidates(ctx).slice(0, quota);
  if (candidates.length === 0) return '投稿できる素材がありません';
  const ig = !ctx.dryRun && ctx.settings.meta.instagramUserId && ctx.settings.meta.accessToken ? new InstagramClient(ctx.settings.meta) : null;

  const done: string[] = [];
  for (const { c, kind, path } of candidates) {
    const brief = ctx.store.state.briefs[c.briefId];
    const job = ctx.catalog.jobs.find((j) => j.id === c.jobId);
    if (!brief || !job) continue;
    try {
      const caption = await writeCaption(ctx.llm, brief, ctx.catalog, kind, o.baseHashtags);
      const issues = checkTexts([['caption', caption]], job, ctx.catalog.brand);
      if (hasBlocker(issues)) {
        log.warn(`${c.id}: キャプションが機械チェックで不合格のため投稿しません: ${issues.filter((i) => i.severity === 'blocker').map((i) => i.problem).join(' / ')}`);
        continue;
      }
      if (!ig) {
        done.push(`${c.id}(${kind}, 未投稿: ${ctx.dryRun ? 'DRY RUN' : 'Instagram 未設定'})`);
        log.info(`[投稿予定] ${c.id} ${kind}\n${caption}`);
        continue;
      }
      const r = kind === 'reels' ? await ig.postReel(path, caption) : await ig.postImage(path, caption);
      c.organic = { kind, mediaId: r.id, permalink: r.permalink, postedAt: new Date().toISOString(), caption, insights: [] };
      done.push(`${c.id}(${kind}) ${r.permalink}`);
      log.info(`Instagram に投稿 ${c.id} ${r.permalink}`);
      ctx.store.save();
    } catch (e) {
      log.error(`${c.id}: Instagram 投稿に失敗 ${(e as Error).message}`);
    }
  }
  return done.length ? done.join(' / ') : '投稿なし';
}

/** 直近14日の投稿の反応を取り込む。 */
export async function collectOrganic(ctx: Ctx): Promise<string> {
  if (!ctx.catalog.policy.organic?.enabled || !ctx.settings.meta.instagramUserId || !ctx.settings.meta.accessToken) return '対象外';
  const ig = new InstagramClient(ctx.settings.meta);
  const recent = ctx.store.creatives().filter((c) => c.organic && Date.now() - Date.parse(c.organic.postedAt) < 14 * 86_400_000);
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
