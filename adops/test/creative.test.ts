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
  const v = JSON.parse(actions.elements[0].value);
  assert.deepEqual({ c: v.c, m: v.m, g: v.g }, { c: 'cr_1', m: ['a1'], g: ['customers/1/adGroupAds/2~3'] });
  assert.ok(v.e > Date.now() / 1000 + 47 * 3600);
  assert.match(v.s, /^[0-9a-f]{64}$/);
});

test('buildVideo: ナレーションに合わせてカットを伸ばし、音声を混ぜる', async () => {
  const { buildVideo, probeDuration } = await import('../src/creative/video.ts');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'adops-tts-'));
  const r = await new MockProvider().generate({ creativeId: 'v', prompt: 'x', ratio: '9:16', outDir: dir });
  const images = r.status === 'done' ? r.paths : [];
  // 文字数 × 0.25 秒のトーンを「読み上げ」とみなす偽 TTS
  const tts = {
    synthesize: async (text: string, path: string) => {
      const sec = Math.max(0.5, [...text].length * 0.25);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-ar', '44100', path]);
    },
  };
  const b = brief({
    format: 'video',
    storyboard: [
      { seconds: 2, text: '寮費0円って本当？', visual: '' },
      { seconds: 2, text: 'とても長いナレーションのカットはちゃんと伸びます', visual: '' },
    ],
  });
  const out = join(dir, 'out.mp4');
  const { durationSec } = await buildVideo({ brief: b, job: job(), brand: brand(), images, workDir: join(dir, 'w'), outPath: out, tts });
  // 2カット目は 24字 × 0.25 = 6秒 + 余白 → 2秒より長くなる
  assert.ok(durationSec > 2 + 2 + 3 + 3, `duration ${durationSec}`);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).toString().trim().split('\n');
  assert.deepEqual(streams.sort(), ['audio', 'video']);
  assert.ok(Math.abs((await probeDuration(out)) - durationSec) < 0.2);
});

test('FallbackProvider: 手渡しの画像が期限内に届かなければ代替で生成し、置き場所を片付ける', async () => {
  const { FallbackProvider } = await import('../src/creative/imageProvider.ts');
  const discarded: string[] = [];
  const primary = {
    name: 'handoff',
    generate: async () => ({ status: 'pending' as const, jobId: 'x', note: '置き場所: inbox/x/' }),
    poll: async () => ({ status: 'pending' as const, jobId: 'x', note: '画像待ち' }),
    discard: async (id: string) => void discarded.push(id),
  };
  const fallback = { name: 'gemini', generate: async () => ({ status: 'done' as const, paths: ['a.png'] }), poll: async () => ({ status: 'done' as const, paths: ['a.png'] }) };
  const p = new FallbackProvider(primary, fallback, 24);
  assert.equal(p.name, 'handoff');
  const base = { creativeId: 'x', prompt: 'p', ratio: '4:5' as const, outDir: '/tmp' };
  assert.equal((await p.poll({ ...base, requestedAt: new Date().toISOString() }, 'x')).status, 'pending');
  const late = await p.poll({ ...base, requestedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }, 'x');
  assert.equal(late.status, 'done');
  assert.deepEqual(discarded, ['x']);

  // 探索枠は最初から代替で（設定時のみ）。活用枠は従来どおり手渡し
  const q = new FallbackProvider(primary, fallback, 24, true);
  assert.equal((await q.generate({ ...base, lowPriority: true })).status, 'done');
  assert.equal((await q.generate({ ...base })).status, 'pending');
  assert.equal((await p.generate({ ...base, lowPriority: true })).status, 'pending');
});

test('i18n: 外国語のエンドカードは給与の種類を訳し、金額は「300,000円」の形にする', async () => {
  const { salaryLine, ctaText } = await import('../src/creative/i18n.ts');
  const { job } = await import('./fixtures.ts');
  assert.equal(salaryLine(job(), 'vi'), 'Lương tháng 300,000円 - 380,000円');
  assert.match(salaryLine(job(), 'ja'), /^月給 30万円〜38万円$/);
  assert.equal(ctaText('xx'), ctaText('en'));
});
