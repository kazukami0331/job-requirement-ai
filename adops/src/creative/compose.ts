/**
 * 生成画像に日本語コピーを合成する。
 * Midjourney は日本語を正しく描けないため、画像は「文字なしの情景」で作り、文字はここで載せる。
 */
import sharp, { type OverlayOptions } from 'sharp';
import type { Brand, CreativeBrief, Job, Ratio } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

export const RATIO_PX: Record<Ratio, [number, number]> = {
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '9:16': [1080, 1920],
  '1.91:1': [1200, 628],
};

export const FONT_FAMILY = `'Noto Sans CJK JP','Noto Sans JP','Hiragino Sans','WenQuanYi Zen Hei',sans-serif`;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 文字幅（全角=1, 半角=0.55）。 */
export function textUnits(s: string): number {
  let u = 0;
  for (const ch of s) u += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.55 : 1;
  return u;
}

const NO_LINE_START = new Set([...'、。，．・：；？！ー）」』】〕〉》’”ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ%）)]}']);

/**
 * 日本語の折り返し。1行の幅（全角換算）を超えたら改行し、句読点・小書き文字で行が始まらないようにする。
 * 明示的な改行（\n）はそのまま尊重する。
 */
export function wrapJa(text: string, maxUnits: number, maxLines = 3): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (textUnits(cur + ch) > maxUnits && cur) {
        if (NO_LINE_START.has(ch)) {
          // 禁則: 行頭に来る文字は前の行にぶら下げる
          cur += ch;
          continue;
        }
        // 読点・中黒・空白が行の後半にあれば、そこで切る（「今月か／ら」のような泣き別れを防ぐ）
        const cut = Math.max(cur.lastIndexOf('、'), cur.lastIndexOf('。'), cur.lastIndexOf('・'), cur.lastIndexOf(' '), cur.lastIndexOf('　'));
        if (cut >= 0 && cut + 1 >= [...cur].length * 0.5 && cut + 1 < cur.length) {
          lines.push(cur.slice(0, cut + 1).trim());
          cur = cur.slice(cut + 1).trimStart() + ch;
        } else {
          lines.push(cur);
          cur = ch;
        }
      } else cur += ch;
    }
    if (cur) lines.push(cur);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.$/, '…');
    return kept;
  }
  return lines;
}

/** 行数・幅に収まる最大のフォントサイズを探す。 */
export function fitFont(text: string, boxW: number, maxLines: number, maxSize: number, minSize: number): { size: number; lines: string[] } {
  for (let size = maxSize; size >= minSize; size -= 2) {
    const perLine = Math.floor(boxW / size);
    const lines = wrapJa(text, perLine, 99);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: minSize, lines: wrapJa(text, Math.floor(boxW / minSize), maxLines) };
}

