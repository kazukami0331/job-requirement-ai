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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DriveInbox, LocalInbox, type Inbox } from './inbox.ts';
import sharp from 'sharp';
import { DEFAULT_MJ_PARAMS, type Settings } from '../config.ts';
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
  /** 最初に依頼した日時（手渡しの待ち時間の判定に使う） */
  requestedAt?: string;
  /** 探索枠など、人の手間をかけない画像でよいもの */
  lowPriority?: boolean;
}

export type GenerateResult =
  | { status: 'done'; paths: string[]; jobId?: string }
  | { status: 'pending'; jobId: string; note: string };

export interface ImageProvider {
  readonly name: string;
  /** 生成を依頼する。すぐ終わらない方式は pending を返し、次回 poll で回収する */
  generate(req: GenerateRequest): Promise<GenerateResult>;
  poll(req: GenerateRequest, jobId: string): Promise<GenerateResult>;
  /** 生成済みの画像を破棄して作り直せるようにする（手渡しモードで画像審査が全滅したとき） */
  discard?(creativeId: string): Promise<void>;
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
 * PiAPI 自体は Midjourney API の提供終了を告知している（2026年時点）ため、同じ形式の別サービスか、
 * この形に合わせた薄いプロキシを MJ_API_BASE_URL に指定して使う。
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

export class HandoffProvider implements ImageProvider {
  readonly name = 'handoff';
  readonly inbox: Inbox;
  private params: string;
  /** 人に伝える置き場所（Slack 通知で使う） */
  readonly locations = new Map<string, string>();

  constructor(inbox: Inbox, params = DEFAULT_MJ_PARAMS) {
    this.inbox = inbox;
    this.params = params;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const prompt = buildMjPrompt(req.prompt, req.ratio, this.params);
    const where = await this.inbox.prepare(
      req.creativeId,
      `${prompt}\n\n# midjourney.com で上のプロンプトを生成し、良い画像を1〜4枚このフォルダに保存してください。\n`,
    );
    this.locations.set(req.creativeId, where);
    const r = await this.poll(req, req.creativeId);
    return r.status === 'done' ? r : { status: 'pending', jobId: req.creativeId, note: `置き場所: ${where}` };
  }

  async poll(req: GenerateRequest, jobId: string): Promise<GenerateResult> {
    const images = await this.inbox.fetch(jobId);
    if (!images) return { status: 'pending', jobId, note: '画像待ち' };
    mkdirSync(req.outDir, { recursive: true });
    const paths: string[] = [];
    for (const [i, buf] of images.entries()) {
      const p = join(req.outDir, `${req.creativeId}_mj_${i}.png`);
      await sharp(buf).png().toFile(p);
      paths.push(p);
    }
    // 取り込んだら印を付ける（二重取り込み防止）
    await this.inbox.markImported(jobId);
    return { status: 'done', paths, jobId };
  }

  async discard(creativeId: string): Promise<void> {
    await this.inbox.discard(creativeId);
  }
}

// ---------------------------------------------------------------------------
// gemini（Google の画像生成モデル。公式 API なので完全自動にできる）
// ---------------------------------------------------------------------------

/** Gemini の画像モデルが受け付ける比率に寄せる（1.91:1 は 16:9 で作って合成時に切り出す）。 */
const GEMINI_RATIO: Record<Ratio, string> = { '1:1': '1:1', '4:5': '4:5', '9:16': '9:16', '1.91:1': '16:9' };

export class GeminiImageProvider implements ImageProvider {
  readonly name = 'gemini';
  private apiKey: string;
  private model: string;
  private count: number;

  constructor(apiKey: string, model = 'gemini-3.1-flash-image-preview', count = 2) {
    if (!apiKey) throw new Error('Gemini の画像生成には GEMINI_API_KEY が必要です');
    this.apiKey = apiKey;
    this.model = model;
    this.count = count;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    mkdirSync(req.outDir, { recursive: true });
    // Midjourney 用のパラメータ（--ar 等）は外し、文字を入れない指示を明示する
    const prompt = `${req.prompt.replace(/--\w+(\s+[^-\s][^\s]*)?/g, '').trim()}. Photorealistic photograph. Absolutely no text, letters, signs, logos or watermarks in the image.`;
    const one = async (i: number) => {
      const r = await requestJson<any>(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey },
        json: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: GEMINI_RATIO[req.ratio] } },
        },
        attempts: 2,
      });
      const part = (r.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
      if (!part) throw new Error(`Gemini が画像を返しませんでした: ${JSON.stringify(r).slice(0, 200)}`);
      const p = join(req.outDir, `${req.creativeId}_gm_${i}.png`);
      await sharp(Buffer.from(part.inlineData.data, 'base64')).png().toFile(p);
      return p;
    };
    const settled = await Promise.allSettled(Array.from({ length: this.count }, (_, i) => one(i)));
    const paths = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (paths.length === 0) throw new Error((settled[0] as PromiseRejectedResult).reason?.message ?? 'Gemini の画像生成に失敗');
    return { status: 'done', paths };
  }

  async poll(req: GenerateRequest): Promise<GenerateResult> {
    return this.generate(req);
  }
}

