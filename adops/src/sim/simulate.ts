/**
 * 架空の配信データで「企画 → 配信 → 分析 → 改善」のループを日数ぶん回すシミュレーター。
 * 媒体や画像生成を使わずに、配分ロジック（バンディット）と停止判断が正しく勝ち筋へ寄っていくかを確かめる。
 *
 * 訴求軸ごとに「本当の CTR・応募率」を決めておき、毎日その確率で表示・クリック・応募を発生させる。
 */
import type { Ctx } from '../pipeline/context.ts';
import { runCycle } from '../pipeline/cycle.ts';
import { ANGLES, ANGLE_LABELS, type Angle, type Creative } from '../types.ts';
import { seededRng, type Rng } from '../optimize/allocate.ts';
import { addDays } from '../util/id.ts';
import { totals } from '../optimize/stats.ts';

/** 仮の真の値（%）。寮・給与が強く、誇りは弱い、という想定。 */
export const TRUE_RATES: Record<Angle, { ctr: number; cvr: number }> = {
  pay: { ctr: 1.3, cvr: 6 },
  housing: { ctr: 1.6, cvr: 7 },
  beginner: { ctr: 1.1, cvr: 5 },
  stability: { ctr: 0.8, cvr: 5 },
  quick_cash: { ctr: 1.4, cvr: 3 },
  lifestyle: { ctr: 0.7, cvr: 4 },
  team: { ctr: 0.6, cvr: 4 },
  skill: { ctr: 0.9, cvr: 6 },
  pride: { ctr: 0.4, cvr: 3 },
  speed: { ctr: 1.0, cvr: 8 },
};

function binomial(n: number, p: number, rng: Rng): number {
  if (n > 200) {
    // 正規近似
    const mean = n * p;
    const sd = Math.sqrt(n * p * (1 - p));
    const u = Math.max(rng(), 1e-12);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    return Math.max(0, Math.round(mean + sd * z));
  }
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}

export function simulateDay(c: Creative, today: string, rng: Rng): void {
  const age = c.publishedAt ? Math.max(0, (Date.parse(today) - Date.parse(c.publishedAt.slice(0, 10))) / 86_400_000) : 0;
  const fatigue = Math.max(0.4, 1 - age * 0.03); // 毎日3%ずつ反応が落ちる
  const quality = 0.7 + rng() * 0.6; // 同じ軸でも出来にばらつき
  const r = TRUE_RATES[c.angle];
  const impressions = Math.round(2500 + rng() * 2500);
  const clicks = binomial(impressions, (r.ctr / 100) * quality * fatigue * (c.format === 'video' ? 1.15 : 1), rng);
  const conversions = binomial(clicks, r.cvr / 100, rng);
  const cpm = 600 + rng() * 300;
  c.metrics.push({ date: today, platform: 'meta', impressions, clicks, spend: Math.round((impressions / 1000) * cpm), conversions });
}

export async function simulate(ctx: Ctx, opts: { days: number; seed: number }): Promise<void> {
  const rng = seededRng(opts.seed);
  const start = ctx.today;
  const history: Record<string, Record<Angle, number>> = {};

  for (let d = 0; d < opts.days; d++) {
    const today = addDays(start, d);
    ctx.today = today;
    ctx.cycleId = `sim_${today}`;
    // 前日分までの実績が入っている前提で、判断 → 分析 → 企画
    await runCycle(ctx, ['optimize', 'analyze', 'plan']);
    // 制作・入稿は省略し、企画済みをその日に配信開始したことにする
    for (const c of ctx.store.creatives({ status: ['planned', 'awaiting_images', 'produced'] })) {
      c.status = 'published';
      c.publishedAt = `${today}T00:00:00.000Z`;
    }
    for (const c of ctx.store.creatives({ status: 'published' })) simulateDay(c, today, rng);
    const live = ctx.store.creatives({ status: 'published' });
    history[today] = Object.fromEntries(ANGLES.map((a) => [a, live.filter((c) => c.angle === a).length])) as Record<Angle, number>;
    ctx.store.save();
  }

  console.log('\n日付        ' + ANGLES.map((a) => ANGLE_LABELS[a].slice(0, 4).padEnd(5)).join(''));
  for (const [day, row] of Object.entries(history)) console.log(`${day}  ${ANGLES.map((a) => String(row[a]).padEnd(6)).join('')}`);
  const all = ctx.store.creatives();
  console.log('\n訴求軸ごとの累計（真の CTR / 応募率 → 観測）');
  for (const a of ANGLES) {
    const t = totals(all.filter((c) => c.angle === a).flatMap((c) => c.metrics));
    console.log(
      `${ANGLE_LABELS[a].padEnd(8)} 真 ${TRUE_RATES[a].ctr.toFixed(1)}% / ${TRUE_RATES[a].cvr}%  → 表示 ${String(t.impressions).padStart(7)}  CTR ${t.ctr.toFixed(2)}%  応募 ${String(t.conversions).padStart(4)}  単価 ${t.cpa ? Math.round(t.cpa) : '-'}`,
    );
  }
}
