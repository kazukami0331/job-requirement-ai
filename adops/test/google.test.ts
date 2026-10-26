/** Google 広告への入稿パラメータの形（HTTP は呼ばず、送る内容だけを確かめる）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAdsClient, publishToGoogle } from '../src/platforms/google.ts';
import { googleWidth } from '../src/compliance/rules.ts';
import { brief, creative, job } from './fixtures.ts';
import type { Asset } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'adops-google-'));
const img = (ratio: Asset['ratio']): Asset => {
  const p = join(dir, `${ratio.replace(':', 'x')}.jpg`);
  writeFileSync(p, 'x');
  return { ratio, kind: 'image', path: p, width: 1, height: 1 };
};

function fakeClient() {
  const client = new GoogleAdsClient({ developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r', customerId: '123', loginCustomerId: '', apiVersion: 'v26', conversionActionName: '' }) as any;
  const sent: { path: string; body: any }[] = [];
  let n = 0;
  client.call = async (path: string, body: any) => {
    sent.push({ path, body });
    return { results: body.operations.map(() => ({ resourceName: `customers/123/x/${++n}` })) };
  };
  return { client, sent };
}

test('デマンド ジェネレーション（画像）: 比率ごとの画像枠・見出し・ロゴ・社名を入れる', async () => {
  const { client, sent } = fakeClient();
  const c = creative({ assets: [img('1.91:1'), img('1:1'), img('4:5'), img('9:16')] });
  const r = await publishToGoogle(client, c, brief(), job({ placements: { google: { adGroupIds: ['77'] } } }), false, { logoAsset: 'customers/123/assets/9', businessName: '社名' });
  const create = sent.find((x) => x.path.endsWith('adGroupAds:mutate'))!.body.operations[0].create;
  assert.equal(create.status, 'PAUSED');
  assert.equal(create.adGroup, 'customers/123/adGroups/77');
  const ad = create.ad.demandGenMultiAssetAd;
  assert.equal(ad.marketingImages.length, 1);
  assert.equal(ad.squareMarketingImages.length, 1);
  assert.equal(ad.portraitMarketingImages.length, 1);
  assert.equal(ad.businessName, '社名');
  assert.ok(ad.headlines.every((h: any) => googleWidth(h.text) <= 30));
  assert.equal(r.linkedTo.length, 1);
  // 9:16 は Google の画像枠に無いのでアップロードしない
  assert.equal(sent.filter((x) => x.path.endsWith('assets:mutate')).length, 3);
});

test('デマンド ジェネレーション（動画）: YouTube 動画と businessName（テキストアセット）を入れる', async () => {
  const { client, sent } = fakeClient();
  await publishToGoogle(client, creative({ assets: [] }), brief(), job({ placements: { google: { adGroupIds: ['77'] } } }), true, {
    youtubeVideoId: 'yt1',
    logoAsset: 'customers/123/assets/9',
    businessName: '社名',
  });
  const ad = sent.find((x) => x.path.endsWith('adGroupAds:mutate'))!.body.operations[0].create.ad.demandGenVideoResponsiveAd;
  assert.equal(ad.videos.length, 1);
  assert.deepEqual(ad.businessName, { text: '社名' });
  assert.ok(ad.longHeadlines[0].text);
});

test('P-MAX: draft モードでは入れず、auto モードでは比率に合う枠で紐付ける', async () => {
  const placements = { google: { assetGroupIds: ['55'] } };
  const a = fakeClient();
  const r1 = await publishToGoogle(a.client, creative({ assets: [img('1:1')] }), brief(), job({ placements }), false, {});
  assert.equal(r1.linkedTo.length, 0);
  assert.ok(!a.sent.some((x) => x.path.endsWith('assetGroupAssets:mutate')));
  const b = fakeClient();
  await publishToGoogle(b.client, creative({ assets: [img('1:1'), img('4:5')] }), brief(), job({ placements }), true, {});
  const ops = b.sent.find((x) => x.path.endsWith('assetGroupAssets:mutate'))!.body.operations;
  assert.deepEqual(
    ops.map((o: any) => o.create.fieldType),
    ['SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'HEADLINE', 'HEADLINE'],
  );
});

test('searchBudgetLoss: 検索広告の広告グループのキャンペーンについて、予算不足で逃した表示の割合を返す', async () => {
  const { client } = fakeClient();
  const queries: string[] = [];
  client.search = async (q: string) => {
    queries.push(q);
    if (q.includes('FROM ad_group')) return [{ campaign: { id: '900' } }, { campaign: { id: '900' } }];
    return [{ campaign: { id: '900', name: '検索_工場' }, metrics: { searchBudgetLostImpressionShare: 0.35, searchImpressionShare: 0.4 } }];
  };
  const r = await client.searchBudgetLoss(['55', '56', 'x']);
  assert.match(queries[0], /ad_group\.id IN \(55,56\)/);
  assert.match(queries[1], /campaign\.id IN \(900\) AND segments\.date DURING LAST_7_DAYS/);
  assert.deepEqual(r, [{ campaignId: '900', name: '検索_工場', lostToBudget: 0.35, impressionShare: 0.4 }]);
  assert.deepEqual(await client.searchBudgetLoss([]), []);
});
