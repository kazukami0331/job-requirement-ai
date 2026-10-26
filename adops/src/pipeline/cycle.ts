/**
 * 1サイクル = 収集 → 最適化 → 分析 → 企画・レビュー → 制作 → 入稿 → 報告。
 * 毎日決まった時刻に GitHub Actions から実行する想定。各段階は独立して失敗を記録し、後続を止めない。
 */
import type { Ctx } from './context.ts';
import type { CycleRecord, Decision } from '../types.ts';
import { collectMetrics } from './collect.ts';
import { optimize } from './optimize.ts';
import { plan, type PlanResult } from './plan.ts';
import { produce } from './produce.ts';
import { publish, type PublishSummary } from './publish.ts';
import { collectOrganic, postOrganic } from './organic.ts';
import { importOutcomes } from './outcomes.ts';
import { rotateSearchAds } from './search.ts';
import { analyze } from '../agents/analyst.ts';
import { memoToSlack, shouldWriteMemo, writeMemo } from '../agents/strategyMemo.ts';
import { lastNDays, totals } from '../optimize/stats.ts';
import { notifySlack, sections } from '../notify/slack.ts';
import { approvalBlocks } from '../notify/approval.ts';
import { writeReport } from '../report/html.ts';
import { ANGLE_LABELS } from '../types.ts';
import { daysBetween } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('cycle');

export type StepName = 'collect' | 'optimize' | 'analyze' | 'plan' | 'produce' | 'publish' | 'search' | 'organic' | 'report';
export const ALL_STEPS: StepName[] = ['collect', 'optimize', 'analyze', 'plan', 'produce', 'publish', 'search', 'organic', 'report'];

/** 緊急停止中でも動かしてよい段階（実績の取り込み・停止判断・分析・報告だけ） */
const SAFE_WHEN_HALTED: StepName[] = ['collect', 'optimize', 'analyze', 'report'];

