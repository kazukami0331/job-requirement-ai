/**
 * 次に何を作るかの配分（多腕バンディット）。
 *
 * - 活用枠: 求人ごとに訴求軸の「応募につながる確率」を Thompson Sampling で引き、一番良い軸を作る
 * - 探索枠: まだ試していない／データの少ない軸を優先して作る（勝ちパターンの固定化を防ぐ）
 *
 * 報酬は「1000インプレッションあたりの応募」を主に使い、応募が少ない間はクリック率で代用する。
 */
import type { Catalog } from '../config.ts';
import { ANGLES, type Angle, type Creative, type Format, type Job } from '../types.ts';
import type { Slot } from '../agents/strategist.ts';
import type { Totals } from './stats.ts';
import { angleTotals, totals } from './stats.ts';
import { addDays, daysBetween } from '../util/id.ts';

export type Rng = () => number;

/** 再現性のあるテスト用の乱数（mulberry32）。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(k, 1) のサンプル（Marsaglia–Tsang）。 */
function gamma(k: number, rng: Rng): number {
  if (k < 1) return gamma(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a: number, b: number, rng: Rng): number {
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x / (x + y);
}

/**
 * 訴求軸の事後分布パラメータ。
 * 応募が3件以上あれば応募/インプレッション、なければクリック/インプレッション×想定応募率で近似する。
 * 古いデータに引っ張られすぎないよう、有効サンプル数に上限をかける。
 */
export function posterior(t: Totals | undefined, opts = { assumedCvr: 0.05, maxEffective: 20000 }): { a: number; b: number } {
  if (!t || t.impressions === 0) return { a: 1, b: 200 }; // 事前分布: 応募率 0.5% 前後を想定
  const scale = Math.min(1, opts.maxEffective / t.impressions);
  const successes = t.conversions >= 3 ? t.conversions : t.clicks * opts.assumedCvr;
  const n = t.impressions * scale;
  const s = successes * scale;
  return { a: 1 + s, b: 200 + Math.max(0, n - s) };
}

/**
 * 訴求軸ごとの「応募の質」補正係数（面接に進む率が全体平均の何倍か）。
 * 選考結果（funnel）が取り込まれていれば使い、データが少ない軸は平均に寄せる（縮小推定）。
 * 応募は多いが面接に来ない訴求を下げ、入社につながる訴求を上げるための係数で、0.5〜1.5 に収める。
 */
export function qualityFactors(creatives: Creative[], opts = { minApplied: 20, prior: 10 }): Map<Angle, number> {
  const byAngle = new Map<Angle, { applied: number; interview: number }>();
  for (const c of creatives) {
    if (!c.funnel) continue;
    const r = byAngle.get(c.angle) ?? { applied: 0, interview: 0 };
    r.applied += c.funnel.applied;
    r.interview += c.funnel.interview;
    byAngle.set(c.angle, r);
  }
  const applied = [...byAngle.values()].reduce((a, r) => a + r.applied, 0);
  const interview = [...byAngle.values()].reduce((a, r) => a + r.interview, 0);
  const out = new Map<Angle, number>();
  if (applied < opts.minApplied || interview === 0) return out;
  const base = interview / applied;
  for (const [angle, r] of byAngle) {
    const rate = (r.interview + opts.prior * base) / (r.applied + opts.prior);
    out.set(angle, Math.max(0.5, Math.min(1.5, rate / base)));
  }
  return out;
}

export interface AllocationInput {
  catalog: Catalog;
  creatives: Creative[];
  today: string;
  rng?: Rng;
  /** 学習に使う期間（日） */
  lookbackDays?: number;
}

/** 求人ごとの作成本数を決める（1サイクルの総数を quota の範囲で均等に配る）。 */
export function jobQuotas(jobs: Job[], total: number): Map<string, number> {
  const active = jobs.filter((j) => j.active);
  const quotas = new Map(active.map((j) => [j.id, 0]));
  let remaining = total;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (const j of active) {
      if (remaining === 0) break;
      const cap = j.dailyCreativeQuota ?? Infinity;
      if (quotas.get(j.id)! < cap) {
        quotas.set(j.id, quotas.get(j.id)! + 1);
        remaining--;
        progressed = true;
      }
    }
  }
  return quotas;
}

