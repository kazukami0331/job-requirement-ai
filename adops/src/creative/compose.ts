/**
 * 生成画像に日本語コピーを合成する。
 * Midjourney は日本語を正しく描けないため、画像は「文字なしの情景」で作り、文字はここで載せる。
 */
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
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

/** 幅に収まる文字サイズ（全角換算の文字幅で割る）。 */
function fitSize(text: string, maxW: number, size: number): number {
  return Math.max(10, Math.min(size, Math.floor(maxW / Math.max(1, textUnits(text)))));
}

/**
 * 下端の小さな文字（勤務地・給与のフッターと、許可番号などの必須表記）。
 * 長くても幅に収まるよう縮め、必須表記はフッターの1行上に置いて重ならないようにする。
 */
function bottomLines(footer: string | undefined, mandatory: string | undefined, x: number, baseline: number, maxW: number, size: number, color: string): { svg: string; height: number } {
  const parts: string[] = [];
  let y = baseline;
  let height = 0;
  if (footer) {
    const fs = fitSize(footer, maxW, size);
    parts.push(textBlock([footer], x, y, fs, color, { weight: 500 }));
    y -= fs * 1.4;
    height += fs * 1.4;
  }
  if (mandatory) {
    const ms = fitSize(mandatory, maxW, Math.round(size * 0.8));
    parts.push(textBlock([mandatory], x, y, ms, color, { weight: 400 }));
    height += ms * 1.4;
  }
  return { svg: parts.join('\n'), height };
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
  const bottom = bottomLines(o.footer, brand.mandatoryText, pad, H - pad * 0.6, (wide ? boxW : W - pad * 2), footerSize, c.text);
  const footerH = bottom.height ? bottom.height + footerSize * 0.4 : 0;
  const bandH = mainH + subH + footerH + pad * 1.6;
  const bandY = H - bandH;

  // バッジ（上部の黄色いピル）
  const badgeSize = Math.round(W * (wide ? 0.026 : 0.036));
  const badges = badgesSvg(o.badges, pad, pad, badgeSize, brand, W - pad);

  const textX = pad;
  const mainY = bandY + pad * 0.8 + main.size * 0.95;
  const subY = mainY + mainH - main.size * 0.95 + sub.size * 1.2;

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
${bottom.svg}
</svg>`;
}

export type Layout = 'band' | 'card' | 'bold';
export const LAYOUTS: Layout[] = ['band', 'card', 'bold'];

function badgesSvg(badges: string[], x: number, y: number, size: number, brand: Brand, maxRight = Infinity): string {
  let bx = x;
  return badges
    .slice(0, 3)
    .map((b) => {
      const w = Math.round(textUnits(b) * size + size * 1.2);
      // 画面からはみ出すバッジは載せない（途中で切れた文字は誤解のもと）
      if (bx + w > maxRight) {
        bx = Infinity;
        return '';
      }
      const svg = `<rect x="${bx}" y="${y}" rx="${size * 0.9}" width="${w}" height="${size * 1.8}" fill="${brand.colors.accent}"/>
<text x="${bx + w / 2}" y="${y + size * 1.27}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="900" fill="${brand.colors.background}" text-anchor="middle">${escapeXml(b)}</text>`;
      bx += w + size * 0.5;
      return svg;
    })
    .join('\n');
}

