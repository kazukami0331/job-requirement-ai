/**
 * 配信中クリエイティブの停止・継続・予算増の判断（純粋関数。AIには判断させない）。
 *
 * 停止は「お金を守る方向」なので draft モードでも自動で実行する。
 * 予算を増やす判断は auto モードのときだけ実行し、draft モードでは提案として通知する。
 */
import type { Creative, Decision, Policy } from '../types.ts';
import { addDays, daysBetween } from '../util/id.ts';
import { lastNDays, median, totals, windowed } from './stats.ts';

export interface AdsetInfo {
  id: string;
  dailyBudget: number | null;
  /** この広告セットに入るペルソナ（ペルソナ別の入稿先があるとき）。未指定なら求人の全ペルソナ */
  personaIds?: string[];
}

export interface DecideInput {
  creatives: Creative[];
  policy: Policy;
  today: string;
  /** Meta の広告セット（予算を持つ単位）。クリエイティブ→広告セットの対応は jobs.json から引く */
  adsetsByJob: Map<string, AdsetInfo[]>;
  lookbackDays?: number;
  /** 最近予算を上げた広告セット（今回は上げない） */
  recentlyScaled?: Set<string>;
  /** 募集中の求人 ID。指定されていれば、それ以外（募集終了・削除）の求人の広告はすべて止める */
  activeJobIds?: Set<string>;
}

/** 応募効率のスコア（大きいほど良い）。停止候補の並べ替えに使う。 */
export function efficiencyScore(c: Creative, today: string, lookbackDays = 7): number {
  const t = totals(lastNDays(c.metrics, today, lookbackDays));
  if (t.conversions > 0 && t.cpa) return 1_000_000 / t.cpa; // 応募があるものは単価で比較
  return t.ctr; // 応募がまだ無いものはクリック率で比較（常に応募ありより下）
}

