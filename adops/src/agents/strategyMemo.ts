/**
 * 週次の戦略メモ（毎週月曜）。日々の運用は自動で回るが、
 * 「媒体間の予算配分」「求人・ペルソナの追加」「目標単価の見直し」のような、人が決めるべきことを提案する。
 */
import { z } from 'zod';
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import type { State } from '../types.ts';
import { buildReport } from './analyst.ts';
import { totals, windowed } from '../optimize/stats.ts';
import { addDays } from '../util/id.ts';
import { formatYen } from '../compliance/rules.ts';

export const MemoSchema = z.object({
  headline: z.string().describe('今週の一言まとめ（40字以内）'),
  findings: z.array(z.string()).describe('4週間の傾向から分かったこと（3〜5個、数字つき）'),
  decisions: z
    .array(z.object({ topic: z.string(), recommendation: z.string(), why: z.string() }))
    .describe('人が判断すべきことと推奨（予算配分・求人の追加/停止・ペルソナ・目標単価・入稿先の追加など）'),
  experiments: z.array(z.string()).describe('来週 AI が試すべき実験（2〜4個）'),
});
export type Memo = z.infer<typeof MemoSchema> & { date: string };

const SYSTEM = `あなたはブルーカラー専門の人材紹介会社の集客責任者の参謀です。
広告の日々の運用（企画・制作・入稿・停止）は自動化されています。あなたの仕事は、4週間の結果を俯瞰して
「人が決めるべき経営判断」を、根拠となる数字とともに短く提案することです。

- 媒体（Meta / Google）間の予算配分、求人ごとの予算の寄せ方、目標応募単価の妥当性、
  新しく追加すべき求人・ペルソナ・入稿先、止めるべき求人、計測や LP の問題の疑いなどを扱う
- データが少ない場合は「判断を保留し、何が分かれば決められるか」を書く
- 推奨は具体的に（「Meta の豊田の広告セット日予算を 1.5 万円 → 2 万円」のように）
- 選考結果（面接・入社）があれば、応募数より入社を重視する`;

export function shouldWriteMemo(state: State, today: string): boolean {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // today は日本時間の日付
  if (weekday !== 1) return false;
  const last = state.memos?.at(-1);
  return !last || last.date < addDays(today, -6);
}

export async function writeMemo(llm: Llm, state: State, catalog: Catalog, today: string): Promise<Memo> {
  const creatives = Object.values(state.creatives);
  const from = addDays(today, -27);
  const byPlatform = (['meta', 'google'] as const)
    .map((p) => {
      const t = totals(creatives.flatMap((c) => windowed(c.metrics, from, today, p)));
      return `- ${p === 'meta' ? 'Meta' : 'Google（デマンドジェネレーション）'}: 費用 ${Math.round(t.spend).toLocaleString()}円 / 表示 ${t.impressions.toLocaleString()} / 応募 ${t.conversions} / 単価 ${t.cpa ? Math.round(t.cpa).toLocaleString() + '円' : '-'}`;
    })
    .join('\n');
  const search = Object.values(state.searchAds ?? {});
  const st = totals(search.flatMap((a) => windowed(a.metrics, from, today)));
  const organic = creatives.filter((c) => c.organic && c.organic.postedAt.slice(0, 10) >= from);
  const reach = organic.reduce((a, c) => a + (c.organic!.insights.at(-1)?.reach ?? 0), 0);
  const g = catalog.policy.guardrails;

  const out = await llm.structured({
    agent: 'strategyMemo',
    system: SYSTEM,
    prompt: `${buildReport(creatives, state.briefs, catalog, today, 28)}

## 媒体別（4週間）
${byPlatform}
- Google 検索広告: 費用 ${Math.round(st.spend).toLocaleString()}円 / クリック ${st.clicks} / 応募 ${st.conversions}（広告 ${search.length} 本）
- Instagram オーガニック: 投稿 ${organic.length} 件 / 合計リーチ ${reach.toLocaleString()}

## 現在の運用設定
- モード: ${catalog.policy.autonomy} / 1日の企画数: ${catalog.policy.briefsPerCycle} / 動画比率 ${catalog.policy.videoShare} / 探索率 ${catalog.policy.exploreShare}
- 目標応募単価: ${formatYen(g.targetCpa)} / 日予算の自動上限: ${formatYen(g.maxDailyBudget)}
- 求人: ${catalog.jobs.map((j) => `${j.id}（${j.title}・${j.location}・${j.active ? '稼働' : '停止'}）`).join(' / ')}
- ペルソナ: ${catalog.personas.map((p) => p.name).join(' / ')}

## 直近の AI 分析の学び
${(state.insights.at(-1)?.learnings ?? []).map((l) => `- ${l}`).join('\n') || '- なし'}

今週の戦略メモを書いてください。`,
    schema: MemoSchema,
  });
  return { date: today, ...out };
}

export function memoToSlack(m: Memo): string {
  return [
    `*週次戦略メモ ${m.date}* — ${m.headline}`,
    '',
    '*分かったこと*',
    ...m.findings.map((f) => `• ${f}`),
    '',
    '*判断してほしいこと*',
    ...m.decisions.map((d) => `• *${d.topic}*: ${d.recommendation}\n   _理由: ${d.why}_`),
    '',
    '*来週の実験*',
    ...m.experiments.map((e) => `• ${e}`),
  ].join('\n');
}
