import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSlots, betaSample, jobQuotas, posterior, seededRng } from '../src/optimize/allocate.ts';
import { decide } from '../src/optimize/decide.ts';
import { mergeMetrics, median, totals } from '../src/optimize/stats.ts';
import { decideVerdict } from '../src/agents/reviewer.ts';
import { catalog, creative, daily, job, policy } from './fixtures.ts';
import { ANGLES } from '../src/types.ts';

test('totals: CTR・CPA を計算する', () => {
  const t = totals(daily('2026-10-01', 2, { impressions: 1000, clicks: 10, spend: 5000, conversions: 1 }));
  assert.equal(t.impressions, 2000);
  assert.equal(t.ctr, 1);
  assert.equal(t.cpa, 5000);
  assert.equal(totals([]).cpa, null);
});

test('mergeMetrics: 同じ日・媒体は上書き（二重計上しない）', () => {
  const a = daily('2026-10-01', 2, { impressions: 100, clicks: 1, spend: 10, conversions: 0 });
  const b = daily('2026-10-02', 2, { impressions: 200, clicks: 2, spend: 20, conversions: 0 });
  const m = mergeMetrics(a, b);
  assert.equal(m.length, 3);
  assert.equal(m.find((x) => x.date === '2026-10-02')!.impressions, 200);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test('jobQuotas: 求人ごとの上限を守って配る', () => {
  const jobs = [job({ id: 'a', dailyCreativeQuota: 1 }), job({ id: 'b', dailyCreativeQuota: 5 }), job({ id: 'c', active: false })];
  const q = jobQuotas(jobs, 4);
  assert.equal(q.get('a'), 1);
  assert.equal(q.get('b'), 3);
  assert.equal(q.has('c'), false);
});

test('betaSample は 0〜1 で平均が理論値に近い', () => {
  const rng = seededRng(1);
  let sum = 0;
  for (let i = 0; i < 4000; i++) sum += betaSample(3, 7, rng);
  assert.ok(Math.abs(sum / 4000 - 0.3) < 0.02);
});

test('posterior: データが無ければ弱い事前分布、応募が多い軸ほど期待値が高い', () => {
  assert.deepEqual(posterior(undefined), { a: 1, b: 200 });
  const good = posterior(totals(daily('2026-10-01', 7, { impressions: 3000, clicks: 45, spend: 2000, conversions: 3 })));
  const bad = posterior(totals(daily('2026-10-01', 7, { impressions: 3000, clicks: 10, spend: 2000, conversions: 0 })));
  assert.ok(good.a / (good.a + good.b) > bad.a / (bad.a + bad.b));
});

test('allocateSlots: 枠数・動画比率・探索枠数が設定どおり', () => {
  const cat = catalog({ jobs: [job({ id: 'a', dailyCreativeQuota: 2 }), job({ id: 'b', dailyCreativeQuota: 2 })], policy: policy({ briefsPerCycle: 4, videoShare: 0.5, exploreShare: 0.5 }) });
  const slots = allocateSlots({ catalog: cat, creatives: [], today: '2026-10-10', rng: seededRng(7) });
  assert.equal(slots.length, 4);
  assert.equal(slots.filter((s) => s.format === 'video').length, 2);
  assert.equal(slots.filter((s) => s.explore).length, 2);
  // 同じ求人の中で訴求軸が重ならない
  for (const id of ['a', 'b']) {
    const angles = slots.filter((s) => s.jobId === id).map((s) => s.angle);
    assert.equal(new Set(angles).size, angles.length);
  }
});

test('allocateSlots: 活用枠は成果の良い訴求軸に寄る', () => {
  const cat = catalog({ policy: policy({ briefsPerCycle: 1, exploreShare: 0, videoShare: 0 }), jobs: [job({ dailyCreativeQuota: 1 })] });
  const creatives = ANGLES.map((a, i) =>
    creative({
      id: `cr_${a}`,
      angle: a,
      metrics: daily('2026-10-01', 7, a === 'speed' ? { impressions: 5000, clicks: 120, spend: 4000, conversions: 12 } : { impressions: 5000, clicks: 20 + i, spend: 4000, conversions: 0 }),
    }),
  );
  const counts = new Map<string, number>();
  for (let s = 0; s < 50; s++) {
    const [slot] = allocateSlots({ catalog: cat, creatives, today: '2026-10-07', rng: seededRng(s) });
    counts.set(slot.angle, (counts.get(slot.angle) ?? 0) + 1);
  }
  assert.ok((counts.get('speed') ?? 0) >= 45, JSON.stringify([...counts]));
});

test('allocateSlots: 探索枠はまだ試していない軸を選ぶ', () => {
  const cat = catalog({ policy: policy({ briefsPerCycle: 1, exploreShare: 1, videoShare: 0 }), jobs: [job({ dailyCreativeQuota: 1 })] });
  const tried = ANGLES.filter((a) => a !== 'skill').map((a) => creative({ id: `cr_${a}`, angle: a, metrics: daily('2026-10-01', 3, { impressions: 1000, clicks: 10, spend: 100, conversions: 0 }) }));
  const [slot] = allocateSlots({ catalog: cat, creatives: tried, today: '2026-10-03', rng: seededRng(3) });
  assert.equal(slot.explore, true);
  assert.equal(slot.angle, 'skill');
});

test('decide: 応募ゼロで使いすぎた広告を止める', () => {
  const c = creative({ metrics: daily('2026-10-01', 7, { impressions: 4000, clicks: 40, spend: 3000, conversions: 0 }) });
  const d = decide({ creatives: [c], policy: policy(), today: '2026-10-07', adsetsByJob: new Map() });
  assert.equal(d[0]?.action, 'pause');
  assert.match(d[0].reason, /応募0件/);
});

test('decide: CTR が基準未満で中央値の半分未満なら止める', () => {
  const healthy = [1, 2, 3].map((i) => creative({ id: `ok${i}`, metrics: daily('2026-10-01', 7, { impressions: 2000, clicks: 30, spend: 500, conversions: 1 }) }));
  const weak = creative({ id: 'weak', metrics: daily('2026-10-01', 7, { impressions: 2000, clicks: 4, spend: 500, conversions: 1 }) });
  const d = decide({ creatives: [...healthy, weak], policy: policy(), today: '2026-10-07', adsetsByJob: new Map() });
  assert.deepEqual(d.filter((x) => x.action === 'pause').map((x) => x.creativeId), ['weak']);
});

test('decide: 表示が少ないうちは CTR で止めない', () => {
  const c = creative({ metrics: daily('2026-10-07', 1, { impressions: 500, clicks: 0, spend: 300, conversions: 0 }) });
  assert.equal(decide({ creatives: [c], policy: policy(), today: '2026-10-07', adsetsByJob: new Map() }).length, 0);
});

test('decide: 広告疲れを検知して入れ替える', () => {
  const metrics = [
    ...daily('2026-10-01', 7, { impressions: 3000, clicks: 60, spend: 1000, conversions: 1 }),
    ...daily('2026-10-08', 9, { impressions: 3000, clicks: 45, spend: 1000, conversions: 1 }),
    ...daily('2026-10-17', 3, { impressions: 3000, clicks: 20, spend: 1000, conversions: 1 }),
  ];
  const c = creative({ metrics, publishedAt: '2026-10-01T00:00:00Z' });
  const d = decide({ creatives: [c], policy: policy(), today: '2026-10-19', adsetsByJob: new Map() });
  assert.equal(d[0]?.action, 'retire');
});

test('decide: 勝ち広告がある求人の予算を上限まで段階的に増やす', () => {
  const c = creative({ metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 60, spend: 3000, conversions: 1 }) });
  const d = decide({ creatives: [c], policy: policy(), today: '2026-10-07', adsetsByJob: new Map([['factory', [{ id: 'as1', dailyBudget: 28000 }, { id: 'cbo', dailyBudget: null }]]]) });
  const scale = d.filter((x) => x.action === 'scale_budget');
  assert.equal(scale.length, 1);
  assert.deepEqual(scale[0].detail, { from: 28000, to: 30000 });
});

