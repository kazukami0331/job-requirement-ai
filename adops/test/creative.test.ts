import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { composeImage, fitFont, textUnits, wrapJa } from '../src/creative/compose.ts';
import { buildMjPrompt, MockProvider, HandoffProvider } from '../src/creative/imageProvider.ts';
import { LocalInbox, signJwt } from '../src/creative/inbox.ts';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { brand, brief, job } from './fixtures.ts';
import { googleTexts, fitGoogle } from '../src/platforms/google.ts';
import { withUtm } from '../src/platforms/meta.ts';
import { googleWidth } from '../src/compliance/rules.ts';
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

test('wrapJa: 幅で折り返し、句読点を行頭に置かない', () => {
  const lines = wrapJa('寮費0円で今月から月給30万円〜', 8);
  assert.ok(lines.every((l) => textUnits(l) <= 9), JSON.stringify(lines));
  const kinsoku = wrapJa('あいうえおかきく。けこ', 8);
  assert.ok(!kinsoku.some((l) => l.startsWith('。')), JSON.stringify(kinsoku));
});

test('wrapJa: 読点が後半にあればそこで切る', () => {
  assert.deepEqual(wrapJa('寮費0円で、今月から月給30万円', 10), ['寮費0円で、', '今月から月給30万円']);
});

test('wrapJa: 行数を超えたら末尾を省略', () => {
  const lines = wrapJa('あ'.repeat(40), 5, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
});

test('fitFont: 収まる最大サイズを選ぶ', () => {
  const short = fitFont('短い', 1000, 2, 100, 40);
  const long = fitFont('とても長いコピーがここに入ると小さくなるはずです', 1000, 2, 100, 40);
  assert.equal(short.size, 100);
  assert.ok(long.size < 100 && long.lines.length <= 2);
});

test('buildMjPrompt: 比率パラメータを付け直す', () => {
  assert.equal(buildMjPrompt('factory worker --ar 1:1 --v 6', '4:5', '--v 7'), 'factory worker --ar 4:5 --v 7');
  assert.match(buildMjPrompt('x', '1.91:1', ''), /--ar 191:100/);
});

test('composeImage: 全比率を正しいサイズで書き出す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adops-'));
  const r = await new MockProvider().generate({ creativeId: 't', prompt: 'x', ratio: '4:5', outDir: dir });
  assert.equal(r.status, 'done');
  const base = r.status === 'done' ? r.paths[0] : '';
  for (const [ratio, w, h] of [['4:5', 1080, 1350], ['1:1', 1080, 1080], ['9:16', 1080, 1920], ['1.91:1', 1200, 628]] as const) {
    const out = join(dir, `o_${w}x${h}.jpg`);
    await composeImage(base, out, ratio, brief(), job(), brand());
    const m = await sharp(out).metadata();
    assert.deepEqual([m.width, m.height], [w, h]);
  }
});

test('HandoffProvider: 画像が置かれるまで pending、置かれたら取り込む', async () => {
  const inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const p = new HandoffProvider(new LocalInbox(inbox));
  const req = { creativeId: 'cr_x_4x5', prompt: 'worker, no text', ratio: '4:5' as const, outDir: out };
  const first = await p.generate(req);
  assert.equal(first.status, 'pending');
  assert.ok(existsSync(join(inbox, 'cr_x_4x5', 'PROMPT.txt')));
  mkdirSync(join(inbox, 'cr_x_4x5'), { recursive: true });
  writeFileSync(join(inbox, 'cr_x_4x5', 'a.png'), await sharp({ create: { width: 64, height: 80, channels: 3, background: '#888' } }).png().toBuffer());
  const second = await p.poll(req, 'cr_x_4x5');
  assert.equal(second.status, 'done');
  assert.ok(existsSync(join(inbox, 'cr_x_4x5.imported')));
  // 素材が消えた後の再制作では、取り込み済みの画像をもう一度使える
  assert.equal((await p.poll(req, 'cr_x_4x5')).status, 'done');
  // 画像審査で全滅したら破棄して、新しい画像を待つ（同じ画像を再び取り込まない）
  await p.discard(req.creativeId);
  assert.ok(readdirSync(inbox).some((f) => f.startsWith('cr_x_4x5.rejected-')));
  assert.equal((await p.generate(req)).status, 'pending');
  writeFileSync(join(inbox, 'cr_x_4x5', 'b.png'), await sharp({ create: { width: 64, height: 80, channels: 3, background: '#444' } }).png().toBuffer());
  assert.equal((await p.poll(req, 'cr_x_4x5')).status, 'done');
});

test('signJwt: サービスアカウント鍵で検証できる RS256 署名を作る', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = signJwt({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, 'scope-x', 1000);
  const [h, c, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).scope, 'scope-x');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('googleTexts: 見出し・説明文が Google の上限内', () => {
  const t = googleTexts(brief({ headline: 'とても長い見出しなので全角十五文字を超えてしまう' }), job());
  assert.ok(t.headlines.length >= 2);
  assert.ok(t.headlines.every((h) => googleWidth(h) <= 30), JSON.stringify(t.headlines));
  assert.ok(t.descriptions.every((d) => googleWidth(d) <= 90));
  assert.equal(new Set(t.headlines).size, t.headlines.length);
});

test('fitGoogle: 収まる候補を優先し、無ければ切り詰める', () => {
  assert.equal(fitGoogle(['あ'.repeat(20), '短い'], 30), '短い');
  assert.equal(fitGoogle(['あ'.repeat(20)], 10), 'あああああ');
});

test('withUtm: 既存クエリを残して UTM を付ける', () => {
  const u = new URL(withUtm('https://example.com/jobs?id=3', 'meta', 'br_1'));
  assert.equal(u.searchParams.get('id'), '3');
  assert.equal(u.searchParams.get('utm_source'), 'meta');
  assert.equal(u.searchParams.get('utm_content'), 'br_1');
  const keep = new URL(withUtm('https://example.com/?utm_source=ig', 'meta', 'x'));
  assert.equal(keep.searchParams.get('utm_source'), 'ig');
});

test('approvalBlocks: プレビュー画像と承認ボタン（広告 ID 入り）を作る', async () => {
  const { approvalBlocks } = await import('../src/notify/approval.ts');
  const { creative } = await import('./fixtures.ts');
  const c = creative({ platformRefs: { meta: { adIds: ['a1'], creativeIds: [], previewUrl: 'https://cdn.example/x.jpg' }, google: { assetResourceNames: [], linkedTo: ['customers/1/adGroupAds/2~3', 'customers/1/assetGroupAssets/x'] } } });
  const blocks = approvalBlocks(c, brief(), job()) as any[];
  assert.equal(blocks[1].type, 'image');
  const actions = blocks.at(-1);
  assert.deepEqual(actions.elements.map((e: any) => e.action_id), ['adops_approve', 'adops_reject']);
  assert.deepEqual(JSON.parse(actions.elements[0].value), { c: 'cr_1', m: ['a1'], g: ['customers/1/adGroupAds/2~3'] });
});
