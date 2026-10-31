/**
 * SNS 投稿エージェント。広告素材を Instagram のオーガニック投稿（フィード・リール）に転用するとき、
 * 広告コピーのままではなく「フォローして見続けたくなる」投稿文に書き直す。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import { LANGUAGE_LABEL, type CreativeBrief } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

export const CaptionSchema = z.object({
  caption: z.string().describe('本文（改行あり、300〜600字目安。最初の1行で止める）'),
  hashtags: z.array(z.string()).describe('ハッシュタグ（# 付き、5〜10個。職種・地域・働き方）'),
});

const SYSTEM = `あなたはブルーカラー求人に強い人材紹介会社の Instagram 運用担当です。
広告として作った素材を、オーガニック投稿（フィード・リール）として投稿するためのキャプションを書きます。

- 広告ではなく「役立つ・共感できる・保存したくなる」投稿にする。押し売りしない
- 1行目で止める（「寮費0円って実際どう？」のような問いかけや意外な事実）
- 中盤は現場のリアル・1日の流れ・よくある不安への答えなど、読む価値のある情報を短い段落で
- 最後に求人の要点（職種・勤務地・給与・主な待遇）と「プロフィールのリンクから詳細を見られます」
- 給与・待遇は求人情報にある事実だけ。年齢・性別の限定、成果の保証、根拠のない最上級表現、閲覧者の経済状況を断定する表現は禁止
- 絵文字は控えめ（各段落の頭に1つまで）`;

export async function writeCaption(llm: Llm, brief: CreativeBrief, catalog: Catalog, kind: 'feed' | 'reels' | 'carousel', baseHashtags: string[]): Promise<string> {
  const job = catalog.jobs.find((j) => j.id === brief.jobId)!;
  const persona = catalog.personas.find((p) => p.id === brief.personaId);
  const s = job.salary;
  const out = await llm.structured({
    agent: 'socialWriter',
    tier: 'fast',
    system: SYSTEM,
    prompt: `# 投稿の種類
${kind === 'reels' ? 'リール（縦動画）' : kind === 'carousel' ? 'カルーセル（複数枚の画像。1枚目で止めて、スワイプを促す）' : 'フィード（画像）'}

# 素材の内容（広告として作ったもの）
- フック: ${brief.hook}
- 画像の文字: ${brief.overlay.main} / ${brief.overlay.sub}
- 広告本文: ${brief.primaryText}

# 求人情報
- 職種: ${job.title}（${job.location} / ${job.employmentType}）
- 給与: ${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}
- 待遇: ${job.perks.join(' / ')}
${job.holidays ? `- 休日: ${job.holidays}` : ''}

# 届けたい人
${persona ? `${persona.name}: ${persona.summary}` : '求職中・転職検討中の方'}${
      brief.language && brief.language !== 'ja'
        ? `\n\n# 言語\nキャプションは${LANGUAGE_LABEL[brief.language] ?? brief.language}で書き、そのあとに「【日本語】」として同じ内容の正確な日本語訳を併記する。金額は「300,000円」のように数字＋「円」で書く。`
        : ''
    }`,
    schema: CaptionSchema,
  });
  const tags = [...new Set([...out.hashtags, ...baseHashtags].map((t) => (t.startsWith('#') ? t : `#${t}`).replace(/\s+/g, '')))].slice(0, 15);
  // Instagram のキャプション上限は 2,200 字
  return `${out.caption.trim()}\n\n${tags.join(' ')}`.slice(0, 2200);
}
