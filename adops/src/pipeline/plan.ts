/** 段階4: 配分 → 企画 → レビュー → 差し戻し修正 のループで、入稿候補のクリエイティブを作る。 */
import type { Ctx } from './context.ts';
import type { Creative, CreativeBrief, Review } from '../types.ts';
import { allocateSlots } from '../optimize/allocate.ts';
import { planBriefs, reviseBrief, seasonalContext, type PlanningContext } from '../agents/strategist.ts';
import { reviewBrief } from '../agents/reviewer.ts';
import { lastNDays, totals } from '../optimize/stats.ts';
import { newId } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('plan');

export function planningContext(ctx: Ctx): PlanningContext {
  const { store, today } = ctx;
  const latest = store.state.insights.at(-1);
  const rows = store
    .creatives()
    .map((c) => ({ c, b: store.state.briefs[c.briefId], t: totals(lastNDays(c.metrics, today, 28)) }))
    .filter((x) => x.b && x.t.impressions >= 1000);
  const byCpa = [...rows].sort((a, b) => (a.t.cpa ?? Infinity) - (b.t.cpa ?? Infinity) || b.t.ctr - a.t.ctr);
  return {
    learnings: latest?.learnings ?? [],
    winners: byCpa.slice(0, 5).map((x) => ({ angle: x.c.angle, headline: x.b.headline, overlayMain: x.b.overlay.main, ctr: x.t.ctr, cpa: x.t.cpa })),
    losers: byCpa
      .slice(-5)
      .filter((x) => !byCpa.slice(0, 5).includes(x))
      .map((x) => ({ angle: x.c.angle, headline: x.b.headline, overlayMain: x.b.overlay.main, ctr: x.t.ctr })),
    activeHooks: store
      .creatives({ status: ['published', 'produced', 'planned', 'awaiting_images'] })
      .map((c) => store.state.briefs[c.briefId]?.overlay.main)
      .filter(Boolean),
    platformRejections: store
      .creatives({ status: 'failed' })
      .filter((c) => c.statusReason?.startsWith('媒体審査で不承認'))
      .slice(-8)
      .map((c) => ({ overlayMain: store.state.briefs[c.briefId]?.overlay.main ?? '', reason: c.statusReason!.replace('媒体審査で不承認: ', '') })),
    frequentIssues: frequentIssues(store.state.reviews.slice(-60)),
    season: seasonalContext(today),
  };
}

/** 直近のレビューで重大な指摘（blocker / major）として繰り返し出た問題の上位。 */
export function frequentIssues(reviews: Review[], top = 5): string[] {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    for (const i of r.issues) {
      if (i.severity === 'minor') continue;
      // 「（「…」）」の引用部分は事例ごとに違うので落として集計する
      const key = i.problem.replace(/（「.*?」）/g, '').replace(/「.*?」/g, '「…」').trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, n]) => `${k}（${n}回）`);
}

export interface PlanResult {
  created: Creative[];
  rejected: { brief: CreativeBrief; review: Review }[];
}

export async function plan(ctx: Ctx): Promise<PlanResult> {
  const { store, catalog, today, llm } = ctx;
  // 制作待ちが溜まっている（手渡しモードで人の作業が追いついていない等）ときは新規企画を控える
  const backlog = store.creatives({ status: ['planned', 'awaiting_images'] }).length;
  const room = Math.max(0, catalog.policy.briefsPerCycle * 2 - backlog);
  const slots = allocateSlots({ catalog, creatives: store.creatives(), today }).slice(0, room);
  if (slots.length === 0) {
    log.info(`制作待ちが ${backlog} 本あるため新規企画はスキップ`);
    return { created: [], rejected: [] };
  }
  log.info(`企画 ${slots.length} 枠: ${slots.map((s) => `${s.jobId}/${s.angle}/${s.format}${s.explore ? '*' : ''}`).join(', ')}`);
  const drafts = await planBriefs(llm, slots, catalog, planningContext(ctx));

  const result: PlanResult = { created: [], rejected: [] };
  // ブリーフごとのレビュー→修正は互いに独立なので並列に回す
  await Promise.all(
    drafts.map(async (draft) => {
      const slot = slots.find((s) => s.slot === draft.slot)!;
      const { slot: _slot, ...rest } = draft;
      let brief: CreativeBrief = {
        ...rest,
        id: newId('br'),
        cycleId: ctx.cycleId,
        jobId: slot.jobId,
        personaId: slot.personaId,
        angle: slot.angle,
        format: slot.format,
        explore: slot.explore,
        revision: 0,
        createdAt: new Date().toISOString(),
        storyboard: slot.format === 'video' ? rest.storyboard : [],
      };
      for (;;) {
        const { review } = await reviewBrief(llm, brief, catalog);
        store.state.reviews.push(review);
        store.state.briefs[brief.id] = brief;
        log.info(`レビュー ${brief.id} rev${brief.revision}: ${review.score}点 → ${review.verdict}（指摘 ${review.issues.length}）`);
        if (review.verdict === 'pass') break;
        if (review.verdict === 'reject') {
          result.rejected.push({ brief, review });
          return;
        }
        const revised = await reviseBrief(llm, brief, review.issues, review.summary, catalog);
        brief = { ...brief, ...revised, storyboard: brief.format === 'video' ? revised.storyboard : [], revision: brief.revision + 1 };
      }
      const now = new Date().toISOString();
      const creative: Creative = {
        id: newId('cr'),
        briefId: brief.id,
        jobId: brief.jobId,
        personaId: brief.personaId,
        angle: brief.angle,
        format: brief.format,
        explore: brief.explore,
        status: 'planned',
        imageJobs: [],
        assets: [],
        platformRefs: {},
        metrics: [],
        createdAt: now,
        updatedAt: now,
      };
      store.state.creatives[creative.id] = creative;
      result.created.push(creative);
    }),
  );
  return result;
}
