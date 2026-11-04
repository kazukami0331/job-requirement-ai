import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedLlm } from '../src/llm/llm.ts';
import { offlineLlm } from '../src/llm/offline.ts';
import { loadSettings } from '../src/config.ts';
import { makeCtx, type Ctx } from '../src/pipeline/context.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { applyFeedback } from '../src/pipeline/feedback.ts';
import { publish } from '../src/pipeline/publish.ts';
import { buildPlanPrompt } from '../src/agents/strategist.ts';
import { brief, catalog, creative, job, policy } from './fixtures.ts';
import type { FeedbackRequest, LpCopy } from '../src/types.ts';

function ctxWith(llm = offlineLlm(catalog()), over: Partial<Ctx> = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'adops-fb-'));
  return makeCtx({
    settings: { ...loadSettings(), dataDir: dir, slack: { webhookUrl: '' } },
    catalog: catalog({ policy: policy({ requireHumanSelection: true }) }),
    store: new StateStore(dir),
    llm,
    images: new MockProvider(),
    meta: null,
    google: null,
    dryRun: true,
    cycleId: 'cy',
    today: '2026-10-10',
    ...over,
  });
}

const fb = (over: Partial<FeedbackRequest>): FeedbackRequest => ({ id: `f${Math.random()}`, at: '2026-10-10T00:00:00Z', target: 'creative', targetId: 'c1', action: 'approve', ...over });

test('feedback: 採用・却下は状態に反映し、同じ依頼は二度処理しない。却下の理由は以後の企画に渡す', async () => {
  const ctx = ctxWith();
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.c1 = creative({ id: 'c1', status: 'produced' });
  ctx.store.state.creatives.c2 = creative({ id: 'c2', status: 'produced' });
  const approve = fb({ id: 'a1', targetId: 'c1' });
  ctx.catalog.feedback = [approve, fb({ id: 'r1', targetId: 'c2', action: 'reject', note: '人物が若すぎる。40代に見える人にして' })];
  assert.match(await applyFeedback(ctx), /2 件を処理/);
  assert.ok(ctx.store.state.creatives.c1.humanApproved);
  assert.equal(ctx.store.state.creatives.c2.status, 'rejected');
  assert.equal(await applyFeedback(ctx), '', '処理済みはもう処理しない');
  const prompt = buildPlanPrompt([], ctx.catalog, { learnings: [], winners: [], losers: [], activeHooks: [], humanFeedback: ['却下: 人物が若すぎる。40代に見える人にして'] });
  assert.match(prompt, /人からの指摘[\s\S]*40代に見える人/);
  assert.equal(ctx.store.state.humanNotes![0].kind, 'reject');
});

test('feedback: 配信中の広告は却下できず、理由を結果に残す', async () => {
  const ctx = ctxWith();
  ctx.store.state.creatives.c1 = creative({ id: 'c1', status: 'published' });
  ctx.catalog.feedback = [fb({ id: 'x', action: 'reject' })];
  assert.match(await applyFeedback(ctx), /処理できず/);
  assert.equal(ctx.store.state.feedbackDone!.x.ok, false);
  assert.match(ctx.store.state.feedbackDone!.x.result, /配信中/);
});

