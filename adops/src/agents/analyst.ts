/**
 * 分析エージェント。数字の集計はコードで済ませ、AI には「なぜそうなったか」と
 * 「次の企画に使える学び」を言語化させる。学びは次サイクルの企画プロンプトに入る。
 */
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import { ANGLE_LABELS, type Angle, type Creative, type CreativeBrief, type Insight } from '../types.ts';
import { groupBy, totals, windowed, type GroupRow } from '../optimize/stats.ts';
import { addDays } from '../util/id.ts';
import { InsightSchema } from './schemas.ts';

const ANALYST_SYSTEM = `あなたは求人広告の運用アナリストです。ブルーカラー職の求職者向け SNS 広告の配信結果から、
次の広告企画にそのまま使える学びを引き出します。

- 数字の大小を並べるのではなく、「どんな訴求・表現が、どのペルソナの応募につながったか」を言語化する
- 表示回数が少ない（目安 1000 未満）結果は偶然の可能性が高い。断定せず「要検証」と書く
- CTR が高くても応募単価が悪いものは「釣り」になっている可能性を指摘する
- learnings は「〜という訴求は〜に効く」「〜という表現は効かない」の形で、次の企画者がそのまま使える文にする
- nextActions は具体的な次の実験（例: 寮×動画で、部屋の内見を最初の1秒に）を3〜5個`;

function fmtRow(r: GroupRow, label: (k: string) => string): string {
  const t = r.totals;
  return `| ${label(r.key)} | ${r.count} | ${t.impressions.toLocaleString()} | ${t.ctr.toFixed(2)}% | ${t.cpc ? Math.round(t.cpc) : '-'} | ${t.conversions} | ${t.cpa ? Math.round(t.cpa).toLocaleString() : '-'} |`;
}

const HEADER = '| 区分 | 本数 | 表示 | CTR | CPC(円) | 応募 | 応募単価(円) |\n|---|---|---|---|---|---|---|';

export function buildReport(creatives: Creative[], briefs: Record<string, CreativeBrief>, catalog: Catalog, today: string, days = 7): string {
  const from = addDays(today, -(days - 1));
  const withData = creatives.filter((c) => windowed(c.metrics, from, today).length > 0);
  const personaName = (id: string) => catalog.personas.find((p) => p.id === id)?.name ?? id;
  const jobName = (id: string) => catalog.jobs.find((j) => j.id === id)?.title ?? id;

  const ranked = withData
    .map((c) => ({ c, t: totals(windowed(c.metrics, from, today)), b: briefs[c.briefId] }))
    .filter((x) => x.t.impressions > 0)
    .sort((a, b) => (a.t.cpa ?? Infinity) - (b.t.cpa ?? Infinity) || b.t.ctr - a.t.ctr);
  const line = (x: (typeof ranked)[number]) =>
    `- [${ANGLE_LABELS[x.c.angle]} / ${x.c.format === 'video' ? '動画' : '画像'} / ${personaName(x.c.personaId)}] 「${x.b?.overlay.main ?? '?'}」 見出し「${x.b?.headline ?? '?'}」 → 表示 ${x.t.impressions.toLocaleString()}, CTR ${x.t.ctr.toFixed(2)}%, 応募 ${x.t.conversions}${x.t.cpa ? `, 単価 ${Math.round(x.t.cpa).toLocaleString()}円` : ''}`;

  return `# 期間: ${from} 〜 ${today}（${days}日間）
全体: ${(() => {
    const t = totals(withData.flatMap((c) => windowed(c.metrics, from, today)));
    return `表示 ${t.impressions.toLocaleString()} / クリック ${t.clicks.toLocaleString()} / CTR ${t.ctr.toFixed(2)}% / 費用 ${Math.round(t.spend).toLocaleString()}円 / 応募 ${t.conversions} / 応募単価 ${t.cpa ? Math.round(t.cpa).toLocaleString() + '円' : '-'}`;
  })()}

## 訴求軸別
${HEADER}
${groupBy(withData, (c) => c.angle, from, today).map((r) => fmtRow(r, (k) => ANGLE_LABELS[k as Angle])).join('\n')}

## 形式別
${HEADER}
${groupBy(withData, (c) => c.format, from, today).map((r) => fmtRow(r, (k) => (k === 'video' ? '動画' : '画像'))).join('\n')}

## ペルソナ別
${HEADER}
${groupBy(withData, (c) => c.personaId, from, today).map((r) => fmtRow(r, personaName)).join('\n')}

## 求人別
${HEADER}
${groupBy(withData, (c) => c.jobId, from, today).map((r) => fmtRow(r, jobName)).join('\n')}

## 媒体別
${HEADER}
${(['meta', 'google'] as const)
  .map((p) => {
    const t = totals(withData.flatMap((c) => windowed(c.metrics, from, today, p)));
    return fmtRow({ key: p, count: withData.filter((c) => c.metrics.some((m) => m.platform === p)).length, totals: t }, (k) => (k === 'meta' ? 'Meta' : 'Google'));
  })
  .join('\n')}

## 上位の広告
${ranked.slice(0, 5).map(line).join('\n') || '- なし'}

## 下位の広告
${ranked.slice(-5).reverse().map(line).join('\n') || '- なし'}`;
}

export async function analyze(llm: Llm, creatives: Creative[], briefs: Record<string, CreativeBrief>, catalog: Catalog, today: string, previous?: Insight): Promise<Insight> {
  const report = buildReport(creatives, briefs, catalog, today);
  const out = await llm.structured({
    agent: 'analyst',
    system: ANALYST_SYSTEM,
    prompt: `${report}

# 前回までの学び
${previous ? previous.learnings.map((l) => `- ${l}`).join('\n') : '- なし'}

前回の学びのうち今回のデータで否定されたものは外し、裏付けられたものは残して、学びを更新してください。`,
    schema: InsightSchema,
  });
  return { date: today, ...out };
}
