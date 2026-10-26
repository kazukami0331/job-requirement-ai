import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ScriptedLlm, toStrictJsonSchema } from '../src/llm/llm.ts';
import { offlineLlm } from '../src/llm/offline.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { makeCtx, type Ctx } from '../src/pipeline/context.ts';
import { plan } from '../src/pipeline/plan.ts';
import { runCycle } from '../src/pipeline/cycle.ts';
import { loadSettings } from '../src/config.ts';
import { catalog, job, policy } from './fixtures.ts';
import type { Llm } from '../src/llm/llm.ts';

function ctxWith(llm: Llm, over: Partial<Ctx> = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'adops-state-'));
  return makeCtx({
    settings: { ...loadSettings(), dataDir: dir, slack: { webhookUrl: '' } },
    catalog: catalog({ jobs: [job({ dailyCreativeQuota: 2 })], policy: policy({ briefsPerCycle: 2, videoShare: 0, exploreShare: 0.5 }) }),
    store: new StateStore(dir),
    llm,
    images: new MockProvider(),
    meta: null,
    google: null,
    dryRun: true,
    cycleId: 'cy_test',
    today: '2026-10-10',
    ...over,
  });
}

test('toStrictJsonSchema: 全オブジェクトに additionalProperties:false と required', () => {
  const s = toStrictJsonSchema(z.object({ a: z.string().min(1), b: z.object({ c: z.array(z.number().max(3)) }) })) as any;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['a', 'b']);
  assert.equal(s.properties.b.additionalProperties, false);
  assert.equal(s.properties.a.minLength, undefined);
  assert.equal(s.properties.b.properties.c.items.maximum, undefined);
});