test('feedback: 修正（コピー）は同じ画像で作り直し、配信中の広告や文言違いは別の広告として作る', async () => {
  const revisePrompts: string[] = [];
  const llm = offlineLlm(catalog());
  const base = (llm as any).handlers.get('strategist.revise');
  llm.on('strategist.revise', (req) => {
    revisePrompts.push(req.prompt);
    return { ...base(req), overlay: { main: '40代も活躍中', sub: '体への負担が少ない仕事', badges: [] } };
  });
  const ctx = ctxWith(llm);
  ctx.store.state.briefs.br_1 = brief();
  const src = join(ctx.settings.dataDir, 'a.png');
  writeFileSync(src, 'x');
  const imageJobs = [
    { ratio: '4:5' as const, provider: 'mock', prompt: 'p', requestedAt: 'x', paths: [src], selected: 0 },
    { ratio: '9:16' as const, provider: 'mock', prompt: 'p', requestedAt: 'x', paths: [src], selected: 0 },
  ];
  ctx.store.state.creatives.c1 = creative({ id: 'c1', status: 'produced', imageJobs, humanApproved: { at: 'x' } });
  ctx.store.state.creatives.live = creative({ id: 'live', status: 'published', imageJobs });
  ctx.catalog.feedback = [
    fb({ id: 'm1', targetId: 'c1', action: 'revise', note: '40代向けにして' }),
    fb({ id: 'm2', targetId: 'live', action: 'revise', note: '給与を先に' }),
    fb({ id: 'v1', targetId: 'c1', action: 'variant', note: '問いかけの言い方で' }),
  ];
  await applyFeedback(ctx);
  assert.match(revisePrompts[0], /40代向けにして/);
  assert.match(revisePrompts.at(-1)!, /問いかけの言い方で/);
  const c1 = ctx.store.state.creatives.c1;
  assert.equal(c1.status, 'planned');
  assert.equal(c1.humanApproved, undefined, '直したら選び直す');
  assert.equal(c1.imageJobs[0].paths![0], src, 'コピーだけなら画像はそのまま');
  assert.equal(ctx.store.state.briefs.br_1.overlay.main, '40代も活躍中');
  assert.equal(ctx.store.state.creatives.live.status, 'published', '配信中の広告は書き換えない');
  const copies = Object.values(ctx.store.state.creatives).filter((c) => c.variantOf);
  assert.equal(copies.length, 2);
  // 別の広告は、元の画像を自分の素材フォルダにコピーして使う（元の素材が整理されても消えない）
  assert.ok(copies.every((c) => c.status === 'planned' && c.imageJobs.length === 2 && c.imageJobs[0].paths![0].includes(c.id) && existsSync(c.imageJobs[0].paths![0]) && c.briefId !== 'br_1'));
  // 文言だけの修正では、AI が画像の記述を書き換えても元に戻す
  assert.equal(ctx.store.state.briefs.br_1.imagePrompt, brief().imagePrompt);

  // 元の画像が消えていても、文字なしの背景が残っていればそれで文言違いを作る
  const { rmSync, mkdirSync: mk } = await import('node:fs');
  rmSync(src);
  mk(ctx.store.assetDir('live'), { recursive: true });
  writeFileSync(join(ctx.store.assetDir('live'), 'live_4x5.bg.jpg'), 'bg');
  ctx.catalog.feedback.push(fb({ id: 'v2', targetId: 'live', action: 'variant', note: '数字で' }));
  await applyFeedback(ctx);
  const v2 = Object.values(ctx.store.state.creatives).find((c) => c.variantOf === 'live' && c.imageJobs.some((j) => j.paths?.[0]?.includes('_src.jpg')));
  assert.ok(v2, '文字なしの背景から作る');
  assert.deepEqual(v2!.imageJobs.map((j) => j.ratio), ['4:5'], '背景は 4:5 にだけ使い、9:16 は作り直す');
  // 却下した広告は直せない
  ctx.store.state.creatives.rej = creative({ id: 'rej', status: 'rejected' });
  ctx.catalog.feedback.push(fb({ id: 'm9', targetId: 'rej', action: 'revise', note: 'x' }));
  await applyFeedback(ctx);
  assert.equal(ctx.store.state.feedbackDone!.m9.ok, false);

  // 画像も直す依頼なら画像は作り直す
  ctx.catalog.feedback.push(fb({ id: 'm3', targetId: 'c1', action: 'revise', note: '工場の中の写真にして', scope: 'image' }));
  await applyFeedback(ctx);
  assert.equal(ctx.store.state.creatives.c1.imageJobs.length, 0);
});

test('feedback: 人が採用したものだけ入稿する（requireHumanSelection）', async () => {
  const ctx = ctxWith();
  ctx.store.state.briefs.br_1 = brief();
  ctx.store.state.creatives.c1 = creative({ id: 'c1', status: 'produced', assets: [] });
  const s = await publish(ctx);
  assert.match(s.skipped[0].reason, /人の採用待ち/);
});

test('feedback: LP の修正依頼は新しい下書きを作って元の下書きを取り下げ、検索広告の修正は作り直す。指示はプロンプトに入る', async () => {
  const copy: LpCopy = {
    heroTitle: '寮つきで今月から',
    heroSub: '愛知県豊田市の製造',
    heroBadges: [],
    empathyTitle: 't',
    empathyBody: 'b',
    points: [1, 2, 3].map((i) => ({ title: `p${i}`, body: 'b' })),
    faq: [{ q: 'q', a: 'a' }],
    ctaText: '応募する',
    closing: 'c',
  };
  const prompts: string[] = [];
  const llm = new ScriptedLlm()
    .on('lpWriter', (req) => (prompts.push(req.prompt), { ...copy, heroTitle: '40代も歓迎の製造スタッフ' }))
    .on('searchWriter', (req) => (prompts.push(req.prompt), { headlines: ['製造スタッフ募集', '愛知県豊田市'], descriptions: ['寮費無料の製造のお仕事です'], path1: '製造', path2: '寮' }));
  const ctx = ctxWith(llm);
  ctx.catalog.directives = [{ id: 'd', text: '急かす言い方はしない', scope: ['lp', 'google'] }];
  ctx.store.state.lps = { 'factory-aaa111': { id: 'factory-aaa111', jobId: 'factory', personaId: 'p1', status: 'draft', copy, issues: [], createdAt: 'x', createdOn: '2026-10-09' } };
  ctx.catalog.feedback = [
    fb({ id: 'l1', target: 'lp', targetId: 'factory-aaa111', action: 'revise', note: '40代にも向けて' }),
    fb({ id: 'g1', target: 'google', targetId: 'factory', action: 'revise', note: '寮を前に出して' }),
  ];
  await applyFeedback(ctx);
  assert.ok(prompts.every((p) => p.includes('急かす言い方はしない')));
  assert.ok(prompts[0].includes('40代にも向けて') && prompts[1].includes('寮を前に出して'));
  assert.equal(ctx.store.state.lps['factory-aaa111'].status, 'retired');
  const fresh = Object.values(ctx.store.state.lps).find((l) => l.status === 'draft')!;
  assert.equal(fresh.copy.heroTitle, '40代も歓迎の製造スタッフ');
  assert.ok(existsSync(join(ctx.settings.dataDir, 'lp-drafts', `${fresh.id}.html`)));
  assert.deepEqual(ctx.store.state.googleTexts!.factory.headlines, ['製造スタッフ募集', '愛知県豊田市']);
  assert.ok(ctx.store.state.feedbackDone!.l1.ok && ctx.store.state.feedbackDone!.g1.ok);
});