test('decide: 同時配信数の上限を超えたら効率の悪い順に止める（新しい広告は守る）', () => {
  const p = policy({ guardrails: { ...policy().guardrails, maxActivePerAdset: 2 } });
  const mk = (id: string, clicks: number, publishedAt = '2026-10-01T00:00:00Z') =>
    creative({ id, publishedAt, metrics: daily(publishedAt.slice(0, 10), 7 - (Date.parse(publishedAt) - Date.parse('2026-10-01')) / 86_400_000, { impressions: 1000, clicks, spend: 100, conversions: 0 }) });
  const d = decide({ creatives: [mk('a', 30), mk('b', 20), mk('c', 10), mk('new', 1, '2026-10-06T00:00:00Z')], policy: p, today: '2026-10-07', adsetsByJob: new Map() });
  assert.deepEqual(d.filter((x) => x.action === 'pause').map((x) => x.creativeId).sort(), ['b', 'c']);
});

test('decideVerdict: blocker は改訂上限まで差し戻し、上限で却下', () => {
  const blocker = [{ severity: 'blocker' as const, field: 'x', problem: 'p', suggestion: 's' }];
  assert.equal(decideVerdict(95, blocker, 75, 0, 2), 'revise');
  assert.equal(decideVerdict(95, blocker, 75, 2, 2), 'reject');
  assert.equal(decideVerdict(80, [], 75, 0, 2), 'pass');
  assert.equal(decideVerdict(60, [], 75, 0, 2), 'revise');
  assert.equal(decideVerdict(60, [], 75, 2, 2), 'reject');
  const major = [{ severity: 'major' as const, field: 'x', problem: 'p', suggestion: 's' }];
  assert.equal(decideVerdict(90, major, 75, 0, 2), 'revise');
  assert.equal(decideVerdict(90, major, 75, 2, 2), 'pass');
});
