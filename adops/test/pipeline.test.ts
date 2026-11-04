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

  // 再審査で承認されて配信が始まったら、配信中として扱う
  statuses.set('ad_ng', { status: 'ACTIVE' });
  await syncStatuses(ctx);
  assert.equal(cs.ng.status, 'published');

  // Google の結果が取れないとき（API 未設定）は、Meta が全部不承認でも failed にしない
  ctx.store.state.creatives.both = creative({ id: 'both', platformRefs: { meta: { adIds: ['ad_x'], creativeIds: [] }, google: { assetResourceNames: [], linkedTo: ['customers/1/adGroupAds/2~3'] } } });
  statuses.set('ad_x', { status: 'DISAPPROVED' });
  await syncStatuses(ctx);
  assert.equal(cs.both.status, 'published');
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
  assert.equal(l[1][9], brief().overlay.main);
  assert.equal(l[1][8], 'ja');
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

test('月の広告費の上限: 9割を超えたら予算を増やさず、超えたら全停止。解除した月は止め直さない', async () => {
  const { optimize, monthlySpend } = await import('../src/pipeline/optimize.ts');
  const { creative, daily } = await import('./fixtures.ts');
  const stopped: string[] = [];
  const meta = { stopAd: async (id: string) => void stopped.push(id), getAdset: async () => ({ id: '111', dailyBudget: 10000, status: 'ACTIVE' }), updateAdsetBudget: async () => {} } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta });
  // 先月分は数えない
  ctx.store.state.creatives.a = creative({
    id: 'a',
    metrics: [...daily('2026-09-20', 5, { impressions: 10000, clicks: 200, spend: 9000, conversions: 3 }), ...daily('2026-10-04', 7, { impressions: 10000, clicks: 200, spend: 3000, conversions: 3 })],
  });
  try {
    assert.equal(monthlySpend(ctx), null);
    const scaling = (await optimize(ctx)).filter((d) => d.action === 'scale_budget');
    assert.ok(scaling.length > 0, '上限なしなら予算増の判断が出る');

    process.env.ADOPS_MONTHLY_SPEND_CAP = '22000';
    assert.equal(monthlySpend(ctx)!.spent, 21000);
    const d = await optimize(ctx);
    assert.equal(d.filter((x) => x.action === 'scale_budget').length, 0);
    assert.equal(ctx.store.state.halted, undefined);

    process.env.ADOPS_MONTHLY_SPEND_CAP = '20000';
    await optimize(ctx);
    assert.match(ctx.store.state.halted!.reason, /月の上限/);
    assert.deepEqual(stopped, ['ad1']);

    delete ctx.store.state.halted;
    ctx.store.state.monthlyCapWaivedFor = '2026-10';
    await optimize(ctx);
    assert.equal(ctx.store.state.halted, undefined);
  } finally {
    delete process.env.ADOPS_MONTHLY_SPEND_CAP;
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
  const { placementsFor } = await import('../src/config.ts');
  const personas = [persona(), persona({ id: 'vi', name: 'ベトナム人', language: 'vi' })];
  const pol = policy({ briefsPerCycle: 4, videoShare: 0, exploreShare: 0 });
  // 専用の入稿先がなければ、外国語ペルソナは企画しない
  const noPl = catalog({ personas, jobs: [job({ personas: ['p1', 'vi'], dailyCreativeQuota: 4 })], policy: pol });
  const ctx0 = ctxWith(offlineLlm(noPl), { catalog: noPl });
  await plan(ctx0);
  assert.ok(Object.values(ctx0.store.state.briefs).every((b) => b.personaId === 'p1'));
  assert.deepEqual(placementsFor(noPl, noPl.jobs[0], 'vi'), {});

  const cat = catalog({ personas, jobs: [job({ personas: ['p1', 'vi'], dailyCreativeQuota: 4, placementsByPersona: { vi: { meta: { adsetIds: ['999'] } } } })], policy: pol });
  assert.deepEqual(placementsFor(cat, cat.jobs[0], 'vi').meta?.adsetIds, ['999']);
  assert.deepEqual(placementsFor(cat, cat.jobs[0], 'p1').meta?.adsetIds, ['111']);
  const ctx = ctxWith(offlineLlm(cat), { catalog: cat });
  await plan(ctx);
  const briefs = Object.values(ctx.store.state.briefs);
  assert.ok(briefs.some((b) => b.personaId === 'vi'));
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

test('windowFromCursor: 前回の通知位置から今までを対象にし、無い・古すぎる場合は時刻の窓', async () => {
  const { windowFromCursor, leadWindow } = await import('../src/pipeline/leads.ts');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'adops-leads-'));
  const p = join(dir, 'cursor.json');
  const now = new Date('2026-10-26T05:40:00Z');
  assert.deepEqual(windowFromCursor(p, now), { ...leadWindow(now), hookSince: leadWindow(now).since });
  const prev = Math.floor(new Date('2026-10-26T02:30:00Z').getTime() / 1000);
  writeFileSync(p, JSON.stringify({ until: prev }));
  const w = windowFromCursor(p, now);
  assert.equal(w.since, prev);
  assert.equal(w.hookSince, prev);
  assert.equal(w.until, Math.floor(now.getTime() / 1000) - 60);
  // 古すぎる位置なら直近24時間（1時間に縮めて取りこぼさない）
  writeFileSync(p, JSON.stringify({ until: prev - 3 * 86400 }));
  const old = windowFromCursor(p, now);
  assert.equal(old.since, old.until - 24 * 3600);
  // 連携先への未送信分があれば、そこからさかのぼる
  writeFileSync(p, JSON.stringify({ until: prev, hookPendingSince: prev - 3 * 86400 }));
  assert.equal(windowFromCursor(p, now).hookSince, prev - 3 * 86400);
  assert.equal(windowFromCursor(p, now).since, prev);
  // 位置が使えなくても（未来の値など）未送信分は引き継ぐ
  writeFileSync(p, JSON.stringify({ until: prev + 86400, hookPendingSince: prev - 86400 }));
  assert.equal(windowFromCursor(p, now).hookSince, prev - 86400);
});