export function allocateSlots(input: AllocationInput): Slot[] {
  const { catalog, creatives, today } = input;
  const rng = input.rng ?? Math.random;
  const from = addDays(today, -(input.lookbackDays ?? 28));
  const policy = catalog.policy;
  const quotas = jobQuotas(catalog.jobs, policy.briefsPerCycle);
  const total = [...quotas.values()].reduce((a, b) => a + b, 0);
  const videoTarget = Math.round(total * policy.videoShare);
  const exploreTarget = Math.round(total * policy.exploreShare);

  // 探索枠の位置を全体に等間隔で散らす（どの求人にも探索が入るように）
  const explorePositions = new Set<number>();
  if (exploreTarget > 0) {
    const step = total / exploreTarget;
    for (let k = 0; k < exploreTarget; k++) explorePositions.add(Math.min(total - 1, Math.floor(k * step + step / 2)));
  }

  const quality = qualityFactors(creatives);
  const slots: Slot[] = [];
  let slotNo = 1;
  for (const job of catalog.jobs.filter((j) => j.active)) {
    const n = quotas.get(job.id) ?? 0;
    const stats = angleTotals(creatives, job.id, from, today);
    const jobCreatives = creatives.filter((c) => c.jobId === job.id);
    const personaUse = new Map(job.personas.map((p) => [p, jobCreatives.filter((c) => c.personaId === p).length]));
    const usedThisCycle = new Set<Angle>();
    // 改良版を作る価値のある勝ち広告（応募3件以上・目標単価以内で、疲弊で入れ替えたか配信10日以上。まだ改良版が無いもの）
    const iterated = new Set(creatives.map((c) => c.iterateOf).filter(Boolean));
    const winners = jobCreatives
      .filter((c) => (c.status === 'retired' || (c.status === 'published' && c.publishedAt && daysBetween(c.publishedAt.slice(0, 10), today) >= 10)) && !iterated.has(c.briefId))
      .map((c) => ({ c, t: totals(c.metrics) }))
      .filter((x) => x.t.conversions >= 3 && x.t.cpa !== null && x.t.cpa <= policy.guardrails.targetCpa)
      .sort((a, b) => a.t.cpa! - b.t.cpa!);

    for (let i = 0; i < n; i++) {
      const explore = explorePositions.has(slotNo - 1);
      // 活用枠の最初の1本は、勝ち広告があれば改良版にする
      if (!explore && winners.length && !slots.some((s) => s.jobId === job.id && s.iterateOf)) {
        const w = winners.shift()!.c;
        usedThisCycle.add(w.angle);
        slots.push({ slot: slotNo++, jobId: job.id, personaId: w.personaId, angle: w.angle, format: w.format, explore: false, iterateOf: w.briefId });
        continue;
      }
      let angle: Angle;
      if (explore) {
        // 試行回数（インプレッション）が少ない軸を優先。同数ならランダム
        const ranked = ANGLES.filter((a) => !usedThisCycle.has(a))
          .map((a) => ({ a, imp: stats.get(a)?.impressions ?? 0, r: rng() }))
          .sort((x, y) => x.imp - y.imp || x.r - y.r);
        angle = ranked[0]?.a ?? ANGLES[Math.floor(rng() * ANGLES.length)];
      } else {
        const draws = ANGLES.filter((a) => !usedThisCycle.has(a)).map((a) => {
          const { a: alpha, b: beta } = posterior(stats.get(a));
          return { a, v: betaSample(alpha, beta, rng) * (quality.get(a) ?? 1) };
        });
        draws.sort((x, y) => y.v - x.v);
        angle = draws[0]?.a ?? 'pay';
      }
      usedThisCycle.add(angle);

      // ペルソナは使用回数の少ない順に回す
      const personaId = [...personaUse.entries()].sort((x, y) => x[1] - y[1])[0][0];
      personaUse.set(personaId, personaUse.get(personaId)! + 1);

      slots.push({ slot: slotNo++, jobId: job.id, personaId, angle, format: 'image', explore });
    }
  }

  // カルーセルの本数（動画の割り当て後、画像のままの枠から等間隔に選ぶ）
  const carouselTarget = Math.round(total * (policy.carouselShare ?? 0));

  // 動画の本数を全体比率に合わせる（求人が偏らないよう等間隔に割り当て）
  if (videoTarget > 0 && slots.length > 0) {
    const step = slots.length / videoTarget;
    for (let k = 0; k < videoTarget; k++) {
      const s = slots[Math.min(slots.length - 1, Math.floor(k * step))];
      if (!s.iterateOf) s.format = 'video' as Format; // 改良版は元の形式のまま
    }
  }
  const imageSlots = slots.filter((s) => s.format === 'image' && !s.iterateOf);
  if (carouselTarget > 0 && imageSlots.length > 0) {
    const step = imageSlots.length / carouselTarget;
    for (let k = 0; k < Math.min(carouselTarget, imageSlots.length); k++) imageSlots[Math.min(imageSlots.length - 1, Math.floor(k * step + step / 2))].format = 'carousel';
  }
  return slots;
}

/**
 * 画像のレイアウト（帯 / カード / 給与ドン）を選ぶ。クリック率の Thompson Sampling で、
 * 反応の良いレイアウトを多めに、まだ試していないものも一定の確率で使う。
 */
export function chooseLayout<L extends string>(layouts: readonly L[], creatives: Creative[], today: string, rng: Rng = Math.random, lookbackDays = 28): L {
  const from = addDays(today, -(lookbackDays - 1));
  let best: { l: L; v: number } | null = null;
  for (const l of layouts) {
    const ms = creatives.filter((c) => c.layout === l).flatMap((c) => c.metrics.filter((m) => m.date >= from && m.date <= today));
    const imp = ms.reduce((a, m) => a + m.impressions, 0);
    const clk = ms.reduce((a, m) => a + m.clicks, 0);
    const scale = Math.min(1, 20000 / Math.max(1, imp));
    const v = betaSample(1 + clk * scale, 100 + (imp - clk) * scale, rng);
    if (!best || v > best.v) best = { l, v };
  }
  return best!.l;
}
