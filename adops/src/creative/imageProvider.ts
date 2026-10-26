/**
 * 画像（と短尺動画）の生成元。
 *
 * Midjourney には公式 API がありません（2026年時点）。そのため次の3方式を切り替えられるようにしています。
 * - midjourney: Midjourney を中継する外部 API（PiAPI 形式など）を使う完全自動。
 *               ※ 自動操作は Midjourney の利用規約に抵触し、アカウント停止のリスクがあります。導入前に必ず確認してください。
 * - handoff:    プロンプトを Slack/ファイルに出し、人が midjourney.com で生成した画像を inbox フォルダに置く半自動。
 *               人の作業は「コピペして生成し、気に入った4枚を保存する」だけ。規約上もっとも安全。
 * - mock:       プレースホルダー画像を作る（API キーなしでの動作確認・テスト用）。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { Settings } from '../config.ts';
import type { Ratio } from '../types.ts';
import { request, requestJson, sleep } from '../util/http.ts';
import { logger } from '../util/log.ts';

const log = logger('image');

export interface GenerateRequest {
  /** 保存先とファイル名の接頭辞に使う */
  creativeId: string;
  prompt: string;
  ratio: Ratio;
  outDir: string;
}

export type GenerateResult =
  | { status: 'done'; paths: string[]; jobId?: string }
  | { status: 'pending'; jobId: string; note: string };

export interface ImageProvider {
  readonly name: string;
  /** 生成を依頼する。すぐ終わらない方式は pending を返し、次回 poll で回収する */
  generate(req: GenerateRequest): Promise<GenerateResult>;
  poll(req: GenerateRequest, jobId: string): Promise<GenerateResult>;
  /** 画像から短い動画を作る（対応していなければ null） */
  animate?(req: GenerateRequest & { imagePath: string; motionPrompt: string }): Promise<string | null>;
}

/** Midjourney 用の --ar 表記（1.91:1 は整数比にする）。 */
export function mjAspect(ratio: Ratio): string {
  return ratio === '1.91:1' ? '191:100' : ratio;
}

