/** Meta への入稿パラメータの形（HTTP は呼ばず、送る内容だけを確かめる）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaClient, publishToMeta } from '../src/platforms/meta.ts';
import { brief, creative, job } from './fixtures.ts';
import type { Asset } from '../src/types.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'adops-meta-'));
const file = (name: string) => {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  return p;
};

function fakeClient() {
  const client = new MetaClient({ accessToken: 't', adAccountId: '1', pageId: 'page1', instagramUserId: 'ig1', apiVersion: 'v25.0' }) as any;
  const sent: { method: string; path: string; params: any }[] = [];
  client.call = async (method: string, path: string, params: any) => {
    sent.push({ method, path, params });
    if (path.endsWith('adimages')) return { images: { x: { hash: `hash${sent.length}`, url: `https://cdn/${sent.length}.jpg` } } };
    if (path.endsWith('/ads')) {
      if (params.adset_id === 'bad') throw new Error('archived');
      return { id: `ad_${params.adset_id}` };
    }
    return { id: 'cre1' };
  };
  client.uploadVideo = async () => 'vid1';
  return { client, sent };
}

const img = (ratio: Asset['ratio']): Asset => ({ ratio, kind: 'image', path: file(`${ratio.replace(':', 'x')}.jpg`), width: 1, height: 1 });

test('画像: 4:5 と 9:16 を配置カスタマイズで出し分ける', async () => {
  const { client, sent } = fakeClient();
  await client.createCreative(brief(), job(), [img('4:5'), img('9:16'), img('1:1')], 'n');
  const spec = sent.find((x) => x.path.endsWith('adcreatives'))!.params;
  assert.equal(spec.object_story_spec.page_id, 'page1');
  assert.equal(spec.object_story_spec.instagram_user_id, 'ig1');
  const feed = spec.asset_feed_spec;
  assert.deepEqual(feed.ad_formats, ['SINGLE_IMAGE']);
  assert.equal(feed.images.length, 2);
  assert.equal(feed.asset_customization_rules.length, 2);
  assert.ok(feed.asset_customization_rules.every((r: any) => r.image_label && !r.video_label));
  assert.match(feed.link_urls[0].website_url, /utm_source=meta/);
});

test('インスタントフォーム: 配置カスタマイズを使わず、ボタンの遷移先をフォームにする', async () => {
  const { client, sent } = fakeClient();
  const j = job({ placements: { meta: { adsetIds: ['1'], leadFormId: 'form9' } } });
  await client.createCreative(brief(), j, [img('4:5'), img('9:16')], 'n');
  const spec = sent.find((x) => x.path.endsWith('adcreatives'))!.params;
  assert.equal(spec.asset_feed_spec, undefined);
  assert.equal(spec.object_story_spec.link_data.call_to_action.value.lead_gen_form_id, 'form9');
});

test('動画: 動画 ID とサムネイルを使い、video_label で出し分ける', async () => {
  const { client, sent } = fakeClient();
  const v = (ratio: Asset['ratio']): Asset => {
    const base = `v${ratio.replace(':', 'x')}`;
    file(`${base}.jpg`);
    return { ratio, kind: 'video', path: file(`${base}.mp4`), width: 1, height: 1 };
  };
  await client.createCreative(brief({ format: 'video' }), job(), [v('9:16'), v('4:5')], 'n');
  const feed = sent.find((x) => x.path.endsWith('adcreatives'))!.params.asset_feed_spec;
  assert.deepEqual(feed.ad_formats, ['SINGLE_VIDEO']);
  assert.ok(feed.videos.every((x: any) => x.video_id === 'vid1' && x.thumbnail_hash));
  assert.ok(feed.asset_customization_rules.every((r: any) => r.video_label && !r.image_label));
  // サムネイルは動画と同名の .jpg
  assert.ok(sent.filter((x) => x.path.endsWith('adimages')).length === 2);
});

test('publishToMeta: 一部の広告セットで失敗しても作成済みの広告とプレビュー URL を返す', async () => {
  const { client } = fakeClient();
  const c = creative({ assets: [img('4:5'), img('9:16')] });
  const r = await publishToMeta(client, c, brief(), job({ placements: { meta: { adsetIds: ['a1', 'bad'] } } }), false);
  assert.deepEqual(r.adIds, ['ad_a1']);
  assert.equal(r.errors.length, 1);
  assert.match(r.previewUrl!, /^https:\/\/cdn\//);
});

test('クリエイティブ: Meta の自動テキスト最適化などを OPT_OUT し、拒否されたら指定なしで作り直す', async () => {
  const { client, sent } = fakeClient();
  await client.createCreative(brief(), job(), [img('4:5'), img('9:16')], 'n');
  const first = sent.filter((x) => x.path.endsWith('adcreatives'));
  assert.equal(first.length, 1);
  assert.equal(first[0].params.degrees_of_freedom_spec.creative_features_spec.text_optimizations.enroll_status, 'OPT_OUT');

  // 指定が拒否された場合（サーバーのエラー）は1回だけ指定なしで作る
  const f2 = fakeClient();
  const orig = f2.client.call;
  f2.client.call = async (method: string, path: string, params: any) => {
    if (path.endsWith('adcreatives') && params.degrees_of_freedom_spec) {
      f2.sent.push({ method, path, params });
      throw new Error('Meta API POST act_1/adcreatives: Invalid parameter');
    }
    return orig(method, path, params);
  };
  const id = await f2.client.createCreative(brief(), job(), [img('4:5'), img('9:16')], 'n');
  assert.equal(id, 'cre1');
  const tries = f2.sent.filter((x) => x.path.endsWith('adcreatives'));
  assert.equal(tries.length, 2);
  assert.equal(tries[1].params.degrees_of_freedom_spec, undefined);
});
