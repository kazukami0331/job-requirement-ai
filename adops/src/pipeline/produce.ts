/**
 * 段階5: 制作。画像生成 → 画像審査で1枚選ぶ → 文字合成（全比率）→ 動画化 → 完成品の最終チェック。
 * 1本失敗しても他の制作は続ける。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Ctx } from './context.ts';
import type { Asset, Creative, CreativeBrief, ImageJob, Ratio } from '../types.ts';
import { composeImage, LAYOUTS, RATIO_PX, type Layout } from '../creative/compose.ts';
import { chooseLayout } from '../optimize/allocate.ts';
import { buildVideo, reframeVideo, thumbnail } from '../creative/video.ts';
import { finalQa, pickBestImage } from '../agents/artJudge.ts';
import { createTts } from '../creative/tts.ts';
import { logger } from '../util/log.ts';

const log = logger('produce');

/** 画像広告: フィード用(4:5)と縦(9:16)の2本を生成。動画: 縦(9:16)の4候補をカットごとの背景に使う。 */
export function requiredRatios(c: Creative): Ratio[] {
  if (c.format === 'carousel') return ['1:1'];
  return c.format === 'image' ? ['4:5', '9:16'] : ['9:16'];
}

function imagePromptFor(brief: CreativeBrief, styleSuffix: string): string {
  const p = brief.imagePrompt.trim().replace(/[.。]\s*$/, '');
  return /no text/i.test(p) ? `${p}, ${styleSuffix}` : `${p}, ${styleSuffix}, no text, no letters, no logos`;
}

/** 画像生成の依頼・回収。全比率そろえば true。 */
async function ensureImages(ctx: Ctx, c: Creative, brief: CreativeBrief): Promise<boolean> {
  const outDir = ctx.store.assetDir(c.id);
  const prompt = imagePromptFor(brief, ctx.catalog.brand.visualStyle);
  for (const ratio of requiredRatios(c)) {
    let job = c.imageJobs.find((j) => j.ratio === ratio);
    // 前回の実行環境で生成したファイルが消えている（CI は毎回まっさら）場合は回収し直す
    if (job?.paths?.length && !job.paths.every((p) => existsSync(p))) {
      job.paths = undefined;
      job.selected = undefined;
      if (ctx.images.name !== job.provider) job.jobId = undefined;
    }
    if (job?.paths?.length) continue;
    const req = { creativeId: `${c.id}_${ratio.replace(':', 'x').replace('.', '')}`, prompt, ratio, outDir, requestedAt: job?.requestedAt };
    const r = job?.jobId ? await ctx.images.poll(req, job.jobId) : await ctx.images.generate(req);
    if (!job) {
      job = { ratio, provider: ctx.images.name, prompt, requestedAt: new Date().toISOString() } satisfies ImageJob;
      c.imageJobs.push(job);
    }
    if (r.status === 'done') {
      job.paths = r.paths;
      job.jobId = r.jobId ?? job.jobId;
    } else {
      job.jobId = r.jobId;
      if (r.note.startsWith('置き場所')) job.note = r.note;
      log.info(`${c.id} ${ratio}: 生成待ち（${r.note}）`);
    }
  }
  return requiredRatios(c).every((r) => c.imageJobs.find((j) => j.ratio === r)?.paths?.length);
}

async function selectImages(ctx: Ctx, c: Creative, brief: CreativeBrief): Promise<boolean> {
  for (const job of c.imageJobs) {
    if (job.selected !== undefined || !job.paths?.length) continue;
    if (job.paths.length === 1) {
      job.selected = 0;
      continue;
    }
    const pick = await pickBestImage(ctx.llm, brief, job.paths);
    log.info(`${c.id} ${job.ratio}: 候補${job.paths.length}枚から #${pick.selectedIndex} を選択（${pick.score}点）${pick.reason}`);
    if (pick.selectedIndex < 0) {
      // 全候補が使えない → 次回サイクルで作り直す
      const imageId = `${c.id}_${job.ratio.replace(':', 'x').replace('.', '')}`;
      await ctx.images.discard?.(imageId);
      job.paths = undefined;
      job.jobId = undefined;
      job.selected = undefined;
      return false;
    }
    job.selected = pick.selectedIndex;
  }
  return true;
}