export async function runCycle(ctx: Ctx, requested: StepName[] = ALL_STEPS): Promise<CycleRecord> {
  const { store } = ctx;
  const halted = store.state.halted;
  const steps = halted ? requested.filter((s) => SAFE_WHEN_HALTED.includes(s)) : requested;
  if (halted) log.warn(`緊急停止中（${halted.at} ${halted.reason}）のため、企画・制作・入稿・投稿はしません。解除: node src/cli.ts resume`);
  const record: CycleRecord = { id: ctx.cycleId, startedAt: new Date().toISOString(), dryRun: ctx.dryRun, steps: [], llmCostUsd: 0 };
  const usageBefore = ctx.llm.usage.length;
  let decisions: Decision[] = [];
  let planned: PlanResult = { created: [], rejected: [] };
  let published: PublishSummary = { published: [], skipped: [], failed: [] };
  let produced = { produced: 0, waiting: 0, failed: 0 };
  let analyzed = false;

  const step = async (name: StepName, fn: () => Promise<string>) => {
    if (!steps.includes(name)) return;
    const t = Date.now();
    try {
      const note = await fn();
      record.steps.push({ name, ok: true, note, ms: Date.now() - t });
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`${name} 失敗: ${msg}`);
      record.steps.push({ name, ok: false, note: msg.slice(0, 500), ms: Date.now() - t });
    }
    store.save();
  };

  log.info(`サイクル開始 ${ctx.cycleId}（${ctx.dryRun ? 'DRY RUN' : '本番'} / 画像: ${ctx.images.name} / Meta: ${ctx.meta ? 'ON' : 'OFF'} / Google: ${ctx.google ? 'ON' : 'OFF'}）`);

  await step('collect', async () => {
    const ads = await collectMetrics(ctx);
    const organic = await collectOrganic(ctx).catch((e) => `オーガニック取得失敗: ${(e as Error).message}`);
    const outcomes = await importOutcomes(ctx).catch((e) => `選考結果の取り込み失敗: ${(e as Error).message}`);
    return `${ads} / ${organic} / ${outcomes}`;
  });
  await step('optimize', async () => {
    decisions = await optimize(ctx);
    return `${decisions.length} 件`;
  });
  await step('analyze', async () => {
    const prev = store.state.insights.at(-1);
    const intervalDays = Number(process.env.ADOPS_ANALYZE_EVERY_DAYS ?? 1);
    if (prev && daysBetween(prev.date, ctx.today) < intervalDays) return '前回分析から日が浅いためスキップ';
    const hasData = store.creatives().some((c) => totals(lastNDays(c.metrics, ctx.today, 7)).impressions > 0);
    if (!hasData) return '直近7日の配信データなし';
    const insight = await analyze(ctx.llm, store.creatives(), store.state.briefs, ctx.catalog, ctx.today, prev);
    store.state.insights.push(insight);
    analyzed = true;
    return insight.summary.slice(0, 200);
  });
  // 毎週月曜は人向けの戦略メモも書いて、日次とは別のメッセージで送る
  if (steps.includes('analyze') && shouldWriteMemo(store.state, ctx.today) && store.creatives().some((c) => c.metrics.length)) {
    await step('analyze', async () => {
      const memo = await writeMemo(ctx.llm, store.state, ctx.catalog, ctx.today);
      (store.state.memos ??= []).push(memo);
      await notifySlack(ctx.settings.slack.webhookUrl, { text: memoToSlack(memo), blocks: sections(memoToSlack(memo)) });
      return `週次戦略メモ: ${memo.headline}`;
    });
  }
  await step('plan', async () => {
    planned = await plan(ctx);
    return `採用 ${planned.created.length} / 却下 ${planned.rejected.length}`;
  });
  await step('produce', async () => {
    produced = await produce(ctx);
    return `完成 ${produced.produced} / 待ち ${produced.waiting} / 失敗 ${produced.failed}`;
  });
  await step('publish', async () => {
    published = await publish(ctx);
    // draft モードでは、入稿した広告ごとに Slack へ承認ボタンつきのメッセージを送る（設定時のみ）
    if (ctx.catalog.policy.autonomy === 'draft' && process.env.ADOPS_SLACK_APPROVALS === 'true' && ctx.settings.slack.webhookUrl) {
      for (const c of published.published) {
        const brief = store.state.briefs[c.briefId];
        const job = ctx.catalog.jobs.find((j) => j.id === c.jobId);
        if (brief && job) await notifySlack(ctx.settings.slack.webhookUrl, { text: `承認待ち: ${brief.overlay.main}`, blocks: approvalBlocks(c, brief, job) });
      }
    }
    return `入稿 ${published.published.length} / 保留 ${published.skipped.length} / 失敗 ${published.failed.length}`;
  });

  let searchNote = '';
  await step('search', async () => {
    searchNote = await rotateSearchAds(ctx);
    return searchNote;
  });

  let organicNote = '';
  await step('organic', async () => {
    organicNote = await postOrganic(ctx);
    return organicNote;
  });

  const pruned = store.pruneAssets(ctx.settings.image.inboxDir);
  if (pruned) log.info(`入稿済み等の素材 ${pruned} ファイルを掃除（サムネイルは保持）`);

  record.llmCostUsd = Math.round(ctx.llm.usage.slice(usageBefore).reduce((a, u) => a + u.costUsd, 0) * 100) / 100;
  store.state.llmUsage.push(...ctx.llm.usage.slice(usageBefore));
  record.finishedAt = new Date().toISOString();
  store.state.cycles.push(record);
  store.compact();
  store.save();

  await step('report', async () => {
    const path = writeReport(store.state, ctx.catalog, store.dir, ctx.today);
    await notifySlack(ctx.settings.slack.webhookUrl, summaryMessage(ctx, record, { decisions, planned, produced, published, analyzed, organicNote, searchNote }));
    return path;
  });
  // report の結果も記録に残す
  store.state.cycles[store.state.cycles.length - 1] = record;
  store.save();
  log.info(`サイクル終了 ${ctx.cycleId}: ${record.steps.map((s) => `${s.name}=${s.ok ? 'ok' : 'NG'}`).join(' ')} / AI費用 $${record.llmCostUsd}`);
  return record;
}