/**
 * 手渡し（Midjourney）を優先し、一定時間内に画像が置かれなければ別の生成元で自動生成する。
 * 人が忙しい日も止まらずに回り続けるための構成。
 */
export class FallbackProvider implements ImageProvider {
  readonly name: string;
  private primary: ImageProvider;
  private fallback: ImageProvider;
  private afterMs: number;

  private fallbackFirstForLow: boolean;

  constructor(primary: ImageProvider, fallback: ImageProvider, afterHours: number, fallbackFirstForLow = false) {
    this.primary = primary;
    this.fallback = fallback;
    this.afterMs = afterHours * 3600_000;
    this.fallbackFirstForLow = fallbackFirstForLow;
    // 状態ファイル上は手渡しの依頼として扱う（素材の再取得の判定で生成元が変わったとみなさないように）
    this.name = primary.name;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // 探索枠は人に頼まず、最初から代替（Gemini）で作る（人の作業を勝ち筋の広告に集中させる）
    if (req.lowPriority && this.fallbackFirstForLow) {
      try {
        const r = await this.fallback.generate(req);
        if (r.status === 'done') return r;
      } catch (e) {
        log.warn(`${req.creativeId}: ${this.fallback.name} での生成に失敗したため手渡しにします: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return this.primary.generate(req);
  }

  async poll(req: GenerateRequest, jobId: string): Promise<GenerateResult> {
    const r = await this.primary.poll(req, jobId);
    if (r.status === 'done' || !req.requestedAt) return r;
    if (Date.now() - Date.parse(req.requestedAt) < this.afterMs) return r;
    log.info(`${req.creativeId}: 手渡しの画像が ${this.afterMs / 3600_000} 時間届かないため ${this.fallback.name} で生成します`);
    try {
      const fb = await this.fallback.generate(req);
      // 人が後から同じ依頼に取り組まないよう、置き場所を片付ける
      if (fb.status === 'done') await this.primary.discard?.(req.creativeId);
      return fb;
    } catch (e) {
      // 代替の失敗（上限・安全フィルタ・障害）で制作を失敗扱いにしない。次回また試し、その間も人の画像を待つ
      log.warn(`${req.creativeId}: ${this.fallback.name} での代替生成に失敗（次回再試行）: ${(e as Error).message.slice(0, 200)}`);
      return r;
    }
  }

  async discard(creativeId: string): Promise<void> {
    await this.primary.discard?.(creativeId);
  }
}

export function createImageProvider(s: Settings): ImageProvider {
  switch (s.image.provider) {
    case 'midjourney':
      return new MidjourneyProxyProvider(s.image.midjourney);
    case 'handoff': {
      const handoff = new HandoffProvider(
        s.image.inbox === 'drive' ? new DriveInbox(s.image.drive.serviceAccountJson, s.image.drive.folderId) : new LocalInbox(s.image.inboxDir),
        s.image.midjourney.params,
      );
      // 一定時間待っても画像が置かれなければ Gemini で代わりに作る（GEMINI_API_KEY があるときだけ）
      if (s.image.gemini.apiKey && s.image.fallbackAfterHours > 0) {
        return new FallbackProvider(
          handoff,
          new GeminiImageProvider(s.image.gemini.apiKey, s.image.gemini.model, s.image.gemini.count),
          s.image.fallbackAfterHours,
          // 探索枠は最初から Gemini で（Midjourney の手作業は活用枠だけに）
          process.env.IMAGE_EXPLORE_PROVIDER === 'gemini',
        );
      }
      return handoff;
    }
    case 'gemini':
      return new GeminiImageProvider(s.image.gemini.apiKey, s.image.gemini.model, s.image.gemini.count);
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`未知の IMAGE_PROVIDER: ${s.image.provider}`);
  }
}