export function decide(input: DecideInput): Decision[] {
  const { policy, today } = input;
  const g = policy.guardrails;
  const lookback = input.lookbackDays ?? 7;
  const from = addDays(today, -(lookback - 1));
  // live=false は「入稿済みだが媒体側で停止中」（下書き入稿で人がまだ ON にしていない等）なので判断しない
  const live = input.creatives.filter((c) => c.status === 'published' && c.live !== false);
  const decisions: Decision[] = [];
  const paused = new Set<string>();

  const withData = live.map((c) => ({ c, t: totals(windowed(c.metrics, from, today)) }));
  const matured = withData.filter((x) => x.t.impressions >= g.minImpressions);
  const medianCtr = median(matured.map((x) => x.t.ctr));

  const pause = (c: Creative, reason: string, detail?: Record<string, unknown>) => {
    if (paused.has(c.id)) return;
    paused.add(c.id);
    decisions.push({ date: today, creativeId: c.id, action: 'pause', reason, applied: false, detail });
  };

  // 0. 募集終了・削除された求人の広告は、成績に関係なく止める（下書き入稿で未配信のものも、後から ON にされないよう止める）
  if (input.activeJobIds) {
    for (const c of input.creatives.filter((x) => x.status === 'published' && !input.activeJobIds!.has(x.jobId))) {
      pause(c, '求人の募集が終了したため停止（jobs.json で active: false または削除）');
    }
  }

  for (const { c, t } of withData) {
    if (paused.has(c.id)) continue;
    // 1. 応募ゼロのまま使いすぎ
    if (t.conversions === 0 && t.spend >= g.targetCpa * g.zeroConversionSpendMultiple) {
      pause(c, `応募0件のまま ${Math.round(t.spend).toLocaleString()}円 消化（目標応募単価の${g.zeroConversionSpendMultiple}倍）`, { spend: t.spend });
      continue;
    }
    // 2. 応募単価が目標の1.5倍超（応募3件以上で判断）
    if (t.conversions >= 3 && t.cpa !== null && t.cpa > g.targetCpa * 1.5) {
      pause(c, `応募単価 ${Math.round(t.cpa).toLocaleString()}円 が目標 ${g.targetCpa.toLocaleString()}円 の1.5倍超`, { cpa: t.cpa });
      continue;
    }
    // 3. クリック率が低すぎる（十分表示された上で、絶対値と相対値の両方で下回る）
    if (t.impressions >= g.minImpressions && t.ctr < g.ctrFloorPct && (matured.length < 3 || t.ctr < medianCtr * g.ctrRelativeFloor)) {
      pause(c, `CTR ${t.ctr.toFixed(2)}%（基準 ${g.ctrFloorPct}% / 中央値 ${medianCtr.toFixed(2)}%）`, { ctr: t.ctr, medianCtr });
      continue;
    }
    // 4. 広告疲れ: 配信から一定日数経ち、直近3日のCTRが初週の一定割合まで落ちた
    if (c.publishedAt) {
      const start = c.publishedAt.slice(0, 10);
      if (daysBetween(start, today) > g.fatigueDays) {
        const first = totals(windowed(c.metrics, start, addDays(start, 6)));
        const recent = totals(lastNDays(c.metrics, today, 3));
        if (first.impressions >= g.minImpressions / 2 && recent.impressions >= 500 && recent.ctr < first.ctr * g.fatigueCtrRatio) {
          decisions.push({
            date: today,
            creativeId: c.id,
            action: 'retire',
            reason: `広告疲れ: 直近CTR ${recent.ctr.toFixed(2)}% が初週 ${first.ctr.toFixed(2)}% の${Math.round(g.fatigueCtrRatio * 100)}%未満`,
            applied: false,
          });
          paused.add(c.id);
        }
      }
    }
  }

  // 5. 同じ求人で配信中が多すぎる場合は効率の悪い順に止める（学習の分散を防ぐ）
  const byJob = new Map<string, Creative[]>();
  for (const c of live) if (!paused.has(c.id)) byJob.set(c.jobId, [...(byJob.get(c.jobId) ?? []), c]);
  for (const [, list] of byJob) {
    const excess = list.length - g.maxActivePerAdset;
    if (excess <= 0) continue;
    // データが少ない新しい広告は守る（配信3日未満は対象外）
    const candidates = list
      .filter((c) => !c.publishedAt || daysBetween(c.publishedAt.slice(0, 10), today) >= 3)
      .sort((a, b) => efficiencyScore(a, today) - efficiencyScore(b, today));
    for (const c of candidates.slice(0, excess)) pause(c, `同時配信数の上限（${g.maxActivePerAdset}本）を超えたため効率の低い順に停止`);
  }

  // 6. 勝ちクリエイティブがある求人の広告セット予算を段階的に増やす
  for (const [jobId, adsets] of input.adsetsByJob) {
    // Meta の広告セットの予算なので、Meta での実績だけで判断する
    const jobWinners = live
      .filter((c) => c.jobId === jobId && !paused.has(c.id))
      .map((c) => ({ c, t: totals(windowed(c.metrics, from, today, 'meta')) }))
      .filter(({ t }) => t.conversions >= 3 && t.cpa !== null && t.cpa <= g.targetCpa * 0.8);
    for (const adset of adsets) {
      // その広告セットに入っているペルソナの勝ち広告だけで判断する（外国人向けの成果で日本人向けの予算を上げない）
      const winners = adset.personaIds ? jobWinners.filter((w) => adset.personaIds!.includes(w.c.personaId)) : jobWinners;
      if (winners.length === 0) continue;
      if (adset.dailyBudget === null) continue; // キャンペーン予算（CBO）の場合は触らない
      if (input.recentlyScaled?.has(adset.id)) continue;
      const next = Math.min(g.maxDailyBudget, Math.round(adset.dailyBudget * (1 + g.budgetStepPct / 100)));
      if (next <= adset.dailyBudget) continue;
      decisions.push({
        date: today,
        adsetId: adset.id,
        action: 'scale_budget',
        reason: `応募単価が目標の8割以下の広告が ${winners.length} 本（最良 ${Math.round(Math.min(...winners.map((w) => w.t.cpa!))).toLocaleString()}円）`,
        applied: false,
        detail: { from: adset.dailyBudget, to: next },
      });
    }
  }

  return decisions;
}