test('plan: レビューで blocker が出たら修正版を作り直し、通れば制作キューに入る', async () => {
  const base = offlineLlm(catalog());
  const llm = new ScriptedLlm();
  let revised = 0;
  // 初稿は年齢制限を含む → 機械チェックで blocker → 修正で取り除く
  llm.on('strategist.plan', async (req) => {
    const out: any = await base.structured({ ...req, agent: 'strategist.plan' } as any);
    for (const b of out.briefs) b.headline = '35歳までの方歓迎';
    return out;
  });
  llm.on('strategist.revise', async (req) => {
    revised++;
    const m = req.prompt.match(/# 現在の企画（JSON）\n([\s\S]+?)\n\n# レビュー総評/)!;
    return { ...JSON.parse(m[1]), headline: '未経験から製造スタッフへ' };
  });
  llm.on('reviewer', () => ({ scores: { hook: 17, clarity: 17, personaFit: 17, credibility: 17, visualFit: 17 }, issues: [], summary: 'ok' }));

  const ctx = ctxWith(llm);
  const r = await plan(ctx);
  assert.equal(r.created.length, 2);
  assert.equal(revised, 2);
  for (const c of r.created) {
    const b = ctx.store.state.briefs[c.briefId];
    assert.equal(b.revision, 1);
    assert.equal(b.headline, '未経験から製造スタッフへ');
  }
  // 初稿の差し戻しと修正版の合格の両方がレビュー履歴に残る
  assert.equal(ctx.store.state.reviews.length, 4);
});

test('plan: 改訂上限まで直らなければ却下して制作しない', async () => {
  const base = offlineLlm(catalog());
  const llm = new ScriptedLlm();
  llm.on('strategist.plan', async (req) => {
    const out: any = await base.structured({ ...req, agent: 'strategist.plan' } as any);
    for (const b of out.briefs) b.primaryText = '必ず稼げる！';
    return out;
  });
  llm.on('strategist.revise', (req) => JSON.parse(req.prompt.match(/# 現在の企画（JSON）\n([\s\S]+?)\n\n# レビュー総評/)![1]));
  llm.on('reviewer', () => ({ scores: { hook: 20, clarity: 20, personaFit: 20, credibility: 20, visualFit: 20 }, issues: [], summary: 'ok' }));
  const ctx = ctxWith(llm);
  const r = await plan(ctx);
  assert.equal(r.created.length, 0);
  assert.equal(r.rejected.length, 2);
});

test('runCycle: オフラインで企画→制作まで通り、レポートを書き出す', async () => {
  const ctx = ctxWith(offlineLlm(catalog()));
  const rec = await runCycle(ctx);
  assert.ok(rec.steps.every((s) => s.ok), JSON.stringify(rec.steps));
  const cs = ctx.store.creatives();
  assert.equal(cs.length, 2);
  assert.ok(cs.every((c) => c.status === 'produced'), JSON.stringify(cs.map((c) => [c.status, c.statusReason])));
  assert.ok(cs.every((c) => c.assets.length === 4));
  // 媒体が未設定なので入稿は保留
  const publishStep = rec.steps.find((s) => s.name === 'publish')!;
  assert.match(publishStep.note, /保留 2/);
  // 状態ファイルを読み直しても同じ内容
  const reloaded = new StateStore(ctx.store.dir);
  assert.equal(Object.keys(reloaded.state.creatives).length, 2);
});

test('syncStatuses: 人が ON にしたら live、全媒体で不承認なら failed、止めた広告の再開は published に戻す', async () => {
  const { syncStatuses } = await import('../src/pipeline/collect.ts');
  const { creative } = await import('./fixtures.ts');
  const statuses = new Map([
    ['ad_on', { status: 'ACTIVE' }],
    ['ad_off', { status: 'PAUSED' }],
    ['ad_ng', { status: 'DISAPPROVED', review: 'EMPLOYMENT: 差別的表現' }],
    ['ad_resumed', { status: 'ACTIVE' }],
  ]);
  const fakeMeta = { adStatuses: async () => statuses } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta });
  const mk = (id: string, adId: string, status: 'published' | 'paused' = 'published') =>
    (ctx.store.state.creatives[id] = creative({ id, status, platformRefs: { meta: { adIds: [adId], creativeIds: [] } } }));
  mk('on', 'ad_on');
  mk('off', 'ad_off');
  mk('ng', 'ad_ng');
  mk('resumed', 'ad_resumed', 'paused');
  await syncStatuses(ctx);
  const cs = ctx.store.state.creatives;
  assert.equal(cs.on.live, true);
  assert.equal(cs.off.live, false);
  assert.equal(cs.off.status, 'published');
  assert.equal(cs.ng.status, 'failed');
  assert.match(cs.ng.statusReason!, /差別的表現/);
  assert.equal(cs.resumed.status, 'published');
});

test('organic: 広告で反応の良い素材を優先し、DRY RUN では投稿予定だけ出す', async () => {
  const { organicCandidates, postOrganic } = await import('../src/pipeline/organic.ts');
  const { creative, daily, brief } = await import('./fixtures.ts');
  const { writeFileSync } = await import('node:fs');
  const ctx = ctxWith(offlineLlm(catalog()));
  ctx.catalog.policy.organic = { enabled: true, postsPerDay: 1, baseHashtags: ['#求人'], minAdCtrForRepost: 1 };
  ctx.catalog.policy.autonomy = 'auto';
  const img = join(ctx.store.dir, 'x_4x5.jpg');
  writeFileSync(img, 'x');
  const asset = { ratio: '4:5' as const, kind: 'image' as const, path: img, width: 1080, height: 1350 };
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.fresh = creative({ id: 'fresh', status: 'produced', assets: [asset] });
  ctx.store.state.creatives.proven = creative({ id: 'proven', assets: [asset], metrics: daily('2026-10-05', 5, { impressions: 1000, clicks: 20, spend: 500, conversions: 1 }) });
  ctx.store.state.creatives.weak = creative({ id: 'weak', assets: [asset], metrics: daily('2026-10-05', 5, { impressions: 1000, clicks: 2, spend: 500, conversions: 0 }) });
  const order = organicCandidates(ctx).map((x) => x.c.id);
  assert.equal(order[0], 'proven');
  const note = await postOrganic(ctx);
  assert.match(note, /proven\(feed, 未投稿: DRY RUN\)/);
  assert.equal(ctx.store.state.creatives.proven.organic, undefined);
  // draft モードでは、人が ON にした（live）広告の素材だけを使う
  ctx.catalog.policy.autonomy = 'draft';
  assert.deepEqual(organicCandidates(ctx).map((x) => x.c.id), []);
  ctx.store.state.creatives.weak.live = true;
  assert.deepEqual(organicCandidates(ctx).map((x) => x.c.id), ['weak']);
  // 2回失敗した素材は候補から外す
  ctx.store.state.creatives.weak.organicFailures = 2;
  assert.deepEqual(organicCandidates(ctx).map((x) => x.c.id), []);
});

test('frequentIssues: 繰り返し出る重大な指摘だけを回数順に返す', async () => {
  const { frequentIssues } = await import('../src/pipeline/plan.ts');
  const mk = (problem: string, severity: 'blocker' | 'major' | 'minor' = 'major') => ({
    briefId: 'b', revision: 0, reviewer: 'ai' as const, score: 50, scores: {}, verdict: 'revise' as const, summary: '', createdAt: '',
    issues: [{ severity, field: 'x', problem, suggestion: '' }],
  });
  const out = frequentIssues([
    mk('年齢の上限を示しています（「35歳まで」）', 'blocker'),
    mk('年齢の上限を示しています（「40歳以下」）', 'blocker'),
    mk('フックが弱い'),
    mk('細かい点', 'minor'),
    mk('細かい点', 'minor'),
  ]);
  assert.deepEqual(out, ['年齢の上限を示しています（2回）']);
});

test('seasonalContext: 月ごとの文脈を返す', async () => {
  const { seasonalContext } = await import('../src/agents/strategist.ts');
  assert.match(seasonalContext('2026-03-10'), /^2026-03: .*4月入社/);
});

test('optimize: DRY RUN では媒体に出ている広告の状態を変えない／本番では止めてから状態を変える', async () => {
  const { optimize } = await import('../src/pipeline/optimize.ts');
  const { creative, daily } = await import('./fixtures.ts');
  const bad = () => creative({ id: 'bad', metrics: daily('2026-10-04', 7, { impressions: 4000, clicks: 40, spend: 3000, conversions: 0 }) });
  const paused: string[] = [];
  const fakeMeta = { setAdStatus: async (id: string) => void paused.push(id), getAdset: async () => ({ id: '111', dailyBudget: null, status: 'ACTIVE' }) } as any;

  const dry = ctxWith(offlineLlm(catalog()), { meta: fakeMeta, dryRun: true });
  dry.store.state.creatives.bad = bad();
  await optimize(dry);
  assert.equal(dry.store.state.creatives.bad.status, 'published');
  assert.equal(paused.length, 0);

  const live = ctxWith(offlineLlm(catalog()), { meta: fakeMeta, dryRun: false });
  live.store.state.creatives.bad = bad();
  const d = await optimize(live);
  assert.equal(live.store.state.creatives.bad.status, 'paused');
  assert.deepEqual(paused, ['ad1']);
  assert.equal(d[0].applied, true);

  // API 未設定なら「止めたこと」にしない
  const noApi = ctxWith(offlineLlm(catalog()), { meta: null, dryRun: false });
  noApi.store.state.creatives.bad = bad();
  await optimize(noApi);
  assert.equal(noApi.store.state.creatives.bad.status, 'published');
});

test('optimize: 予算増は数日に1回だけ', async () => {
  const { optimize } = await import('../src/pipeline/optimize.ts');
  const { creative, daily, policy } = await import('./fixtures.ts');
  const budgets: number[] = [];
  const fakeMeta = { getAdset: async () => ({ id: '111', dailyBudget: 10000, status: 'ACTIVE' }), setAdsetDailyBudget: async (_: string, y: number) => void budgets.push(y) } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta, dryRun: false });
  ctx.catalog.policy = policy({ autonomy: 'auto' });
  ctx.store.state.creatives.win = creative({ id: 'win', metrics: daily('2026-10-04', 7, { impressions: 3000, clicks: 60, spend: 3000, conversions: 1 }) });
  await optimize(ctx);
  await optimize(ctx);
  assert.deepEqual(budgets, [12000]);
});

