import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSearchLosers, rotateSearchAds } from '../src/pipeline/search.ts';
import { sanitizeRsa } from '../src/agents/searchWriter.ts';
import { offlineLlm } from '../src/llm/offline.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { makeCtx } from '../src/pipeline/context.ts';
import { loadSettings } from '../src/config.ts';
import { catalog, daily, job } from './fixtures.ts';
import type { SearchAd } from '../src/types.ts';

const ad = (id: string, clicks: number, over: Partial<SearchAd> = {}): SearchAd => ({
  id,
  jobId: 'factory',
  adGroupId: 'g1',
  resourceName: `customers/1/adGroupAds/1~${id}`,
  headlines: ['a'],
  descriptions: ['b'],
  status: 'live',
  metrics: daily('2026-10-01', 14, { impressions: 500, clicks, spend: 100, conversions: 0 }),
  createdAt: '2026-10-01T00:00:00Z',
  createdOn: '2026-10-01',
  ...over,
});

test('pickSearchLosers: 十分な表示と期間がある2本のうち、CTR が7割未満の方を止める', () => {
  assert.deepEqual(pickSearchLosers([ad('a', 30), ad('b', 10)], '2026-10-15').map((d) => d.adId), ['b']);
  assert.equal(pickSearchLosers([ad('a', 30), ad('b', 25)], '2026-10-15').length, 0);
  // 配信から日が浅いものは対象外
  assert.equal(pickSearchLosers([ad('a', 30), ad('b', 10, { createdOn: '2026-10-10' })], '2026-10-15').length, 0);
});

test('sanitizeRsa: 文字数超過・法令 NG・重複を落とす', () => {
  const r = sanitizeRsa(
    {
      headlines: ['寮費無料の製造スタッフ', '寮費無料の製造スタッフ', 'とても長い見出しなので上限の全角十五文字を超える', '35歳までの方歓迎', '月給30万円〜'],
      descriptions: ['未経験歓迎。まずは詳細をご覧ください。', '必ず稼げる仕事です'],
      path1: '製造 求人/寮付き',
      path2: '豊田市の工場の求人',
    },
    job(),
    catalog(),
  );
  assert.deepEqual(r.headlines, ['寮費無料の製造スタッフ', '月給30万円〜']);
  assert.deepEqual(r.descriptions, ['未経験歓迎。まずは詳細をご覧ください。']);
  assert.equal(r.path1, '製造求人寮付き');
  assert.ok(r.path2.length <= 7);
  assert.equal(r.dropped.length, 3);
});

test('rotateSearchAds: DRY RUN では下書きを1日1本だけ作る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adops-search-'));
  const cat = catalog({ jobs: [job({ placements: { google: { searchAdGroupIds: ['g1'] } } })] });
  const ctx = makeCtx({
    settings: { ...loadSettings(), dataDir: dir },
    catalog: cat,
    store: new StateStore(dir),
    llm: offlineLlm(cat),
    images: new MockProvider(),
    meta: null,
    google: null,
    dryRun: true,
    cycleId: 'cy',
    today: '2026-10-10',
  });
  await rotateSearchAds(ctx);
  await rotateSearchAds(ctx);
  const ads = Object.values(ctx.store.state.searchAds!);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].status, 'draft');
  assert.ok(ads[0].headlines.length >= 8);
});
