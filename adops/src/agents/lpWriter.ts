/**
 * 応募ページ（LP）の文章を書くエージェント。
 * 給与・勤務地・勤務時間などの事実はページ側で求人情報からそのまま表示するので、
 * このエージェントは「ペルソナの不安に答え、応募したくなる」文章だけを書く（事実を作らない）。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import type { Hypothesis, Job, Persona, ReviewIssue } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';

export const LpCopySchema = z.object({
  heroTitle: z.string().describe('ファーストビューの大見出し（全角24字以内）。ペルソナが「自分のことだ」と思う一言'),
  heroSub: z.string().describe('大見出しの補足（全角40字以内）。仕事・場所・給与のどれかを具体的に'),
  heroBadges: z.array(z.string()).describe('バッジ（各10字以内、最大3つ。求人情報にある待遇だけ）'),
  empathyTitle: z.string().describe('共感パートの見出し（全角24字以内）'),
  empathyBody: z.string().describe('ペルソナの今の不満・不安に寄り添う文（120字以内）'),
  points: z
    .array(z.object({ title: z.string().describe('全角20字以内'), body: z.string().describe('80字以内。求人情報の事実にもとづく') }))
    .describe('この仕事を選ぶ理由（ちょうど3つ）'),
  faq: z
    .array(z.object({ q: z.string(), a: z.string().describe('求人情報で答えられないことは「面接・お問い合わせでご確認ください」と答える') }))
    .describe('ペルソナが応募前に気にする質問（3〜5個）'),
  ctaText: z.string().describe('応募ボタンの文言（全角14字以内。例: まずは話を聞いてみる）'),
  closing: z.string().describe('最後のひと押し（60字以内）'),
});
export type LpCopy = z.infer<typeof LpCopySchema>;

const SYSTEM = `あなたはブルーカラー求人の応募ページ（LP）を書くコピーライターです。スマホで広告から来た人が、不安を解消して応募できるページの文章を書きます。

- 読む人は指定のペルソナ。その人の言葉で、一番の不安に先に答える
- 給与・勤務地・勤務時間・休日・待遇の一覧はページに求人情報から自動で表示される。文章では事実を言い換えて使ってよいが、求人情報に無い待遇・数字・約束は絶対に書かない
- 年齢・性別を限定する表現、成果の保証、根拠のない No.1、「誰でも簡単」「絶対稼げる」などの誇張、閲覧者の経済状況などを断定する表現は禁止
- 社内の検証仮説が指定されていれば、その打ち出し方に沿って書く（仮説の検証になるように）
- やさしい言葉で、短い文で書く。専門用語は避ける`;

function describe(job: Job, persona: Persona, h?: Hypothesis): string {
  const s = job.salary;
  return `# 求人情報（ここに無い事実は書かない）
- 職種: ${job.title}（${job.category}）
- 勤務地: ${job.location}
- 雇用形態: ${job.employmentType}
- 給与: ${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}
- 待遇: ${job.perks.join(' / ')}
${job.hours ? `- 勤務時間: ${job.hours}\n` : ''}${job.holidays ? `- 休日: ${job.holidays}\n` : ''}${job.requirements ? `- 応募条件: ${job.requirements}\n` : ''}
# ペルソナ
${persona.name}: ${persona.summary}
- 動機: ${persona.motivations.join(' / ')}
- 不安: ${persona.pains.join(' / ')}
${persona.vocabulary?.use?.length ? `- 響く言葉: ${persona.vocabulary.use.join('、')}\n` : ''}${persona.vocabulary?.avoid?.length ? `- 避ける言葉: ${persona.vocabulary.avoid.join('、')}\n` : ''}${
    h ? `\n# 社内の検証仮説（この打ち出しに沿って書く）\n${h.title}: ${h.message}${h.avoid?.length ? `\n避ける: ${h.avoid.join('、')}` : ''}\n` : ''
  }`;
}

export async function writeLp(llm: Llm, job: Job, persona: Persona, catalog: Catalog, h?: Hypothesis, fix?: { copy: LpCopy; issues: ReviewIssue[] }): Promise<LpCopy> {
  const prompt = fix
    ? `${describe(job, persona, h)}
# 前回の文章（JSON）
${JSON.stringify(fix.copy, null, 2)}

# チェックで見つかった問題（すべて直す。良い部分は残す）
${fix.issues.map((i) => `- [${i.severity}] ${i.field}: ${i.problem} → ${i.suggestion}`).join('\n')}`
    : `${describe(job, persona, h)}
社名: ${catalog.brand.name} / トーン: ${catalog.brand.tone}
この求人の応募ページの文章を書いてください。`;
  return llm.structured({ agent: 'lpWriter', system: SYSTEM, prompt, schema: LpCopySchema });
}