test('publish: 一部の広告セットで失敗しても作成済みの広告は記録し、Google の失敗は次回再試行する', async () => {
  const { publish } = await import('../src/pipeline/publish.ts');
  const { creative, brief, job } = await import('./fixtures.ts');
  const { writeFileSync } = await import('node:fs');
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false });
  ctx.catalog.jobs = [job({ placements: { meta: { adsetIds: ['a1', 'a2'] }, google: { adGroupIds: ['g1'] } } })];
  const img = join(ctx.store.dir, 'x.jpg');
  writeFileSync(img, 'x');
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.c = creative({ id: 'c', status: 'produced', platformRefs: {}, assets: [{ ratio: '4:5', kind: 'image', path: img, width: 1, height: 1 }] });
  let googleCalls = 0;
  ctx.meta = {
    createCreative: async () => 'cre1',
    createAd: async (adset: string) => {
      if (adset === 'a2') throw new Error('adset a2 is archived');
      return 'ad_a1';
    },
  } as any;
  ctx.google = {
    createImageAsset: async () => {
      googleCalls++;
      throw new Error('quota');
    },
  } as any;
  const r1 = await publish(ctx);
  const c = ctx.store.state.creatives.c;
  assert.equal(c.status, 'published');
  assert.deepEqual(c.platformRefs.meta?.adIds, ['ad_a1']);
  assert.deepEqual(c.pendingPlatforms, ['google']);
  assert.equal(r1.failed.length, 1);
  await publish(ctx);
  assert.equal(googleCalls, 2);
  assert.equal(c.publishRetries, 1);
  // Meta は二重に入稿しない
  assert.deepEqual(c.platformRefs.meta?.adIds, ['ad_a1']);
});