function textBlock(lines: string[], x: number, y: number, size: number, fill: string, opts: { weight?: number; stroke?: string; strokeW?: number; anchor?: 'start' | 'middle' | 'end'; lineHeight?: number } = {}): string {
  const lh = opts.lineHeight ?? 1.22;
  return lines
    .map(
      (l, i) =>
        `<text x="${x}" y="${y + i * size * lh}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${opts.weight ?? 900}" fill="${fill}" text-anchor="${opts.anchor ?? 'start'}"${
          opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.strokeW ?? size * 0.08}" paint-order="stroke" stroke-linejoin="round"` : ''
        }>${escapeXml(l)}</text>`,
    )
    .join('\n');
}

export interface OverlayInput {
  width: number;
  height: number;
  main: string;
  sub: string;
  badges: string[];
  brand: Brand;
  /** 画面下部に小さく出す一行（給与・勤務地など） */
  footer?: string;
}

/** 静止画広告のオーバーレイ（透明 PNG を返す）。 */
export function overlaySvg(o: OverlayInput): string {
  const { width: W, height: H, brand } = o;
  const c = brand.colors;
  const pad = Math.round(W * 0.06);
  const wide = W / H > 1.5;
  const boxW = wide ? W * 0.58 : W - pad * 2;

  const main = fitFont(o.main, boxW, 2, Math.round(W * (wide ? 0.06 : 0.095)), Math.round(W * 0.045));
  const sub = fitFont(o.sub, boxW, 2, Math.round(main.size * 0.5), Math.round(W * 0.03));
  const mainH = main.lines.length * main.size * 1.22;
  const subH = o.sub ? sub.lines.length * sub.size * 1.3 : 0;
  const footerSize = Math.round(W * (wide ? 0.022 : 0.03));
  const footerH = o.footer ? footerSize * 1.8 : 0;
  const bandH = mainH + subH + footerH + pad * 1.6;
  const bandY = H - bandH;

  // バッジ（上部の黄色いピル）
  let bx = pad;
  const by = pad;
  const badgeSize = Math.round(W * (wide ? 0.026 : 0.036));
  const badges = o.badges
    .slice(0, 3)
    .map((b) => {
      const w = Math.round(textUnits(b) * badgeSize + badgeSize * 1.2);
      const svg = `<rect x="${bx}" y="${by}" rx="${badgeSize * 0.9}" width="${w}" height="${badgeSize * 1.8}" fill="${c.accent}"/>
<text x="${bx + w / 2}" y="${by + badgeSize * 1.27}" font-family="${FONT_FAMILY}" font-size="${badgeSize}" font-weight="900" fill="${c.background}" text-anchor="middle">${escapeXml(b)}</text>`;
      bx += w + badgeSize * 0.5;
      return svg;
    })
    .join('\n');

  const textX = pad;
  const mainY = bandY + pad * 0.8 + main.size * 0.95;
  const subY = mainY + mainH - main.size * 0.95 + sub.size * 1.2;
  const footerY = H - pad * 0.6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
  <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${c.background}" stop-opacity="0"/>
    <stop offset="0.28" stop-color="${c.background}" stop-opacity="0.82"/>
    <stop offset="1" stop-color="${c.background}" stop-opacity="0.95"/>
  </linearGradient>
</defs>
<rect x="0" y="${bandY - pad}" width="${W}" height="${bandH + pad}" fill="url(#band)"/>
<rect x="${textX}" y="${bandY + pad * 0.35}" width="${Math.round(W * 0.12)}" height="${Math.max(6, Math.round(W * 0.008))}" fill="${c.accent}"/>
${badges}
${textBlock(main.lines, textX, mainY, main.size, c.text, { stroke: c.background, strokeW: main.size * 0.06 })}
${o.sub ? textBlock(sub.lines, textX, subY, sub.size, c.accent, { weight: 700, lineHeight: 1.3 }) : ''}
${o.footer ? textBlock([o.footer], textX, footerY, footerSize, c.text, { weight: 500 }) : ''}
${brand.mandatoryText ? textBlock([brand.mandatoryText], W - pad, footerY, Math.round(footerSize * 0.8), c.text, { weight: 400, anchor: 'end' }) : ''}
</svg>`;
}

export function footerLine(job: Job): string {
  const s = job.salary;
  return `${job.location}｜${s.type}${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}｜${job.employmentType}`;
}

/** 元画像を指定比率でトリミングし、コピーを合成して保存する。 */
export async function composeImage(basePath: string, outPath: string, ratio: Ratio, brief: CreativeBrief, job: Job, brand: Brand): Promise<{ width: number; height: number }> {
  const [W, H] = RATIO_PX[ratio];
  const overlay = overlaySvg({ width: W, height: H, main: brief.overlay.main, sub: brief.overlay.sub, badges: brief.overlay.badges, brand, footer: footerLine(job) });
  const layers: OverlayOptions[] = [{ input: Buffer.from(overlay), top: 0, left: 0 }];
  if (brand.logoPath) {
    const logo = await sharp(brand.logoPath).resize({ width: Math.round(W * 0.18) }).png().toBuffer();
    layers.push({ input: logo, gravity: 'northeast' });
  }
  await sharp(basePath)
    .resize(W, H, { fit: 'cover', position: 'attention' })
    .composite(layers)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outPath);
  return { width: W, height: H };
}

