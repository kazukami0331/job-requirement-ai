/**
 * Google 検索広告の除外キーワード。クリックはあるのに応募がない検索語句のうち、求職者の検索ではないもの
 * （会社の評判・在宅ワーク・別職種・遠い地域など）を AI が見分け、auto モードでは広告グループの除外キーワード（完全一致）に入れる。
 * draft モードや DRY RUN では提案だけ（Slack・週次メモに出る）。
 */
import { z } from 'zod';
import type { Ctx } from './context.ts';
import { logger } from '../util/log.ts';
import { addDays } from '../util/id.ts';

const log = logger('negatives');
const MIN_CLICKS = 5;
const MAX_PER_GROUP = 10;

export const NegativeSchema = z.object({
  terms: z.array(z.object({ term: z.string(), exclude: z.boolean(), reason: z.string().describe('判断の理由（20字程度）') })),
});

const SYSTEM = `あなたはブルーカラー求人の検索広告の運用者です。検索語句の一覧から、「この求人に応募しうる求職者の検索ではない」ものだけを選びます。
- 除外するもの: 会社名＋評判/口コミ/やばい、在宅・内職、明らかに別の職種、遠く離れた地域、求人と無関係な情報検索（意味・読み方・資格の試験日など）
- 除外しないもの: 職種名・地域・待遇（寮・日払いなど）・未経験などの求職の検索。迷うものは除外しない（exclude: false）
- 年齢・性別・国籍などの属性を理由に除外しない`;

export async function excludeIrrelevantTerms(ctx: Ctx): Promise<string> {
  const google = ctx.google;
  if (!google) return '';
  const state = ctx.store.state;
  const negatives = (state.negatives ??= {});
  const auto = ctx.catalog.policy.autonomy === 'auto' && !ctx.dryRun;
  const notes: string[] = [];
  for (const job of ctx.catalog.jobs.filter((j) => j.active)) {
    for (const ag of job.placements.google?.searchAdGroupIds ?? []) {
      // 入れたものは再判定しない。提案だけのものは auto でなければ7日間、「求職者の検索」と判定したものは30日間は判定し直さない
      const weekAgo = addDays(ctx.today, -7);
      const monthAgo = addDays(ctx.today, -30);
      const done = new Set(
        (negatives[ag] ?? [])
          .filter((n) => n.applied || (n.keep ? n.addedOn > monthAgo : !auto && n.addedOn > weekAgo))
          .map((n) => n.term),
      );
      const terms = (await google.searchTerms(ag, 50)).filter((t) => t.clicks >= MIN_CLICKS && t.conversions === 0 && !done.has(t.term));
      if (terms.length === 0) continue;
      const out = await ctx.llm.structured({
        agent: 'negativeKeywords',
        tier: 'fast',
        system: SYSTEM,
        prompt: `# 求人\n- ${job.title}（${job.location} / ${job.category}）\n\n# クリックはあるが応募がない検索語句（直近30日）\n${terms.map((t) => `- 「${t.term}」 クリック ${t.clicks}`).join('\n')}`,
        schema: NegativeSchema,
      });
      const known = new Set(terms.map((t) => t.term));
      const picks = out.terms.filter((t) => t.exclude && known.has(t.term)).slice(0, MAX_PER_GROUP);
      const keeps = out.terms.filter((t) => !t.exclude && known.has(t.term));
      let applied = new Set<string>();
      if (auto && picks.length) {
        try {
          applied = new Set(await google.addNegativeKeywords(ag, picks.map((p) => p.term)));
        } catch (e) {
          log.warn(`除外キーワードの追加に失敗（${ag}）: ${(e as Error).message}`);
        }
      }
      const touched = new Set([...picks, ...keeps].map((p) => p.term));
      const list = (negatives[ag] ??= []).filter((n) => !touched.has(n.term));
      negatives[ag] = [
        ...list,
        ...picks.map((p) => ({ term: p.term, reason: p.reason, addedOn: ctx.today, applied: applied.has(p.term) })),
        ...keeps.map((p) => ({ term: p.term, reason: p.reason, addedOn: ctx.today, applied: false, keep: true })),
      ].slice(-500);
      if (picks.length === 0) continue;
      const done2 = picks.filter((p) => applied.has(p.term));
      const proposed = picks.filter((p) => !applied.has(p.term));
      if (done2.length) notes.push(`${job.id}: 除外 ${done2.map((p) => `「${p.term}」`).join(' ')}`);
      if (proposed.length) notes.push(`${job.id}: 除外の提案 ${proposed.map((p) => `「${p.term}」`).join(' ')}`);
    }
  }
  return notes.join(' / ');
}