test('shouldWriteMemo: 月曜（日本時間の日付）に週1回だけ', async () => {
  const { shouldWriteMemo } = await import('../src/agents/strategyMemo.ts');
  const { emptyState } = await import('../src/store/stateStore.ts');
  const s = emptyState();
  assert.equal(shouldWriteMemo(s, '2026-10-26'), true); // 月曜
  assert.equal(shouldWriteMemo(s, '2026-10-27'), false);
  s.memos = [{ date: '2026-10-26', headline: '', findings: [], decisions: [], experiments: [] }];
  assert.equal(shouldWriteMemo(s, '2026-10-26'), false);
  assert.equal(shouldWriteMemo(s, '2026-11-02'), true);
});

test('emergencyStop: 入稿済みの広告をすべて止め、解除まで企画・入稿しない', async () => {
  const { emergencyStop } = await import('../src/pipeline/emergency.ts');
  const { creative } = await import('./fixtures.ts');
  const paused: string[] = [];
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: { setAdStatus: async (id: string) => void paused.push(id) } as any });
  ctx.store.state.creatives.a = creative({ id: 'a' });
  ctx.store.state.creatives.b = creative({ id: 'b', status: 'produced', platformRefs: {} });
  const r = await emergencyStop(ctx);
  assert.equal(r.paused, 1);
  assert.deepEqual(paused, ['ad1']);
  assert.equal(ctx.store.state.creatives.a.status, 'paused');
  assert.ok(ctx.store.state.halted);
  const rec = await runCycle(ctx);
  assert.ok(!rec.steps.some((s) => ['plan', 'produce', 'publish', 'search', 'organic'].includes(s.name)));
  assert.equal(ctx.store.state.creatives.b.status, 'produced');
});
