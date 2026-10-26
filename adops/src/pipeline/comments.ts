/**
 * 広告のコメント監視（Meta）。質問とネガティブは Slack に知らせ、スパムは自動で非表示にする。
 * 状態には投稿ごとの「どこまで見たか」だけを持ち、コメント本文は保存しない。
 */
import type { Ctx } from './context.ts';
import { triageComments } from '../agents/commentTriage.ts';
import { notifySlack } from '../notify/slack.ts';
import { formatYen } from '../compliance/rules.ts';
import { logger } from '../util/log.ts';

const log = logger('comments');

export async function watchComments(ctx: Ctx): Promise<string> {
  if (!ctx.meta || process.env.ADOPS_WATCH_COMMENTS !== 'true') return 'コメント監視は無効（ADOPS_WATCH_COMMENTS=true で有効）';
  const { store } = ctx;
  const seen = (store.state.commentCursor ??= {});
  const live = store.creatives({ status: ['published', 'paused'] }).filter((c) => c.platformRefs.meta?.creativeIds?.length);
  const autoHide = process.env.ADOPS_HIDE_SPAM !== 'false';
  const lines: string[] = [];
  let hidden = 0;
  for (const c of live.slice(0, 50)) {
    const meta = c.platformRefs.meta!;
    meta.storyId ??= (await ctx.meta.storyIdOf(meta.creativeIds[0])) ?? undefined;
    if (!meta.storyId) continue;
    // 初回は直近3日分だけ
    const since = seen[meta.storyId] ?? Math.floor(Date.now() / 1000) - 3 * 86_400;
    const comments = await ctx.meta.comments(meta.storyId, since).catch((e) => {
      log.warn(`${c.id}: コメントを取得できませんでした ${(e as Error).message}`);
      return [];
    });
    if (comments.length === 0) continue;
    const job = ctx.catalog.jobs.find((j) => j.id === c.jobId);
    const brief = store.state.briefs[c.briefId];
    const summary = job ? `${job.title}（${job.location}）${job.salary.type}${formatYen(job.salary.min)}〜 / ${job.perks.join('・')}` : c.jobId;
    const triaged = await triageComments(ctx.llm, summary, comments.map((x) => x.message));
    for (const t of triaged) {
      const cm = comments[t.index];
      if (t.kind === 'spam' && autoHide && !ctx.dryRun) {
        await ctx.meta.hideComment(cm.id).then(() => hidden++).catch((e) => log.warn(`非表示にできませんでした: ${(e as Error).message}`));
      } else if (t.kind === 'question' || t.kind === 'negative') {
        lines.push(
          `• ${t.kind === 'question' ? ':question: 質問' : ':warning: ネガティブ'}｜${job?.title ?? c.jobId}｜広告「${brief?.overlay.main ?? c.id}」\n> ${cm.message.slice(0, 200).replace(/\n/g, ' ')}${
            t.suggestedReply ? `\n返信案: ${t.suggestedReply}` : ''
          }\n<https://www.facebook.com/${cm.id}|コメントを開く>`,
        );
      }
    }
    seen[meta.storyId] = Math.max(...comments.map((x) => x.createdTime));
  }
  if (lines.length) {
    await notifySlack(ctx.settings.slack.webhookUrl, { text: [`:speech_balloon: *広告へのコメント（要対応 ${lines.length} 件）*`, ...lines.slice(0, 20)].join('\n') });
  }
  store.save();
  return `要対応 ${lines.length} 件 / スパム非表示 ${hidden} 件`;
}
