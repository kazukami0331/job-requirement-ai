import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedLlm } from '../src/llm/llm.ts';
import { loadSettings } from '../src/config.ts';
import { makeCtx } from '../src/pipeline/context.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { approveLp, checkLpCopy, createLps, lpTargets, retireLp } from '../src/pipeline/lp.ts';
import { renderLp } from '../src/lp/html.ts';
import { brand, catalog, job, persona, policy } from './fixtures.ts';
import type { LpCopy } from '../src/types.ts';

const copy = (over: Partial<LpCopy> = {}): LpCopy => ({
  heroTitle: '寮つきで、今月から働ける',
  heroSub: '愛知県豊田市の製造スタッフ。月給30万円〜',
  heroBadges: ['寮費無料'],
  empathyTitle: '住まいと仕事、まとめて探していませんか',
  empathyBody: '引っ越しの費用が心配な方も、寮があるので始めやすいです。',
  points: [
    { title: '寮費無料', body: '住まいの心配をせずに働けます。' },
    { title: '日払いOK', body: '急な出費にも対応しやすいです。' },
    { title: '未経験歓迎', body: '初めての方も応募できます。' },
  ],
  faq: [{ q: '経験がなくても大丈夫？', a: '未経験歓迎の求人です。詳しくは面接でご確認ください。' }],
  ctaText: 'まずは応募する',
  closing: '気になったら、まずはお気軽にどうぞ。',
  ...over,
});

function ctxWith(llm: ScriptedLlm, over: Parameters<typeof catalog>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adops-lp-'));
  return makeCtx({
    settings: { ...loadSettings(), dataDir: dir, slack: { webhookUrl: '' } },
    catalog: catalog({ policy: policy({ lp: { enabled: true, perCycle: 5 } }), ...over }),
    store: new StateStore(dir),
    llm,
    images: new MockProvider(),
    meta: null,
    google: null,
    dryRun: true,
    cycleId: 'cy',
    today: '2026-10-10',
  });
}

test('checkLpCopy: 求人に無い待遇・年齢の限定・社内NGを見つける', () => {
  assert.equal(checkLpCopy(copy(), job(), brand()).filter((i) => i.severity !== 'minor').length, 0);
  const bad = checkLpCopy(copy({ heroBadges: ['入社祝い金'], empathyBody: '30歳までの方限定。誰でも簡単です' }), job(), brand());
  assert.ok(bad.some((i) => i.problem.includes('入社祝い金')));
  assert.ok(bad.some((i) => i.severity === 'blocker' && /年齢|歳/.test(i.problem)));
  assert.ok(bad.some((i) => i.problem.includes('誰でも簡単')));
});

test('renderLp: 事実は求人情報から表示し、応募ボタンは applyUrl に utm を引き継ぐ。文章は HTML エスケープする', () => {
  const html = renderLp(copy({ heroTitle: '<script>alert(1)</script>' }), job({ applyUrl: 'https://form.test/apply' }), brand(), { slug: 'factory-abc123' });
  assert.match(html, /月給 30万円〜38万円/);
  assert.match(html, /href="https:\/\/form.test\/apply" data-apply/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /"factory-abc123"/);
  assert.doesNotMatch(html, /下書き（承認するまで/);
  assert.match(renderLp(copy(), job(), brand(), { slug: 'x', draft: true }), /下書き/);
});

test('lpTargets: 求人×日本語のペルソナ×仮説ごと。外国語のペルソナは対象外', () => {
  const c = catalog({
    jobs: [job({ personas: ['p1', 'p2', 'vi'] })],
    personas: [persona(), persona({ id: 'p2' }), persona({ id: 'vi', language: 'vi' })],
    hypotheses: [
      { id: 'h1', personaId: 'p1', angle: 'pay', title: 't', message: 'm' },
      { id: 'h2', personaId: 'p1', angle: 'housing', title: 't', message: 'm' },
      { id: 'h3', personaId: 'p1', angle: 'team', title: 't', message: 'm', active: false },
    ],
  });
  const t = lpTargets(ctxWith(new ScriptedLlm(), c));
  assert.deepEqual(t.map((x) => `${x.personaId}/${x.hypothesis?.id ?? '-'}`), ['p1/h1', 'p1/h2', 'p2/-']);
});

