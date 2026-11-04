/**
 * 広告に付いたコメントの仕分け。質問（応募見込み）は早く答えたい、ネガティブは状況を把握したい、スパムは隠したい。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';

export const TriageSchema = z.object({
  items: z.array(
    z.object({
      index: z.number(),
      kind: z.enum(['question', 'negative', 'spam', 'positive', 'other']),
      summary: z.string().describe('担当者向けの一言（20字以内）'),
      suggestedReply: z.string().describe('question のときの返信案（求人情報にある事実だけ。分からなければ「DM でお答えします」）。それ以外は空文字'),
    }),
  ),
});

const SYSTEM = `あなたは求人広告のコメント欄の一次対応担当です。各コメントを次に分類します。
- question: 仕事内容・条件・寮・応募方法などへの質問（応募の見込みがある。最優先で人が返信したい）
- negative: 会社や仕事への批判・不安の表明・トラブルの訴え（人が状況を確認すべき）
- spam: 宣伝、詐欺の誘導、無関係なリンク、嫌がらせ、差別的な発言（非表示にしてよい）
- positive: 好意的・応援・タグ付けなど
- other: 上記以外
返信案は丁寧で短く。求人情報に無いことは断定せず「詳しくは DM でお答えします」とする。`;

export async function triageComments(llm: Llm, jobSummary: string, comments: string[]) {
  if (comments.length === 0) return [];
  const out = await llm.structured({
    agent: 'commentTriage',
    tier: 'fast',
    system: SYSTEM,
    prompt: `# 求人情報\n${jobSummary}\n\n# コメント\n${comments.map((c, i) => `[${i}] ${c.slice(0, 500)}`).join('\n')}`,
    schema: TriageSchema,
  });
  return out.items.filter((x) => x.index >= 0 && x.index < comments.length);
}
