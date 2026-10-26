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
  const fakeMeta = { stopAd: async (id: string) => void paused.push(id), getAdset: async () => ({ id: '111', dailyBudget: null, status: 'ACTIVE' }) } as any;

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
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: { stopAd: async (id: string) => void paused.push(id) } as any });
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

test('emergencyStop: 記録に残っていない adops の配信中広告も広告セットから見つけて止める', async () => {
  const { emergencyStop } = await import('../src/pipeline/emergency.ts');
  const { creative } = await import('./fixtures.ts');
  const paused: string[] = [];
  const meta = {
    stopAd: async (id: string) => void paused.push(id),
    liveAdopsAds: async () => [{ id: 'ad1', name: 'adops_cr_1_housing_image' }, { id: 'orphan', name: 'adops_cr_9_pay_image' }],
  };
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: meta as any });
  ctx.store.state.creatives.a = creative({ id: 'a' });
  const r = await emergencyStop(ctx);
  assert.deepEqual(paused, ['ad1', 'orphan']);
  assert.equal(r.paused, 2);
});

test('notifyLeads: 直前1時間（朝は夜間分）の応募だけを、氏名はイニシャルにして通知し、状態に個人情報を残さない', async () => {
  const { notifyLeads, maskName, leadWindow } = await import('../src/pipeline/leads.ts');
  const { creative, job } = await import('./fixtures.ts');
  assert.equal(maskName({ full_name: '山田 太郎' }), '山…様');
  assert.equal(maskName({}), '（氏名なし）');
  // 10:35 JST の実行 → 9:30〜10:30 JST
  const at1035 = new Date('2026-10-26T01:35:00Z');
  const w = leadWindow(at1035);
  assert.equal(new Date(w.since * 1000).toISOString(), '2026-10-26T00:30:00.000Z');
  assert.equal(new Date(w.until * 1000).toISOString(), '2026-10-26T01:30:00.000Z');
  // 9:40 JST の実行 → 前日 21:30 から
  const w9 = leadWindow(new Date('2026-10-26T00:40:00Z'));
  assert.equal(new Date(w9.since * 1000).toISOString(), '2026-10-25T12:30:00.000Z');

  const inWindow = Math.floor(Date.parse('2026-10-26T01:00:00Z') / 1000);
  const fakeMeta = {
    leads: async () => [
      { id: 'l1', createdTime: inWindow, adId: 'ad1', fields: { full_name: '山田 太郎', phone_number: '090-0000-0000' } },
      { id: 'l0', createdTime: w.since - 10, fields: { full_name: '前の時間' } },
    ],
  } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta });
  ctx.catalog.jobs = [job({ placements: { meta: { adsetIds: ['1'], leadFormId: 'form1' } } })];
  ctx.store.state.creatives.c = creative({ id: 'c' });
  assert.match(await notifyLeads(ctx, at1035), /1 件/);
  assert.ok(!JSON.stringify(ctx.store.state).includes('090-0000-0000'));
});

test('カルーセル: 企画→制作でカード画像（＋条件まとめの最終カード）ができ、Meta には child_attachments で入稿する', async () => {
  const { MetaClient } = await import('../src/platforms/meta.ts');
  const ctx = ctxWith(offlineLlm(catalog()));
  ctx.catalog.policy = policy({ briefsPerCycle: 1, videoShare: 0, exploreShare: 0, carouselShare: 1 });
  ctx.catalog.jobs = [job({ dailyCreativeQuota: 1 })];
  const rec = await runCycle(ctx, ['plan', 'produce']);
  assert.ok(rec.steps.every((s) => s.ok), JSON.stringify(rec.steps));
  const [c] = ctx.store.creatives();
  assert.equal(c.format, 'carousel');
  assert.equal(c.status, 'produced', c.statusReason);
  const cards = c.assets.filter((a) => a.card !== undefined);
  assert.equal(cards.length, 4); // 3枚 + 条件まとめ
  assert.ok(cards.every((a) => a.ratio === '1:1'));

  // Meta への入稿内容（HTTP は呼ばずに、送るパラメータだけ確かめる）
  const client = new MetaClient({ accessToken: 't', adAccountId: '1', pageId: 'p', instagramUserId: '', apiVersion: 'v25.0' }) as any;
  const sent: any[] = [];
  client.call = async (_m: string, path: string, params: any) => {
    sent.push({ path, params });
    return path.endsWith('adimages') ? { images: { x: { hash: `h${sent.length}` } } } : { id: 'cre1' };
  };
  const brief = ctx.store.state.briefs[c.briefId];
  await client.createCreative(brief, ctx.catalog.jobs[0], c.assets, 'n');
  const creative = sent.find((x) => x.path.endsWith('adcreatives')).params;
  const children = creative.object_story_spec.link_data.child_attachments;
  assert.equal(children.length, 4);
  assert.equal(creative.object_story_spec.link_data.multi_share_optimized, false);
});