test('notifyLeads: 連携先への送信に失敗しても Slack には通知し、未送信分を次回再送する', async () => {
  const { notifyLeads } = await import('../src/pipeline/leads.ts');
  const { job } = await import('./fixtures.ts');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'adops-leads-'));
  const cursor = join(dir, 'cursor.json');
  const now = new Date('2026-10-26T05:40:00Z');
  const t0 = Math.floor(Date.parse('2026-10-26T05:00:00Z') / 1000);
  writeFileSync(cursor, JSON.stringify({ until: t0 - 600 }));
  const fakeMeta = { leads: async () => [{ id: 'l1', createdTime: t0, fields: { full_name: '山田 太郎' } }] } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { meta: fakeMeta });
  ctx.catalog.jobs = [job({ placements: { meta: { adsetIds: ['1'], leadFormId: 'form1' } } })];
  const slack: string[] = [];
  const realFetch = globalThis.fetch;
  ctx.settings.slack.webhookUrl = 'https://hooks.example/slack';
  process.env.ADOPS_LEADS_WEBHOOK_URL = 'https://crm.example/hook';
  globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).includes('crm')) return new Response('ng', { status: 500 });
    slack.push(init.body);
    return new Response('ok');
  }) as any;
  try {
    await assert.rejects(notifyLeads(ctx, now, cursor), /再送/);
    assert.equal(slack.length, 1);
    assert.match(slack[0], /送信に失敗/);
    const saved = JSON.parse(readFileSync(cursor, 'utf8'));
    assert.equal(saved.hookPendingSince, t0 - 600);
    assert.ok(saved.until > t0);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ADOPS_LEADS_WEBHOOK_URL;
  }
});

