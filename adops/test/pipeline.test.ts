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