/** 動画の字幕（透明 PNG）。画面中央やや下に大きく出す。 */
export async function captionPng(text: string, W: number, H: number, brand: Brand, opts: { position?: 'center' | 'lower' } = {}): Promise<Buffer> {
  const pad = Math.round(W * 0.07);
  const f = fitFont(text, W - pad * 2, 3, Math.round(W * 0.095), Math.round(W * 0.055));
  const blockH = f.lines.length * f.size * 1.25;
  const top = opts.position === 'center' ? (H - blockH) / 2 : H * 0.62 - blockH / 2;
  const c = brand.colors;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="${pad * 0.5}" y="${top - f.size * 0.6}" width="${W - pad}" height="${blockH + f.size * 0.7}" rx="${f.size * 0.3}" fill="${c.background}" opacity="0.55"/>
${textBlock(f.lines, W / 2, top + f.size * 0.85, f.size, c.text, { anchor: 'middle', stroke: c.background, strokeW: f.size * 0.1, lineHeight: 1.25 })}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 動画の最後に出す求人情報カード（不透明 PNG）。 */
export async function endCardPng(brief: CreativeBrief, job: Job, brand: Brand, W: number, H: number): Promise<Buffer> {
  const c = brand.colors;
  const pad = Math.round(W * 0.08);
  const title = fitFont(job.title, W - pad * 2, 3, Math.round(W * 0.07), Math.round(W * 0.045));
  const s = job.salary;
  const salary = `${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}`;
  const salaryF = fitFont(salary, W - pad * 3, 1, Math.round(W * 0.09), Math.round(W * 0.05));
  const perks = job.perks.slice(0, 4);
  let y = H * 0.22;
  const parts: string[] = [];
  parts.push(textBlock([brand.name], W / 2, y, Math.round(W * 0.04), c.accent, { anchor: 'middle', weight: 700 }));
  y += W * 0.12;
  parts.push(textBlock(title.lines, W / 2, y, title.size, c.text, { anchor: 'middle' }));
  y += title.lines.length * title.size * 1.22 + W * 0.06;
  parts.push(`<rect x="${pad}" y="${y - salaryF.size}" width="${W - pad * 2}" height="${salaryF.size * 1.5}" rx="${salaryF.size * 0.3}" fill="${c.accent}"/>`);
  parts.push(textBlock(salaryF.lines, W / 2, y + salaryF.size * 0.25, salaryF.size, c.background, { anchor: 'middle' }));
  y += salaryF.size * 1.6;
  if (s.note) {
    parts.push(textBlock(wrapJa(s.note, Math.floor((W - pad * 2) / (W * 0.035)), 2), W / 2, y, Math.round(W * 0.035), c.text, { anchor: 'middle', weight: 500 }));
    y += W * 0.1;
  }
  const perkSize = Math.round(W * 0.045);
  for (const p of perks) {
    parts.push(textBlock([`✓ ${p}`], pad * 1.5, y, perkSize, c.text, { weight: 700 }));
    y += perkSize * 1.6;
  }
  parts.push(textBlock([job.location], W / 2, H * 0.84, Math.round(W * 0.04), c.text, { anchor: 'middle', weight: 500 }));
  parts.push(textBlock(['▼ 詳しい条件・応募はこちら'], W / 2, H * 0.9, Math.round(W * 0.05), c.accent, { anchor: 'middle' }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="${c.background}"/>
${parts.join('\n')}
${brand.mandatoryText ? textBlock([brand.mandatoryText], W / 2, H * 0.96, Math.round(W * 0.025), c.text, { anchor: 'middle', weight: 400 }) : ''}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