test('postLeads: 応募者情報を署名つきで連携先に送り、失敗したら例外', async () => {
  const { postLeads } = await import('../src/pipeline/leads.ts');
  const { createServer } = await import('node:http');
  const { createHmac } = await import('node:crypto');
  let got: { body: string; sig?: string } | null = null;
  let status = 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got = { body, sig: req.headers['x-adops-signature'] as string | undefined };
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/hook`;
  process.env.ADOPS_LEADS_WEBHOOK_SECRET = 'sec';
  try {
    await postLeads(url, [{ leadId: 'l1', fields: { full_name: '山田 太郎' } }]);
    assert.equal(JSON.parse(got!.body).leads[0].leadId, 'l1');
    assert.equal(got!.sig, `sha256=${createHmac('sha256', 'sec').update(got!.body).digest('hex')}`);
    status = 500;
    await assert.rejects(postLeads(url, [{ leadId: 'l2' }]), /再送/);
  } finally {
    delete process.env.ADOPS_LEADS_WEBHOOK_SECRET;
    server.close();
  }
});

test('checkCredentials: Meta のトークンが14日以内に切れるなら「今日やること」に出す（1日1回）', async () => {
  const { checkCredentials } = await import('../src/pipeline/credentials.ts');
  const now = Date.parse('2026-10-10T00:00:00Z');
  let calls = 0;
  let expiresAt: number | null = now / 1000 + 5 * 86400 + 60;
  const meta = { tokenExpiry: async () => (calls++, { valid: true, expiresAt }) } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { meta });
  assert.match(await checkCredentials(ctx, now), /あと 5 日/);
  assert.equal(ctx.store.state.credentials!.alerts.length, 1);
  // 同じ日は確認し直さない
  await checkCredentials(ctx, now);
  assert.equal(calls, 1);
  // 無期限なら何も出さない
  expiresAt = null;
  ctx.store.state.credentials!.checkedOn = '2026-10-09';
  assert.equal(await checkCredentials(ctx, now), '');
  assert.deepEqual(ctx.store.state.credentials!.alerts, []);
});

test('optimize: 広告セットのフリークエンシーと学習の状態を記録し、出しすぎ・学習制限を Slack の警告に出す', async () => {
  const { optimize } = await import('../src/pipeline/optimize.ts');
  const { creative, daily } = await import('./fixtures.ts');
  let freq: { frequency: number; reach: number } | null = { frequency: 5.2, reach: 12000 };
  let freqCalls = 0;
  const meta = {
    getAdset: async () => ({ id: '111', dailyBudget: 10000, status: 'ACTIVE', learning: 'FAIL' }),
    adsetFrequency: async () => (freqCalls++, freq),
    setAdsetDailyBudget: async () => {},
  } as any;
  const ctx = ctxWith(offlineLlm(catalog()), { dryRun: false, meta });
  ctx.store.state.creatives.a = creative({ id: 'a', metrics: daily('2026-10-04', 7, { impressions: 10000, clicks: 200, spend: 3000, conversions: 3 }) });
  ctx.store.state.audience = { old: { date: '2026-09-01', frequency: 1 } };
  const d = await optimize(ctx);
  assert.equal(d.filter((x) => x.action === 'scale_budget').length, 0, '出しすぎの広告セットは予算を増やさない');
  assert.deepEqual(ctx.store.state.audience['111'], { date: '2026-10-10', learning: 'FAIL', frequency: 5.2, reach: 12000 });
  assert.equal(ctx.store.state.audience.old, undefined, '古い記録は消す');
  // 同じ日の2回目は取り直さない
  await optimize(ctx);
  assert.equal(freqCalls, 1);
  // フリークエンシーが取れない日でも学習の状態は記録する
  ctx.today = '2026-10-11';
  freq = null;
  await optimize(ctx);
  assert.deepEqual(ctx.store.state.audience['111'], { date: '2026-10-11', learning: 'FAIL' });
});

test('plan: 入稿されない完成品が溜まりすぎたら新規企画を止める（DRY RUN の試運転が続いても費用を使い続けない）', async () => {
  const { plan } = await import('../src/pipeline/plan.ts');
  const { creative } = await import('./fixtures.ts');
  const ctx = ctxWith(offlineLlm(catalog()));
  const n = ctx.catalog.policy.briefsPerCycle * 4;
  for (let i = 0; i < n; i++) ctx.store.state.creatives[`p${i}`] = creative({ id: `p${i}`, status: 'produced' });
  assert.equal((await plan(ctx)).created.length, 0);
  delete ctx.store.state.creatives.p0;
  assert.ok((await plan(ctx)).created.length > 0);
  // 停止・削除した求人の完成品は数えない（企画が止まり続けないように）
  const ctx2 = ctxWith(offlineLlm(catalog()));
  for (let i = 0; i < n; i++) ctx2.store.state.creatives[`q${i}`] = creative({ id: `q${i}`, status: 'produced', jobId: 'deleted-job' });
  assert.ok((await plan(ctx2)).created.length > 0);
});

test('export: 広告ごとの要素×採点×結果の CSV と、Google 広告エディタ用の検索広告テキストを書き出す', async () => {
  const { exportAll, toCsv } = await import('../src/pipeline/exports.ts');
  const { creative, brief, daily } = await import('./fixtures.ts');
  const { readFileSync } = await import('node:fs');
  assert.equal(toCsv([['a,b', 'say "hi"', 1]]), '﻿"a,b","say ""hi""",1\r\n');
  const ctx = ctxWith(offlineLlm(catalog()));
  ctx.catalog.rubric = { version: 'v1', items: [{ id: 'stop', label: '止める力', description: 'd' }] };
  ctx.store.state.briefs.br_1 = brief({ elements: { motif: 'real_person', person: '40代男性', setting: '工場', palette: '青', taste: 'bright', copyTone: 'number' } });
  ctx.store.state.creatives.c = creative({ id: 'c', briefId: 'br_1', review: { score: 80, scores: { stop: 4 }, rubricVersion: 'v1' }, metrics: daily('2026-10-01', 2, { impressions: 1000, clicks: 20, spend: 2000, conversions: 1 }) });
  const note = await exportAll(ctx);
  assert.match(note, /広告 1 本/);
  const csv = readFileSync(join(ctx.settings.dataDir, 'exports', 'creatives.csv'), 'utf8');
  const [head, row] = csv.replace('﻿', '').trim().split('\r\n');
  const cols = head.split(',');
  const val = (name: string) => row.split(',')[cols.indexOf(name)];
  assert.equal(val('モチーフ'), '実写の人物');
  assert.equal(val('コピーの型'), '数字');
  assert.equal(val('採点:止める力'), '4');
  assert.equal(val('表示'), '2000');
  assert.equal(val('応募単価(円)'), '2000');
  const g = readFileSync(join(ctx.settings.dataDir, 'exports', 'google-rsa.csv'), 'utf8');
  assert.match(g, /Headline 15/);
  assert.equal(g.trim().split('\r\n').length, 2, '稼働中の求人1件ぶん');
  // 30日以内なら作り直さない
  assert.doesNotMatch(await exportAll(ctx), /新しく作成/);
});