export function buildMjPrompt(prompt: string, ratio: Ratio, params: string): string {
  // プロンプト内に既に --ar などがあれば取り除き、システム側の値で統一する
  const clean = prompt.replace(/--\w+(\s+[^-\s][^\s]*)?/g, '').replace(/\s+/g, ' ').trim();
  return `${clean} --ar ${mjAspect(ratio)} ${params}`.trim();
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

const RATIO_SIZE: Record<Ratio, [number, number]> = {
  '1:1': [1024, 1024],
  '4:5': [1024, 1280],
  '9:16': [864, 1536],
  '1.91:1': [1528, 800],
};

export class MockProvider implements ImageProvider {
  readonly name = 'mock';
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const [w, h] = RATIO_SIZE[req.ratio];
    mkdirSync(req.outDir, { recursive: true });
    const palettes = [
      ['#1d3557', '#457b9d'],
      ['#264653', '#2a9d8f'],
      ['#3d405b', '#81b29a'],
      ['#22223b', '#9a8c98'],
    ];
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      const [a, b] = palettes[i];
      // 現場っぽいシルエット（地平線・建物・人）を描いた仮画像
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="${w * 0.08}" y="${h * 0.45}" width="${w * 0.35}" height="${h * 0.4}" fill="#000" opacity="0.25"/>
  <rect x="${w * 0.5}" y="${h * 0.35}" width="${w * 0.42}" height="${h * 0.5}" fill="#000" opacity="0.2"/>
  <circle cx="${w * 0.5}" cy="${h * 0.52}" r="${Math.min(w, h) * 0.06}" fill="#f4d35e" opacity="0.9"/>
  <rect x="${w * 0.44}" y="${h * 0.58}" width="${w * 0.12}" height="${h * 0.22}" rx="${w * 0.02}" fill="#f4a261" opacity="0.9"/>
  <rect y="${h * 0.85}" width="100%" height="${h * 0.15}" fill="#000" opacity="0.3"/>
</svg>`;
      const p = join(req.outDir, `${req.creativeId}_mj_${i}.png`);
      await sharp(Buffer.from(svg)).png().toFile(p);
      paths.push(p);
    }
    return { status: 'done', paths };
  }
  async poll(req: GenerateRequest): Promise<GenerateResult> {
    return this.generate(req);
  }
  async animate(): Promise<string | null> {
    return null; // 動画は video.ts が静止画から作る
  }
}

// ---------------------------------------------------------------------------
// midjourney（中継 API）
// ---------------------------------------------------------------------------

/**
 * PiAPI 形式の中継 API（POST /api/v1/task → GET /api/v1/task/{id}）。
 * 別のサービスを使う場合は flavor=generic にして、同じ形の薄いプロキシを用意してください。
 */
export class MidjourneyProxyProvider implements ImageProvider {
  readonly name = 'midjourney';
  private s: Settings['image']['midjourney'];
  constructor(s: Settings['image']['midjourney']) {
    if (!s.apiKey) throw new Error('IMAGE_PROVIDER=midjourney には MJ_API_KEY が必要です');
    this.s = s;
  }

  private headers() {
    return { 'x-api-key': this.s.apiKey, accept: 'application/json' };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const prompt = buildMjPrompt(req.prompt, req.ratio, this.s.params);
    const body = {
      model: 'midjourney',
      task_type: 'imagine',
      input: { prompt, aspect_ratio: mjAspect(req.ratio), process_mode: 'fast', skip_prompt_check: false },
    };
    const res = await requestJson<{ data?: { task_id?: string }; task_id?: string }>(`${this.s.baseUrl}/api/v1/task`, {
      method: 'POST',
      headers: this.headers(),
      json: body,
    });
    const jobId = res.data?.task_id ?? res.task_id;
    if (!jobId) throw new Error(`Midjourney 中継 API がタスク ID を返しませんでした: ${JSON.stringify(res).slice(0, 300)}`);
    log.info(`imagine 依頼 ${req.creativeId} task=${jobId}`);
    // 生成は通常 30〜90 秒。数分待って終わらなければ次回サイクルで回収する
    for (let i = 0; i < 24; i++) {
      await sleep(10_000);
      const r = await this.poll(req, jobId);
      if (r.status === 'done') return r;
    }
    return { status: 'pending', jobId, note: '生成に時間がかかっています。次回サイクルで回収します' };
  }

  async poll(req: GenerateRequest, jobId: string): Promise<GenerateResult> {
    const res = await requestJson<any>(`${this.s.baseUrl}/api/v1/task/${encodeURIComponent(jobId)}`, { headers: this.headers() });
    const data = res.data ?? res;
    const status = String(data.status ?? '').toLowerCase();
    if (status === 'failed') throw new Error(`Midjourney の生成に失敗: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
    if (status !== 'completed' && status !== 'success') return { status: 'pending', jobId, note: status };
    const out = data.output ?? {};
    const urls: string[] = out.image_urls?.length ? out.image_urls : out.temporary_image_urls?.length ? out.temporary_image_urls : out.image_url ? [out.image_url] : [];
    if (urls.length === 0) throw new Error('Midjourney の結果に画像 URL がありません');
    mkdirSync(req.outDir, { recursive: true });
    const paths: string[] = [];
    for (const [i, url] of urls.slice(0, 4).entries()) {
      const buf = Buffer.from(await (await request(url)).arrayBuffer());
      const p = join(req.outDir, `${req.creativeId}_mj_${i}.png`);
      await sharp(buf).png().toFile(p);
      paths.push(p);
    }
    // 4分割グリッド1枚だけ返す API の場合は分割する
    if (paths.length === 1) return { status: 'done', paths: await splitGrid(paths[0], req), jobId };
    return { status: 'done', paths, jobId };
  }

  async animate(req: GenerateRequest & { imagePath: string; motionPrompt: string }): Promise<string | null> {
    if (!this.s.videoEnabled) return null;
    // Midjourney の Video（画像→約5秒の動画）。中継 API が対応している場合のみ
    const res = await requestJson<any>(`${this.s.baseUrl}/api/v1/task`, {
      method: 'POST',
      headers: this.headers(),
      json: {
        model: 'midjourney',
        task_type: 'video',
        input: { prompt: `${req.motionPrompt} --motion low`, image_base64: (await sharp(req.imagePath).jpeg({ quality: 90 }).toBuffer()).toString('base64') },
      },
    });
    const jobId = res.data?.task_id ?? res.task_id;
    if (!jobId) return null;
    for (let i = 0; i < 36; i++) {
      await sleep(10_000);
      const r = await requestJson<any>(`${this.s.baseUrl}/api/v1/task/${encodeURIComponent(jobId)}`, { headers: this.headers() });
      const d = r.data ?? r;
      const st = String(d.status ?? '').toLowerCase();
      if (st === 'failed') return null;
      const url = d.output?.video_url ?? d.output?.video_urls?.[0];
      if ((st === 'completed' || st === 'success') && url) {
        const p = join(req.outDir, `${req.creativeId}_mjvideo.mp4`);
        writeFileSync(p, Buffer.from(await (await request(url)).arrayBuffer()));
        return p;
      }
    }
    return null;
  }
}

