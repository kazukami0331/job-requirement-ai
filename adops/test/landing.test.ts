import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offlineLlm } from '../src/llm/offline.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { makeCtx, type Ctx } from '../src/pipeline/context.ts';
import { checkLandingPages, classifyPage, landingBroken, type PageResult } from '../src/pipeline/landing.ts';
import { loadSettings } from '../src/config.ts';
import { brief, catalog, creative, job } from './fixtures.ts';

function ctxWith(pages: Record<string, PageResult>, over: Partial<Ctx> = {}): Ctx & { calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'adops-lp-'));
  const calls: string[] = [];
  const cat = catalog({ jobs: [job(), job({ id: 'driver', title: '配送ドライバー', landingUrl: 'https://recruit.test-company.jp/jobs/driver' })] });
  const ctx = makeCtx({
    settings: { ...loadSettings(), dataDir: dir, slack: { webhookUrl: '' } },
    catalog: cat,
    store: new StateStore(dir),
    llm: offlineLlm(cat),
    images: new MockProvider(),
    meta: null,
    google: null,
    dryRun: true,
    cycleId: 'cy_test',
    today: '2026-10-10',
    checkPage: async (url) => {
      calls.push(url);
      return pages[url] ?? { status: 200, body: '<html>募集中</html>' };
    },
    ...over,
  });
  return Object.assign(ctx, { calls });
}

test('classifyPage: 404・接続不可・募集終了は異常、403 やタイムアウトは判定不能', () => {
  assert.equal(classifyPage({ status: 200, body: '<h1>製造スタッフ募集</h1>' }).ok, true);
  assert.equal(classifyPage({ status: 404, body: '' }).ok, false);
  assert.equal(classifyPage({ status: 503, body: '' }).ok, false);
  assert.equal(classifyPage({ status: 0, body: '', error: 'ENOTFOUND' }).ok, false);
  assert.equal(classifyPage({ status: 0, body: '', error: 'TimeoutError', transient: true }).ok, null);
  assert.equal(classifyPage({ status: 403, body: '' }).ok, null);
  assert.equal(classifyPage({ status: 200, body: '<p>この求人の募集は終了しました</p>' }).ok, false);
  assert.equal(classifyPage({ status: 200, body: '<p>こちらの求人は<b>募集を終了しました</b></p>' }).ok, false);
  // メニューにある「募集終了の求人」のような言葉や、スクリプト内の文字列では止めない
  assert.equal(classifyPage({ status: 200, body: '<a>募集終了の求人を見る</a><script>var s="募集は終了しました"</script>' }).ok, true);
});

test('checkLandingPages: 壊れたページの求人は入稿を止め、直れば再開。判定不能なら前回の判定を引き継ぐ', async () => {
  const pages: Record<string, PageResult> = { 'https://recruit.test-company.jp/jobs/driver': { status: 404, body: '' } };
  const ctx = ctxWith(pages);
  const note = await checkLandingPages(ctx);
  assert.match(note, /正常 1 \/ 異常 1/);
  assert.equal(landingBroken(ctx, 'factory'), undefined);
  const broken = landingBroken(ctx, 'driver');
  assert.ok(broken);
  const since = broken.since;

  // 判定不能（403）になっても、異常のまま（since も変わらない）
  pages['https://recruit.test-company.jp/jobs/driver'] = { status: 403, body: '' };
  await checkLandingPages(ctx);
  assert.equal(landingBroken(ctx, 'driver')?.since, since);

  // 直ったら再開
  pages['https://recruit.test-company.jp/jobs/driver'] = { status: 200, body: 'ok' };
  await checkLandingPages(ctx);
  assert.equal(landingBroken(ctx, 'driver'), undefined);
});

test('checkLandingPages: 同じ URL は1回だけ確認し、確認関数が無ければ何もしない', async () => {
  const ctx = ctxWith({});
  ctx.catalog.jobs[1].landingUrl = ctx.catalog.jobs[0].landingUrl;
  await checkLandingPages(ctx);
  assert.equal(ctx.calls.length, 1);

  const off = ctxWith({}, { checkPage: undefined });
  assert.match(await checkLandingPages(off), /無効/);
  assert.equal(off.store.state.landing, undefined);
});

test('publish: 応募ページが壊れている求人は入稿を保留する', async () => {
  const { publish } = await import('../src/pipeline/publish.ts');
  const ctx = ctxWith({}, { dryRun: false, meta: {} as never });
  ctx.store.state.landing = { factory: { ok: false, status: 404, note: 'HTTP 404', checkedAt: '2026-10-10T00:00:00Z' } };
  ctx.store.state.creatives.cr_1 = creative({ status: 'produced', platformRefs: {} });
  ctx.store.state.briefs.br_1 = brief();
  const r = await publish(ctx);
  assert.equal(r.published.length, 0);
  assert.match(r.skipped[0].reason, /応募ページ/);
});