test('createLps → approveLp → 求人の停止で公開終了。問題が直らない文章は却下', async () => {
  let calls = 0;
  const llm = new ScriptedLlm().on('lpWriter', (req) => {
    calls++;
    // 1回目は求人に無い待遇を書き、直させると直る
    return req.prompt.includes('チェックで見つかった問題') ? copy() : copy({ heroBadges: ['入社祝い金'] });
  });
  const ctx = ctxWith(llm);
  const note = await createLps(ctx);
  assert.match(note, /下書き 1 本/);
  assert.equal(calls, 2);
  const [lp] = Object.values(ctx.store.state.lps!);
  assert.equal(lp.status, 'draft');
  const draftFile = join(ctx.settings.dataDir, 'lp-drafts', `${lp.id}.html`);
  assert.ok(existsSync(draftFile));
  // 同じ組み合わせはもう作らない
  assert.equal(await createLps(ctx), '');

  assert.match(approveLp(ctx, lp.id), /公開しました/);
  const liveFile = join(ctx.settings.dataDir, 'lp', `${lp.id}.html`);
  assert.ok(existsSync(liveFile) && !existsSync(draftFile));
  assert.doesNotMatch(readFileSync(liveFile, 'utf8'), /下書き（承認/);
  assert.throws(() => approveLp(ctx, lp.id), /下書きではありません/);

  // 求人の募集が終わったら公開をやめる
  ctx.catalog.jobs[0].active = false;
  await createLps(ctx);
  assert.equal(lp.status, 'retired');
  assert.ok(!existsSync(liveFile));

  // 直しても問題が残る文章は却下して、7日間は作り直さない
  const llm2 = new ScriptedLlm().on('lpWriter', () => copy({ heroBadges: ['入社祝い金'] }));
  const ctx2 = ctxWith(llm2);
  assert.match(await createLps(ctx2), /LP 却下/);
  assert.equal(Object.values(ctx2.store.state.lps!)[0].status, 'rejected');
  assert.equal(await createLps(ctx2), '');
});

test('approveLp: サンプル設定のままなら公開しない。retireLp で公開を終了', async () => {
  const ctx = ctxWith(new ScriptedLlm().on('lpWriter', () => copy()), { brand: brand({ name: '（社名をここに）' }) });
  await createLps(ctx);
  const [lp] = Object.values(ctx.store.state.lps!);
  assert.throws(() => approveLp(ctx, lp.id), /サンプル設定/);
  assert.match(retireLp(ctx, lp.id), /終了/);
  assert.equal(lp.status, 'retired');
  // 人が終了したものは30日は作り直さない
  assert.equal(await createLps(ctx), '');
});

test('refreshLps: 作成を止めても・緊急停止中でも募集終了の LP は取り下げ、状態と食い違う公開ファイルは消す', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const ctx = ctxWith(new ScriptedLlm().on('lpWriter', () => copy()));
  await createLps(ctx);
  const [lp] = Object.values(ctx.store.state.lps!);
  approveLp(ctx, lp.id);
  // 状態に無いファイル（承認の途中で失敗したなど）
  mkdirSync(join(ctx.settings.dataDir, 'lp'), { recursive: true });
  writeFileSync(join(ctx.settings.dataDir, 'lp', 'orphan-abc123.html'), 'x');
  ctx.catalog.policy.lp = { enabled: false };
  ctx.store.state.halted = { at: 'now', reason: 'test' };
  const note = await createLps(ctx);
  assert.match(note, /orphan-abc123/);
  assert.ok(!existsSync(join(ctx.settings.dataDir, 'lp', 'orphan-abc123.html')));
  assert.ok(existsSync(join(ctx.settings.dataDir, 'lp', `${lp.id}.html`)), '公開中のものは残す');
  ctx.catalog.jobs[0].active = false;
  await createLps(ctx);
  assert.equal(lp.status, 'retired');
  assert.ok(!existsSync(join(ctx.settings.dataDir, 'lp', `${lp.id}.html`)));
});