/** 2x2 グリッド画像を4枚に分割する。 */
async function splitGrid(path: string, req: GenerateRequest): Promise<string[]> {
  const meta = await sharp(path).metadata();
  const w = Math.floor((meta.width ?? 0) / 2);
  const h = Math.floor((meta.height ?? 0) / 2);
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = join(req.outDir, `${req.creativeId}_mj_${i}_split.png`);
    await sharp(path).extract({ left: (i % 2) * w, top: Math.floor(i / 2) * h, width: w, height: h }).png().toFile(p);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// handoff（人が midjourney.com で生成して inbox に置く）
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export class HandoffProvider implements ImageProvider {
  readonly name = 'handoff';
  private inbox: string;
  constructor(inboxDir: string) {
    this.inbox = inboxDir;
    mkdirSync(inboxDir, { recursive: true });
  }

  /** 人が画像を置くフォルダ: inbox/<creativeId>/ に 1〜4 枚 */
  folder(creativeId: string): string {
    return join(this.inbox, creativeId);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const dir = this.folder(req.creativeId);
    mkdirSync(dir, { recursive: true });
    const prompt = buildMjPrompt(req.prompt, req.ratio, '--v 7 --style raw');
    writeFileSync(join(dir, 'PROMPT.txt'), `${prompt}\n\n# midjourney.com で上のプロンプトを生成し、良い画像を1〜4枚このフォルダに保存してください。\n`);
    return this.poll(req, req.creativeId).then((r) =>
      r.status === 'done' ? r : { status: 'pending', jobId: req.creativeId, note: `プロンプト: ${prompt}` },
    );
  }

  async poll(req: GenerateRequest, jobId: string): Promise<GenerateResult> {
    // 取り込み済み（.imported）も見る: 実行環境が変わって制作し直すときに同じ画像を使うため
    const dir = [this.folder(jobId), `${this.folder(jobId)}.imported`].find((d) => existsSync(d));
    if (!dir) return { status: 'pending', jobId, note: 'フォルダなし' };
    const files = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
    if (files.length === 0) return { status: 'pending', jobId, note: '画像待ち' };
    mkdirSync(req.outDir, { recursive: true });
    const paths: string[] = [];
    for (const [i, f] of files.slice(0, 4).entries()) {
      const p = join(req.outDir, `${req.creativeId}_mj_${i}.png`);
      await sharp(join(dir, f)).png().toFile(p);
      paths.push(p);
    }
    // 取り込んだら印を付ける（二重取り込み防止）
    if (!dir.endsWith('.imported')) renameSync(dir, `${dir}.imported`);
    return { status: 'done', paths, jobId };
  }
}

export function createImageProvider(s: Settings): ImageProvider {
  switch (s.image.provider) {
    case 'midjourney':
      return new MidjourneyProxyProvider(s.image.midjourney);
    case 'handoff':
      return new HandoffProvider(s.image.inboxDir);
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`未知の IMAGE_PROVIDER: ${s.image.provider}`);
  }
}