test('watchComments: 質問とネガティブを通知、スパムは非表示にし、本文は状態に残さない', async () => {
  const { watchComments } = await import('../src/pipeline/comments.ts');
  const { creative } = await import('./fixtures.ts');
  const hidden: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const fakeMeta = {
    storyIdOf: async () => 'page_post',
    comments: async (_p: string, since: number) =>
      [
        { id: 'c1', message: '寮は個室ですか？', createdTime: now - 30 },
        { id: 'c2', message: '稼げる副業はこちら http://spam.example', createdTime: now - 20 },
        { id: 'c3', message: 'ここブラックって聞いた', createdTime: now - 10 },
      ].filter((c) => c.createdTime > since),
    hideComment: async (id: string) => void hidden.push(id),
  } as any;
  process.env.ADOPS_WATCH_COMMENTS = 'true';
  try {
    const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta, dryRun: false });
    ctx.store.state.creatives.a = creative({ id: 'a' });
    ctx.store.state.creatives.a.platformRefs.meta!.creativeIds = ['cre1'];
    assert.match(await watchComments(ctx), /要対応 2 件 \/ スパム非表示 1 件/);
    assert.deepEqual(hidden, ['c2']);
    assert.equal(ctx.store.state.commentCursor!.page_post, now - 10);
    assert.ok(!JSON.stringify(ctx.store.state).includes('個室'));
    // 2回目は新しいコメントが無い
    assert.match(await watchComments(ctx), /要対応 0 件/);
  } finally {
    delete process.env.ADOPS_WATCH_COMMENTS;
  }
});

test('watchComments: Instagram 側のコメントも仕分ける', async () => {
  const { watchComments } = await import('../src/pipeline/comments.ts');
  const { creative } = await import('./fixtures.ts');
  const now = Math.floor(Date.now() / 1000);
  const hiddenIg: string[] = [];
  const fakeMeta = {
    storyIdOf: async () => null,
    instagramMediaIdOf: async () => 'igm1',
    instagramComments: async () => [
      { id: 'i1', message: '週払いできますか？', createdTime: now - 5 },
      { id: 'i2', message: 'LINE追加で稼げる', createdTime: now - 4 },
    ],
    hideInstagramComment: async (id: string) => void hiddenIg.push(id),
  } as any;
  process.env.ADOPS_WATCH_COMMENTS = 'true';
  try {
    const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta, dryRun: false });
    ctx.settings = { ...ctx.settings, meta: { ...ctx.settings.meta, instagramUserId: 'ig_user' } };
    ctx.store.state.creatives.a = creative({ id: 'a' });
    ctx.store.state.creatives.a.platformRefs.meta!.creativeIds = ['cre1'];
    assert.match(await watchComments(ctx), /要対応 1 件 \/ スパム非表示 1 件/);
    assert.deepEqual(hiddenIg, ['i2']);
    assert.equal(ctx.store.state.commentCursor!['ig:igm1'], now - 4);
  } finally {
    delete process.env.ADOPS_WATCH_COMMENTS;
  }
});

test('publish: サンプル設定（example.com・社名未記入）のままでは入稿しない', async () => {
  const { publish } = await import('../src/pipeline/publish.ts');
  const { creative, brief, job, brand } = await import('./fixtures.ts');
  const { writeFileSync } = await import('node:fs');
  let created = 0;
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: { createCreative: async () => (created++, 'c'), createAd: async () => 'a' } as any });
  ctx.catalog.jobs = [job({ landingUrl: 'https://example.com/jobs/x' })];
  ctx.catalog.brand = brand({ name: '（社名をここに）' });
  const img = join(ctx.store.dir, 'x.jpg');
  writeFileSync(img, 'x');
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.c = creative({ id: 'c', status: 'produced', platformRefs: {}, assets: [{ ratio: '4:5', kind: 'image', path: img, width: 1, height: 1 }] });
  const r = await publish(ctx);
  assert.equal(created, 0);
  assert.match(r.skipped[0].reason, /サンプル設定/);
  assert.equal(ctx.store.state.creatives.c.status, 'produced');
});