function summaryMessage(
  ctx: Ctx,
  record: CycleRecord,
  r: { decisions: Decision[]; planned: PlanResult; produced: { produced: number; waiting: number; failed: number }; published: PublishSummary; analyzed: boolean; organicNote: string; searchNote: string },
) {
  const { store, today } = ctx;
  const t7 = totals(store.creatives().flatMap((c) => lastNDays(c.metrics, today, 7)));
  const lines: string[] = [];
  lines.push(`*広告自動運用 ${today}*${ctx.dryRun ? '（DRY RUN）' : ''}`);
  if (store.state.halted) lines.push(`:octagonal_sign: 緊急停止中（${store.state.halted.reason}）。企画・入稿は止めています。解除は \`resume\``);
  lines.push(`直近7日: 表示 ${t7.impressions.toLocaleString()} / CTR ${t7.ctr.toFixed(2)}% / 費用 ${Math.round(t7.spend).toLocaleString()}円 / 応募 ${t7.conversions}${t7.cpa ? ` / 単価 ${Math.round(t7.cpa).toLocaleString()}円` : ''}`);
  const failedSteps = record.steps.filter((s) => !s.ok);
  if (failedSteps.length) lines.push(`:warning: 失敗した段階: ${failedSteps.map((s) => `${s.name}（${s.note.slice(0, 120)}）`).join(' / ')}`);

  if (r.analyzed) {
    const ins = store.state.insights.at(-1)!;
    lines.push('', '*AI分析*', ins.summary, ...ins.nextActions.slice(0, 3).map((a) => `• ${a}`));
  }
  if (r.decisions.length) {
    lines.push('', '*運用判断*');
    for (const d of r.decisions.slice(0, 10)) {
      const label = { pause: '停止', retire: '入替', scale_budget: '予算増', activate: '再開', keep: '継続' }[d.action];
      lines.push(`• ${label} ${d.creativeId ?? d.adsetId}: ${d.reason}${d.applied ? '' : d.action === 'scale_budget' ? '（提案のみ。auto モードで自動反映）' : ctx.dryRun ? '（DRY RUN）' : ''}`);
    }
  }
  lines.push('', `*企画* 採用 ${r.planned.created.length} / 却下 ${r.planned.rejected.length}`);
  for (const c of r.planned.created.slice(0, 8)) {
    const b = store.state.briefs[c.briefId];
    lines.push(`• [${ANGLE_LABELS[c.angle]}${c.format === 'video' ? '・動画' : ''}${c.explore ? '・探索' : ''}] ${b.overlay.main}`);
  }
  lines.push(`*制作* 完成 ${r.produced.produced} / 画像待ち ${r.produced.waiting} / 失敗 ${r.produced.failed}`);
  const waiting = store.creatives({ status: 'awaiting_images' });
  if (waiting.length && ctx.images.name === 'handoff') {
    lines.push('', `*:art: Midjourney で生成してください（${waiting.length} 本）*`, '各プロンプトを midjourney.com で生成し、良い画像を1〜4枚、示したフォルダに保存すると次回の実行で取り込みます。');
    for (const c of waiting.slice(0, 10)) {
      for (const j of c.imageJobs.filter((j) => !j.paths?.length)) {
        const id = `${c.id}_${j.ratio.replace(':', 'x').replace('.', '')}`;
        const where = j.note?.replace(/^置き場所: /, '') ?? `inbox/${id}/`;
        lines.push(`• \`${id}\` → ${where.startsWith('http') ? `<${where}|フォルダを開く>` : `\`${where}\``}\n\`\`\`${j.prompt} --ar ${j.ratio === '1.91:1' ? '191:100' : j.ratio}\`\`\``);
      }
    }
  }
  lines.push(`*入稿* ${r.published.published.length} 本${ctx.catalog.policy.autonomy === 'draft' && r.published.published.length ? '（停止状態。管理画面で確認して ON にしてください）' : ''}`);
  for (const f of r.published.failed.slice(0, 5)) lines.push(`• :x: ${f.creative.id}: ${f.error.slice(0, 200)}`);
  const skippedReasons = [...new Set(r.published.skipped.map((s) => s.reason))];
  if (skippedReasons.length) lines.push(`• 保留 ${r.published.skipped.length} 本: ${skippedReasons.join(' / ')}`);
  if (r.searchNote) lines.push(`*Google 検索広告* ${r.searchNote}`);
  if (r.organicNote) lines.push(`*Instagram 投稿* ${r.organicNote}`);
  lines.push('', `AI費用 $${record.llmCostUsd}`);
  const text = lines.join('\n');
  return { text, blocks: sections(text) };
}
