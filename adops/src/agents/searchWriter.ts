/**
 * 検索広告（レスポンシブ検索広告）のコピーを作るエージェント。
 * 検索する人は「仕事を探している最中」なので、SNS 広告と違い、検索語に答える具体的な条件を並べる。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import type { Job } from '../types.ts';
import { checkTexts, formatYen, googleWidth } from '../compliance/rules.ts';

export const RsaSchema = z.object({
  headlines: z.array(z.string()).describe('見出し15本（各 全角15字/半角30字以内）'),
  descriptions: z.array(z.string()).describe('説明文4本（各 全角45字/半角90字以内）'),
  path1: z.string().describe('表示URLのパス1（全角7字/半角15字以内。例: 製造求人）'),
  path2: z.string().describe('表示URLのパス2（全角7字/半角15字以内。例: 寮付き）'),
});

const SYSTEM = `あなたはブルーカラー求人に強い Google 検索広告の運用者です。レスポンシブ検索広告の見出しと説明文を作ります。

- 検索している人は「工場 求人 寮付き」「ドライバー 求人 日勤」のように具体的な条件で探している。その条件に一言で答える
- 見出しは15本、すべて違う切り口で: 職種名 / 勤務地 / 給与 / 雇用形態 / 主な待遇（1本に1つ）/ 未経験可否 / 応募の手軽さ / 行動喚起
- 見出しは1本で意味が通じること（Google が組み合わせて表示する）。同じ語の繰り返しは避ける
- 文字数: 見出しは全角15字（半角30字）以内、説明文は全角45字（半角90字）以内。超えたものは使えない
- 給与・待遇は求人情報の事実だけ。年齢・性別の限定、成果保証、根拠のない No.1、閲覧者の状況を断定する表現は禁止
- 記号の多用・！の連続は Google の審査で不承認になりやすいので避ける`;

export interface SearchTerm {
  term: string;
  clicks: number;
  conversions: number;
  impressions: number;
}

export async function writeRsa(
  llm: Llm,
  job: Job,
  catalog: Catalog,
  avoid: string[] = [],
  terms: SearchTerm[] = [],
): Promise<{ headlines: string[]; descriptions: string[]; path1: string; path2: string; dropped: string[] }> {
  const s = job.salary;
  const out = await llm.structured({
    agent: 'searchWriter',
    tier: 'fast',
    system: SYSTEM,
    prompt: `# 求人情報
- 職種: ${job.title}（${job.category}）
- 勤務地: ${job.location}
- 雇用形態: ${job.employmentType}
- 給与: ${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}
- 待遇: ${job.perks.join(' / ')}
${job.hours ? `- 勤務時間: ${job.hours}` : ''}
${job.holidays ? `- 休日: ${job.holidays}` : ''}
${job.requirements ? `- 応募条件: ${job.requirements}` : ''}

${avoid.length ? `# 既存の広告で使っている見出し（今回は別の言い回しで挑戦する）\n${avoid.map((h) => `- ${h}`).join('\n')}` : ''}

${
  terms.length
    ? `# 実際に検索された語句（直近30日・クリックの多い順）。応募につながった語句の言い回しを見出しに取り入れる（求人情報の事実に合うものだけ）\n${terms
        .map((t) => `- 「${t.term}」 クリック ${t.clicks}${t.conversions ? ` / 応募 ${t.conversions}` : ''}`)
        .join('\n')}`
    : ''
}`,
    schema: RsaSchema,
  });
  return sanitizeRsa(out, job, catalog);
}

/** 文字数超過・法令チェック不合格・重複を落とす。 */
export function sanitizeRsa(raw: z.infer<typeof RsaSchema>, job: Job, catalog: Catalog) {
  const dropped: string[] = [];
  const clean = (texts: string[], limit: number, kind: string) => {
    const seen = new Set<string>();
    return texts
      .map((t) => t.trim().replace(/[!！]{2,}/g, '！'))
      .filter((t) => {
        if (!t || seen.has(t)) return false;
        seen.add(t);
        if (googleWidth(t) > limit) {
          dropped.push(`${kind}（文字数超過）: ${t}`);
          return false;
        }
        const issues = checkTexts([[kind, t]], job, catalog.brand).filter((i) => i.severity !== 'minor');
        if (issues.length) {
          dropped.push(`${kind}（${issues[0].problem}）: ${t}`);
          return false;
        }
        return true;
      });
  };
  const fitPath = (p: string) => {
    let out = '';
    for (const ch of p.replace(/[\s/]/g, '')) {
      if (googleWidth(out + ch) > 15) break;
      out += ch;
    }
    return out;
  };
  return {
    headlines: clean(raw.headlines, 30, '見出し').slice(0, 15),
    descriptions: clean(raw.descriptions, 90, '説明文').slice(0, 4),
    path1: fitPath(raw.path1),
    path2: fitPath(raw.path2),
    dropped,
  };
}