test('sheets: 日次と広告一覧の行を作る（新しい日付が上）', async () => {
  const { dailyRows, creativeRows } = await import('../src/report/sheets.ts');
  const { creative, daily, brief } = await import('./fixtures.ts');
  const ctx = ctxWith(offlineLlm(catalog()));
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.c = creative({ id: 'c', metrics: daily('2026-10-01', 3, { impressions: 1000, clicks: 10, spend: 500, conversions: 1 }) });
  const d = dailyRows(ctx.store.state, '2026-10-03');
  assert.equal(d.length, 4);
  assert.equal(d[1][0], '2026-10-03');
  assert.equal(d[1][10], 1);
  const l = creativeRows(ctx.store.state, ctx.catalog);
  assert.equal(l[1][8], brief().overlay.main);
});

test('placeholderProblems: サンプルの社名・URL だけを検出し、実在の社名は誤検知しない', async () => {
  const { placeholderProblems } = await import('../src/config.ts');
  const { brand, job } = await import('./fixtures.ts');
  const base = catalog();
  assert.deepEqual(placeholderProblems({ ...base, brand: brand({ name: '株式会社名鉄運輸' }) }), []);
  assert.equal(placeholderProblems({ ...base, brand: brand({ name: '（社名をここに）' }) }).length, 1);
  assert.equal(placeholderProblems({ ...base, brand: brand({ name: '' }) }).length, 1);
  assert.equal(placeholderProblems({ ...base, jobs: [job({ landingUrl: 'https://www.example.com/x' })] }).length, 1);
});

test('enforceSpendCap: 当日の広告費が上限を超えたら全停止して入稿を凍結する', async () => {
  const { optimize } = await import('../src/pipeline/optimize.ts');
  const { creative, daily } = await import('./fixtures.ts');
  const stopped: string[] = [];
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: { stopAd: async (id: string) => void stopped.push(id), getAdset: async () => ({ id: '111', dailyBudget: null, status: 'ACTIVE' }) } as any });
  ctx.store.state.creatives.a = creative({ id: 'a', metrics: daily('2026-10-10', 1, { impressions: 10000, clicks: 100, spend: 60000, conversions: 1 }) });
  process.env.ADOPS_DAILY_SPEND_CAP = '50000';
  try {
    const d = await optimize(ctx);
    assert.equal(d.length, 0);
    assert.deepEqual(stopped, ['ad1']);
    assert.match(ctx.store.state.halted!.reason, /上限/);

    // 人が同じ日に解除したら、その日は上限で止め直さない
    delete ctx.store.state.halted;
    ctx.store.state.spendCapWaivedOn = '2026-10-10';
    stopped.length = 0;
    await optimize(ctx);
    assert.equal(ctx.store.state.halted, undefined);
    assert.deepEqual(stopped, []);
  } finally {
    delete process.env.ADOPS_DAILY_SPEND_CAP;
  }
});

test('runCycle: 途中で上限超えの緊急停止になったら、同じ実行の企画・入稿はしない', async () => {
  const { creative, daily } = await import('./fixtures.ts');
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta: { stopAd: async () => {}, getAdset: async () => ({ id: '111', dailyBudget: null, status: 'ACTIVE' }) } as any });
  ctx.store.state.creatives.a = creative({ id: 'a', metrics: daily('2026-10-10', 1, { impressions: 10000, clicks: 100, spend: 60000, conversions: 1 }) });
  process.env.ADOPS_DAILY_SPEND_CAP = '50000';
  try {
    const rec = await runCycle(ctx, ['optimize', 'plan', 'publish']);
    assert.ok(ctx.store.state.halted);
    assert.match(rec.steps.find((s) => s.name === 'plan')!.note, /緊急停止中のためスキップ/);
    assert.equal(Object.keys(ctx.store.state.briefs).length, 0);
  } finally {
    delete process.env.ADOPS_DAILY_SPEND_CAP;
  }
});

test('plan: 外国語ペルソナの企画は language と日本語訳を持ち、日本語ペルソナでは持たない', async () => {
  const { persona } = await import('./fixtures.ts');
  const cat = catalog({ personas: [persona(), persona({ id: 'vi', name: 'ベトナム人', language: 'vi' })], jobs: [job({ personas: ['p1', 'vi'], dailyCreativeQuota: 4 })], policy: policy({ briefsPerCycle: 4, videoShare: 0, exploreShare: 0 }) });
  const ctx = ctxWith(offlineLlm(cat), { catalog: cat });
  await plan(ctx);
  const briefs = Object.values(ctx.store.state.briefs);
  assert.ok(briefs.length > 0);
  for (const b of briefs) {
    if (b.personaId === 'vi') {
      assert.equal(b.language, 'vi');
      assert.ok(b.translationJa?.headline);
    } else {
      assert.equal(b.language, undefined);
      assert.equal(b.translationJa, undefined);
    }
  }
});
