/**
 * 縦型動画（9:16、リール・ショート・ストーリーズ用）を ffmpeg で組み立てる。
 *
 * 構成: [カット1..n: 背景がゆっくりパン/ズーム + 字幕] → [求人情報のエンドカード]
 * 背景は Midjourney の静止画（カットごとに別候補を使う）か、Midjourney Video の短尺クリップ。
 * 無音だと媒体側で再生が不利になることがあるため、BGM が無い場合も無音トラックを入れる。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Brand, CreativeBrief, Job } from '../types.ts';
import { captionPng, endCardPng } from './compose.ts';

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const FPS = 30;

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 24 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`ffmpeg 失敗: ${(err.stderr || err.message).slice(0, 800)}`);
  }
}

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  return Number(stdout.trim()) || 0;
}

/** カットごとに動きを変える（単調にならないように）。 */
function motionFilter(index: number, seconds: number): string {
  const frames = Math.round(seconds * FPS);
  // 1.12倍に拡大した上で、時間に応じて切り出し位置を動かす
  const SW = Math.round(W * 1.12);
  const SH = Math.round(H * 1.12);
  const base = `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH}`;
  const p = `(n/${frames})`;
  const moves = [
    `crop=${W}:${H}:x='(iw-${W})*${p}':y='(ih-${H})/2'`, // 左→右
    `crop=${W}:${H}:x='(iw-${W})/2':y='(ih-${H})*(1-${p})'`, // 下→上
    `crop=${W}:${H}:x='(iw-${W})*(1-${p})':y='(ih-${H})/2'`, // 右→左
    `crop=${W}:${H}:x='(iw-${W})/2':y='(ih-${H})*${p}'`, // 上→下
  ];
  return `${base},${moves[index % moves.length]},setsar=1`;
}

export interface VideoInput {
  brief: CreativeBrief;
  job: Job;
  brand: Brand;
  /** 背景に使う静止画（カット数より少なければ使い回す） */
  images: string[];
  /** Midjourney Video などの動画クリップ（あれば1カット目の背景に使う） */
  clip?: string | null;
  workDir: string;
  outPath: string;
  bgmPath?: string;
  endCardSeconds?: number;
}

export async function buildVideo(input: VideoInput): Promise<{ path: string; durationSec: number }> {
  const { brief, job, brand, images, workDir } = input;
  if (images.length === 0) throw new Error('動画の背景画像がありません');
  mkdirSync(workDir, { recursive: true });

  const scenes = brief.storyboard.length
    ? brief.storyboard
    : [
        { seconds: 3, text: brief.hook, visual: '' },
        { seconds: 3, text: brief.overlay.main, visual: '' },
        { seconds: 3, text: brief.overlay.sub, visual: '' },
      ];

  const parts: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    const sec = Math.max(1.5, Math.min(6, scene.seconds));
    const cap = join(workDir, `cap_${i}.png`);
    writeFileSync(cap, await captionPng(scene.text, W, H, brand, { position: i === 0 ? 'center' : 'lower' }));
    const out = join(workDir, `scene_${i}.mp4`);
    const useClip = i === 0 && input.clip && existsSync(input.clip);
    const bgInput = useClip ? ['-stream_loop', '-1', '-t', String(sec), '-i', input.clip!] : ['-loop', '1', '-t', String(sec), '-framerate', String(FPS), '-i', images[i % images.length]];
    const bgFilter = useClip ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}` : motionFilter(i, sec);
    await ffmpeg([
      ...bgInput,
      '-loop', '1', '-t', String(sec), '-framerate', String(FPS), '-i', cap,
      '-filter_complex',
      `[0:v]${bgFilter}[bg];[bg][1:v]overlay=0:0,fade=t=in:st=0:d=0.2,format=yuv420p[v]`,
      '-map', '[v]', '-r', String(FPS), '-t', String(sec),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-an', out,
    ]);
    parts.push(out);
  }

  // エンドカード
  const endSec = input.endCardSeconds ?? 3;
  const endPng = join(workDir, 'endcard.png');
  writeFileSync(endPng, await endCardPng(brief, job, brand, W, H));
  const endMp4 = join(workDir, 'scene_end.mp4');
  await ffmpeg([
    '-loop', '1', '-t', String(endSec), '-framerate', String(FPS), '-i', endPng,
    '-vf', `scale=${W}:${H},setsar=1,fade=t=in:st=0:d=0.25,format=yuv420p`,
    '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-an', endMp4,
  ]);
  parts.push(endMp4);

  // 連結 + 音声トラック
  const list = join(workDir, 'concat.txt');
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = join(workDir, 'joined.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const duration = await probeDuration(joined);
  const audio = input.bgmPath && existsSync(input.bgmPath)
    ? ['-stream_loop', '-1', '-i', input.bgmPath]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
  await ffmpeg([
    '-i', joined, ...audio,
    '-map', '0:v', '-map', '1:a', '-t', duration.toFixed(2),
    '-af', `afade=t=out:st=${Math.max(0, duration - 1).toFixed(2)}:d=1,volume=0.6`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', input.outPath,
  ]);
  return { path: input.outPath, durationSec: Math.round(duration * 10) / 10 };
}

/** 1:1 / 4:5 のフィード面用に、縦動画をぼかし背景つきで別比率に変換する。 */
export async function reframeVideo(src: string, out: string, w: number, h: number): Promise<void> {
  await ffmpeg([
    '-i', src,
    '-filter_complex',
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg];[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', '-movflags', '+faststart', out,
  ]);
}

/** 動画のサムネイル（Meta の動画広告に必須）。最初のカットの中央フレーム。 */
export async function thumbnail(src: string, out: string, atSec = 1): Promise<void> {
  await ffmpeg(['-ss', String(atSec), '-i', src, '-frames:v', '1', '-q:v', '3', out]);
}