export async function produceOne(ctx: Ctx, c: Creative): Promise<void> {
  const { store, catalog } = ctx;
  const brief = store.state.briefs[c.briefId];
  const job = catalog.jobs.find((j) => j.id === c.jobId);
  if (!brief || !job) {
    store.setStatus(c, 'failed', '企画または求人が見つかりません');
    return;
  }
  if (!job.active) {
    // 募集が終わった求人の制作待ちは、画像生成の費用をかけずに片付ける
    await Promise.all(c.imageJobs.map((j) => ctx.images.discard?.(`${c.id}_${j.ratio.replace(':', 'x').replace('.', '')}`)));
    store.setStatus(c, 'retired', '求人の募集が終了したため制作を中止');
    return;
  }
  if (!(await ensureImages(ctx, c, brief))) {
    store.setStatus(c, 'awaiting_images', '画像の生成待ち');
    return;
  }
  if (!(await selectImages(ctx, c, brief))) {
    store.setStatus(c, 'planned', '使える画像がなかったため再生成します');
    return;
  }

  const outDir = store.assetDir(c.id);
  const assets: Asset[] = [];
  // 文字レイアウトは反応の良いものを多めに選ぶ（画像広告とカルーセルだけ。一度決めたら作り直しでも変えない）。
  // 動画は Google 用の静止画にだけ使うので学習の対象にしない（帯で固定）
  if (c.format !== 'video') {
    // カルーセルのカードは「給与ドン」にしない（最後のまとめカードで給与を大きく出すため）
    c.layout ??= c.format === 'carousel' ? chooseLayout(['band', 'card'] as const, store.creatives(), ctx.today) : chooseLayout(LAYOUTS, store.creatives(), ctx.today);
  }
  const layout = (c.layout ?? 'band') as Layout;
  const pathOf = (ratio: Ratio) => {
    const j = c.imageJobs.find((x) => x.ratio === ratio)!;
    return j.paths![j.selected ?? 0];
  };

  if (c.format === 'carousel') {
    // カード: 4候補を順に背景に使い（選ばれた1枚を1枚目に）、最後に条件まとめのカードを付ける
    const j = c.imageJobs.find((x) => x.ratio === '1:1')!;
    const ordered = [j.paths![j.selected ?? 0], ...j.paths!.filter((_, i) => i !== (j.selected ?? 0))];
    const cards = brief.storyboard.slice(0, 5);
    const total = cards.length + 1;
    for (const [i, card] of cards.entries()) {
      const out = join(outDir, `${c.id}_card${i}.jpg`);
      const cardBrief = { ...brief, overlay: { main: card.text, sub: i === 0 ? `スワイプして見る →  ${i + 1}/${total}` : `${i + 1}/${total}`, badges: i === 0 ? brief.overlay.badges : [] } };
      const { width, height } = await composeImage(ordered[i % ordered.length], out, '1:1', cardBrief, job, catalog.brand, layout);
      assets.push({ ratio: '1:1', kind: 'image', path: out, width, height, card: i });
    }
    const last = join(outDir, `${c.id}_card${cards.length}.jpg`);
    const { width, height } = await composeImage(ordered[0], last, '1:1', brief, job, catalog.brand, 'bold');
    assets.push({ ratio: '1:1', kind: 'image', path: last, width, height, card: cards.length });
  } else if (c.format === 'image') {
    const plan: [Ratio, Ratio][] = [
      ['4:5', '4:5'],
      ['1:1', '4:5'],
      ['9:16', '9:16'],
      ['1.91:1', '4:5'],
    ];
    for (const [ratio, source] of plan) {
      const out = join(outDir, `${c.id}_${ratio.replace(':', 'x')}.jpg`);
      const { width, height } = await composeImage(pathOf(source), out, ratio, brief, job, catalog.brand, layout);
      assets.push({ ratio, kind: 'image', path: out, width, height });
    }
  } else {
    const vjob = c.imageJobs.find((x) => x.ratio === '9:16')!;
    // 選ばれた1枚を最初のカット（フック）に、残りを後続カットに使う
    const ordered = [vjob.paths![vjob.selected ?? 0], ...vjob.paths!.filter((_, i) => i !== (vjob.selected ?? 0))];
    if (vjob.clip === undefined && ctx.images.animate) {
      vjob.clip = await ctx.images
        .animate({ creativeId: c.id, prompt: vjob.prompt, ratio: '9:16', outDir, imagePath: ordered[0], motionPrompt: brief.storyboard[0]?.visual ?? brief.visualConcept })
        .catch((e) => {
          log.warn(`${c.id}: 動画クリップの生成に失敗（静止画で続行）: ${(e as Error).message}`);
          return null;
        });
    }
    const bgm = process.env.ADOPS_BGM_PATH;
    const vertical = join(outDir, `${c.id}_9x16.mp4`);
    const { durationSec } = await buildVideo({
      brief,
      job,
      brand: catalog.brand,
      images: ordered,
      clip: vjob.clip,
      workDir: join(outDir, 'video_work'),
      outPath: vertical,
      bgmPath: bgm && existsSync(bgm) ? bgm : undefined,
      tts: createTts(),
    });
    await thumbnail(vertical, vertical.replace(/\.mp4$/, '.jpg'), Math.min(1, durationSec / 4));
    assets.push({ ratio: '9:16', kind: 'video', path: vertical, width: 1080, height: 1920, durationSec });
    const feed = join(outDir, `${c.id}_4x5.mp4`);
    await reframeVideo(vertical, feed, ...RATIO_PX['4:5']);
    await thumbnail(feed, feed.replace(/\.mp4$/, '.jpg'), Math.min(1, durationSec / 4));
    assets.push({ ratio: '4:5', kind: 'video', path: feed, width: 1080, height: 1350, durationSec });
    // Google の P-MAX / デマンドジェネレーションの画像枠にも使えるよう、静止画版も作る
    for (const ratio of ['1:1', '1.91:1'] as Ratio[]) {
      const out = join(outDir, `${c.id}_${ratio.replace(':', 'x')}.jpg`);
      const { width, height } = await composeImage(ordered[0], out, ratio, brief, job, catalog.brand, layout);
      assets.push({ ratio, kind: 'image', path: out, width, height });
    }
  }

  // 完成品の最終チェック（画像は 4:5、動画はサムネイル、カルーセルは1枚目で）
  const main = assets.find((a) => a.ratio === '4:5') ?? assets[0];
  const qa = await finalQa(ctx.llm, brief, main.kind === 'video' ? main.path.replace(/\.mp4$/, '.jpg') : main.path);
  c.assets = assets;
  c.qa = { score: qa.score, notes: [qa.note, ...qa.problems].filter(Boolean).join(' / '), selectedIndex: c.imageJobs[0]?.selected ?? 0 };
  await sharp(main.kind === 'video' ? main.path.replace(/\.mp4$/, '.jpg') : main.path)
    .resize(360, 450, { fit: 'cover' })
    .jpeg({ quality: 70 })
    .toFile(store.thumbPath(c.id));
  if (!qa.pass) {
    store.setStatus(c, 'qa_failed', `最終チェック不合格: ${qa.problems.join(' / ')}`);
    log.warn(`${c.id}: 最終チェック不合格 ${qa.problems.join(' / ')}`);
    return;
  }
  store.setStatus(c, 'produced');
  log.info(`${c.id}: 制作完了（${assets.map((a) => `${a.ratio}${a.kind === 'video' ? '動画' : ''}`).join(', ')}）QA ${qa.score}点`);
}

export async function produce(ctx: Ctx, concurrency = 2): Promise<{ produced: number; waiting: number; failed: number }> {
  const queue = ctx.store.creatives({ status: ['planned', 'awaiting_images'] });
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const c = queue[i++];
      try {
        await produceOne(ctx, c);
      } catch (e) {
        ctx.store.setStatus(c, 'failed', (e as Error).message.slice(0, 500));
        log.error(`${c.id}: 制作に失敗 ${(e as Error).message}`);
      }
      ctx.store.save(); // 長時間の処理なので1本ごとに保存
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  const ids = new Set(queue.map((c) => c.id));
  const after = ctx.store.creatives().filter((c) => ids.has(c.id));
  return {
    produced: after.filter((c) => c.status === 'produced').length,
    waiting: after.filter((c) => c.status === 'awaiting_images' || c.status === 'planned').length,
    failed: after.filter((c) => c.status === 'failed' || c.status === 'qa_failed').length,
  };
}