/** カード型: 下部に白い角丸カードを置き、濃い色の文字で載せる（写真が明るくても読める）。 */
export function cardSvg(o: OverlayInput): string {
  const { width: W, height: H, brand } = o;
  const c = brand.colors;
  const pad = Math.round(W * 0.06);
  const wide = W / H > 1.5;
  const cardW = wide ? W * 0.56 : W - pad * 2;
  const inner = cardW - pad * 1.2;
  const main = fitFont(o.main, inner, 2, Math.round(W * (wide ? 0.055 : 0.085)), Math.round(W * (wide ? 0.03 : 0.042)));
  const sub = fitFont(o.sub, inner, 2, Math.round(main.size * 0.5), Math.round(W * 0.028));
  const footerSize = Math.round(W * (wide ? 0.02 : 0.028));
  const contentH = main.lines.length * main.size * 1.22 + (o.sub ? sub.lines.length * sub.size * 1.35 : 0) + (o.footer ? footerSize * 2 : 0);
  const cardH = contentH + pad * 1.4;
  const cardX = wide ? pad : pad;
  const cardY = H - cardH - pad;
  const badgeSize = Math.round(W * (wide ? 0.024 : 0.034));
  const tx = cardX + pad * 0.6;
  let y = cardY + pad * 0.7 + main.size * 0.95;
  const parts = [textBlock(main.lines, tx, y, main.size, c.background)];
  y += main.lines.length * main.size * 1.22 - main.size * 0.95 + sub.size * 1.15;
  if (o.sub) parts.push(textBlock(sub.lines, tx, y, sub.size, c.primary, { weight: 700, lineHeight: 1.35 }));
  // フッターはカードの幅に収まるよう文字を小さくする
  const footSize = o.footer ? fitSize(o.footer, inner, footerSize) : footerSize;
  if (o.footer) parts.push(textBlock([o.footer], tx, cardY + cardH - pad * 0.55, footSize, '#444444', { weight: 500 }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${Math.round(W * 0.03)}" fill="#ffffff" opacity="0.94"/>
<rect x="${cardX}" y="${cardY}" width="${Math.max(8, Math.round(W * 0.012))}" height="${cardH}" rx="4" fill="${c.accent}"/>
${badgesSvg(o.badges, cardX, cardY - badgeSize * 2.4, badgeSize, brand, W - pad)}
${parts.join('\n')}
${brand.mandatoryText ? textBlock([brand.mandatoryText], W - pad, H - pad * 0.35, fitSize(brand.mandatoryText, W - pad * 2, Math.round(footerSize * 0.8)), c.text, { weight: 400, anchor: 'end' }) : ''}
</svg>`;
}

/** 給与ドン型: 給与額を画面上部に大きく出し、コピーは下部に。給与訴求・活用枠で強い。 */
export function boldSvg(o: OverlayInput & { pay: string }): string {
  const { width: W, height: H, brand } = o;
  const c = brand.colors;
  const pad = Math.round(W * 0.06);
  const wide = W / H > 1.5;
  // 給与は切らずに必ず全部見せる（収まるまで小さくする）
  const payBox = wide ? W * 0.55 : W - pad * 2;
  const paySize = Math.min(Math.round(W * (wide ? 0.08 : 0.13)), Math.floor(payBox / Math.max(1, textUnits(o.pay))));
  const payF = { size: paySize, lines: [o.pay] };
  const main = fitFont(o.main, wide ? W * 0.55 : W - pad * 2, 2, Math.round(W * (wide ? 0.045 : 0.07)), Math.round(W * 0.04));
  const topH = payF.size * 1.9 + pad;
  const footerSize = Math.round(W * (wide ? 0.02 : 0.028));
  const bottom = bottomLines(o.footer, brand.mandatoryText, pad, H - pad * 0.5, wide ? W * 0.55 : W - pad * 2, footerSize, c.text);
  const mainH = main.lines.length * main.size * 1.25 + pad * 1.3 + Math.max(0, bottom.height - footerSize * 1.4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
  <linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.background}" stop-opacity="0.92"/><stop offset="1" stop-color="${c.background}" stop-opacity="0"/></linearGradient>
  <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.background}" stop-opacity="0"/><stop offset="0.35" stop-color="${c.background}" stop-opacity="0.88"/></linearGradient>
</defs>
<rect x="0" y="0" width="${W}" height="${topH * 1.35}" fill="url(#top)"/>
${textBlock(payF.lines, pad, pad + payF.size * 0.95, payF.size, c.accent, { stroke: c.background, strokeW: payF.size * 0.06 })}
${badgesSvg(o.badges, pad, pad + payF.size * 1.25, Math.round(W * (wide ? 0.024 : 0.032)), brand, W - pad)}
<rect x="0" y="${H - mainH - pad}" width="${W}" height="${mainH + pad}" fill="url(#bot)"/>
${textBlock(main.lines, pad, H - mainH + main.size * 0.6, main.size, c.text, { stroke: c.background, strokeW: main.size * 0.06, lineHeight: 1.25 })}
${bottom.svg}
</svg>`;
}

export function payLine(job: Job): string {
  const s = job.salary;
  return `${s.type}${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}`;
}

export function footerLine(job: Job): string {
  const s = job.salary;
  return `${job.location}｜${s.type}${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}｜${job.employmentType}`;
}

/** 元画像を指定比率でトリミングし、コピーを合成して保存する。 */
export async function composeImage(
  basePath: string,
  outPath: string,
  ratio: Ratio,
  brief: CreativeBrief,
  job: Job,
  brand: Brand,
  layout: Layout = 'band',
): Promise<{ width: number; height: number }> {
  const [W, H] = RATIO_PX[ratio];
  const input: OverlayInput = { width: W, height: H, main: brief.overlay.main, sub: brief.overlay.sub, badges: brief.overlay.badges, brand, footer: footerLine(job) };
  const overlay =
    layout === 'card'
      ? cardSvg(input)
      : layout === 'bold'
        ? boldSvg({ ...input, pay: payLine(job), footer: `${job.location}｜${job.employmentType}` })
        : overlaySvg(input);
  const layers: OverlayOptions[] = [{ input: Buffer.from(overlay), top: 0, left: 0 }];
  if (brand.logoPath) {
    const logo = await sharp(brand.logoPath).resize({ width: Math.round(W * 0.18) }).png().toBuffer();
    layers.push({ input: logo, gravity: 'northeast' });
  }
  await (await fittedBackground(basePath, W, H))
    .composite(layers)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outPath);
  return { width: W, height: H };
}

/**
 * 元画像を W×H に合わせる。比率が近ければ注目領域を残してトリミング、
 * 縦長の元画像から横長を作るときは、ぼかした背景の右側に元画像を収める（人物が切れないように）。
 */
export async function fittedBackground(basePath: string, W: number, H: number): Promise<Sharp> {
  const meta = await sharp(basePath).metadata();
  const srcAspect = (meta.width ?? 1) / (meta.height ?? 1);
  const dstAspect = W / H;
  if (dstAspect / srcAspect < 1.6) return sharp(basePath).resize(W, H, { fit: 'cover', position: 'attention' });
  const bg = await sharp(basePath).resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.7 }).toBuffer();
  const fg = await sharp(basePath).resize({ height: H, width: Math.round(W * 0.45), fit: 'cover', position: 'attention' }).toBuffer();
  return sharp(await sharp(bg).composite([{ input: fg, top: 0, left: W - Math.round(W * 0.45) }]).png().toBuffer());
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
