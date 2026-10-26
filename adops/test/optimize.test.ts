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
  assert.deepEqual(posterior(undefined), { a: 1, b: 2000 });
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

test('decideVerdict: 機械チェックの major が改訂上限まで残れば却下（点数が高くても）', () => {
  const major = [{ severity: 'major' as const, field: 'headline', problem: '根拠のない No.1', suggestion: '' }];
  assert.equal(decideVerdict(90, major, 75, 2, 2, major), 'reject');
  // AI の major だけなら、上限で点数が合格なら通す（従来どおり）
  assert.equal(decideVerdict(90, major, 75, 2, 2, []), 'pass');
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

test('qualityFactors: 面接に進む率が低い訴求軸は係数が下がる（データが少なければ平均に寄せる）', async () => {
  const { qualityFactors } = await import('../src/optimize/allocate.ts');
  const f = (applied: number, interview: number) => ({ applied, interview, offer: 0, hired: 0, updatedAt: '' });
  const q = qualityFactors([
    creative({ id: 'a', angle: 'quick_cash', funnel: f(40, 4) }),
    creative({ id: 'b', angle: 'housing', funnel: f(40, 20) }),
    creative({ id: 'c', angle: 'skill', funnel: f(2, 0) }),
  ]);
  assert.ok(q.get('quick_cash')! < 0.6);
  assert.ok(q.get('housing')! > 1.3);
  assert.ok(q.get('skill')! > 0.7 && q.get('skill')! < 1);
  assert.equal(qualityFactors([creative({ funnel: f(5, 1) })]).size, 0);
});

test('chooseLayout: クリック率の高いレイアウトを多く選ぶ', async () => {
  const { chooseLayout } = await import('../src/optimize/allocate.ts');
  const cs = [
    creative({ id: 'a', layout: 'band', metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 15, spend: 0, conversions: 0 }) }),
    creative({ id: 'b', layout: 'card', metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 60, spend: 0, conversions: 0 }) }),
    creative({ id: 'c', layout: 'bold', metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 20, spend: 0, conversions: 0 }) }),
  ];
  const counts = new Map<string, number>();
  for (let i = 0; i < 100; i++) {
    const l = chooseLayout(['band', 'card', 'bold'] as const, cs, '2026-10-07', seededRng(i));
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  assert.ok((counts.get('card') ?? 0) > 90, JSON.stringify([...counts]));
  // データが無ければどれも選ばれうる
  const fresh = new Set(Array.from({ length: 60 }, (_, i) => chooseLayout(['band', 'card', 'bold'] as const, [], '2026-10-07', seededRng(i))));
  assert.equal(fresh.size, 3);
});

test('allocateSlots: 疲弊で入れ替えた勝ち広告があれば、活用枠の1本目を改良版にする（1回だけ）', () => {
  const cat = catalog({ policy: policy({ briefsPerCycle: 2, exploreShare: 0, videoShare: 0 }), jobs: [job({ dailyCreativeQuota: 2 })] });
  const winner = creative({
    id: 'w',
    briefId: 'br_w',
    angle: 'housing',
    format: 'video',
    status: 'retired',
    metrics: daily('2026-10-01', 10, { impressions: 3000, clicks: 50, spend: 2000, conversions: 1 }),
  });
  const slots = allocateSlots({ catalog: cat, creatives: [winner], today: '2026-10-20', rng: seededRng(1) });
  assert.equal(slots[0].iterateOf, 'br_w');
  assert.equal(slots[0].angle, 'housing');
  assert.equal(slots[0].format, 'video');
  assert.equal(slots[1].iterateOf, undefined);
  // 既に改良版があれば作らない
  const again = allocateSlots({ catalog: cat, creatives: [winner, creative({ id: 'v', iterateOf: 'br_w' })], today: '2026-10-20', rng: seededRng(1) });
  assert.ok(again.every((s) => !s.iterateOf));
});

test('rewardMetric=interviews: 面接数が多い訴求軸を選ぶ', () => {
  const f = (applied: number, interview: number) => ({ applied, interview, offer: 0, hired: 0, updatedAt: '' });
  const cs = [
    // 応募は多いが面接に来ない
    creative({ id: 'a', angle: 'quick_cash', funnel: f(30, 1), metrics: daily('2026-10-01', 7, { impressions: 5000, clicks: 100, spend: 3000, conversions: 5 }) }),
    // 応募は少なめだが面接に来る
    creative({ id: 'b', angle: 'skill', funnel: f(12, 10), metrics: daily('2026-10-01', 7, { impressions: 5000, clicks: 60, spend: 3000, conversions: 2 }) }),
  ];
  const pick = (reward?: 'interviews', list = cs) => {
    const cat = catalog({ policy: policy({ briefsPerCycle: 1, exploreShare: 0, videoShare: 0, rewardMetric: reward }), jobs: [job({ dailyCreativeQuota: 1 })] });
    const counts = new Map<string, number>();
    for (let s = 0; s < 40; s++) {
      const [slot] = allocateSlots({ catalog: cat, creatives: list, today: '2026-10-07', rng: seededRng(s) });
      counts.set(slot.angle, (counts.get(slot.angle) ?? 0) + 1);
    }
    return counts;
  };
  // 選考結果が無ければ応募数で比べる（応募の多い quick_cash が有利）
  const byApps = pick(undefined, cs.map((c) => ({ ...c, funnel: undefined })));
  const byInterviews = pick('interviews');
  assert.ok((byApps.get('quick_cash') ?? 0) > (byApps.get('skill') ?? 0), JSON.stringify([...byApps]));
  assert.ok((byInterviews.get('skill') ?? 0) > (byInterviews.get('quick_cash') ?? 0), JSON.stringify([...byInterviews]));
});

test('decide: 募集が終わった求人の広告は成績に関係なく止める', () => {
  const good = creative({ id: 'g', jobId: 'ended', metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 90, spend: 1000, conversions: 2 }) });
  const draft = creative({ id: 'd', jobId: 'ended', live: false });
  const other = creative({ id: 'o', jobId: 'factory', metrics: daily('2026-10-01', 7, { impressions: 3000, clicks: 90, spend: 1000, conversions: 2 }) });
  const d = decide({ creatives: [good, draft, other], policy: policy(), today: '2026-10-07', adsetsByJob: new Map(), activeJobIds: new Set(['factory']) });
  assert.deepEqual(d.filter((x) => x.action === 'pause').map((x) => x.creativeId).sort(), ['d', 'g']);
  assert.match(d[0].reason, /募集が終了/);
});

test('jobsAtTarget: 今月の応募が目標に達した求人だけを返す（先月分と検索広告も考慮）', async () => {
  const { jobsAtTarget, monthApplications } = await import('../src/optimize/allocate.ts');
  const { creative, daily, job } = await import('./fixtures.ts');
  const jobs = [job({ monthlyApplicationTarget: 5 }), job({ id: 'driver', monthlyApplicationTarget: 5 }), job({ id: 'free' })];
  const creatives = [
    creative({ jobId: 'factory', metrics: daily('2026-10-01', 4, { impressions: 1000, clicks: 10, spend: 1000, conversions: 1 }) }),
    creative({ id: 'cr_2', jobId: 'driver', metrics: daily('2026-09-25', 10, { impressions: 1000, clicks: 10, spend: 1000, conversions: 1 }) }),
  ];
  const searchAds = [{ id: 'rsa_1', jobId: 'factory', metrics: daily('2026-10-05', 1, { impressions: 100, clicks: 5, spend: 500, conversions: 1 }) }] as any;
  assert.equal(monthApplications('factory', creatives, searchAds, '2026-10-10'), 5);
  // driver は9月分を除くと 10/1〜10/4 の4件
  assert.equal(monthApplications('driver', creatives, searchAds, '2026-10-10'), 4);
  assert.deepEqual(jobsAtTarget(jobs, creatives, searchAds, '2026-10-10').map((x) => x.job.id), ['factory']);
  // 翌月はリセット
  assert.deepEqual(jobsAtTarget(jobs, creatives, searchAds, '2026-11-01'), []);
});

test('allocateSlots: 学習は言語ごとに分かれ、外国語ペルソナの実績で日本語向けの配分が動かない', async () => {
  const { catalog, creative, daily, job, persona, policy } = await import('./fixtures.ts');
  const cat = catalog({
    personas: [persona(), persona({ id: 'vi', language: 'vi' })],
    jobs: [job({ personas: ['p1', 'vi'], dailyCreativeQuota: 2 })],
    policy: policy({ briefsPerCycle: 2, videoShare: 0, exploreShare: 0 }),
  });
  const strong = { impressions: 20000, clicks: 400, spend: 20000, conversions: 20 };
  const weak = { impressions: 20000, clicks: 100, spend: 20000, conversions: 0 };
  const creatives = [
    creative({ id: 'a', personaId: 'p1', angle: 'pay', metrics: daily('2026-10-01', 7, strong) }),
    creative({ id: 'b', personaId: 'p1', angle: 'housing', metrics: daily('2026-10-01', 7, weak) }),
    creative({ id: 'c', personaId: 'vi', angle: 'housing', metrics: daily('2026-10-01', 7, strong) }),
    creative({ id: 'd', personaId: 'vi', angle: 'pay', metrics: daily('2026-10-01', 7, weak) }),
  ];
  const picks: Record<string, Record<string, number>> = { p1: {}, vi: {} };
  for (let seed = 1; seed <= 60; seed++) {
    for (const s of allocateSlots({ catalog: cat, creatives, today: '2026-10-08', rng: seededRng(seed) })) {
      picks[s.personaId][s.angle] = (picks[s.personaId][s.angle] ?? 0) + 1;
    }
  }
  // 共有で学習していれば両方の軸が同じくらい選ばれるはず。言語ごとなら、それぞれの勝ち軸だけが選ばれる
  assert.ok((picks.p1.pay ?? 0) > (picks.p1.housing ?? 0) + 10, JSON.stringify(picks));
  assert.ok((picks.vi.housing ?? 0) > (picks.vi.pay ?? 0) + 10, JSON.stringify(picks));
});

test('decide: 予算増はその広告セットに入るペルソナの勝ち広告だけで判断する', () => {
  const winner = creative({
    id: 'w', personaId: 'vi', publishedAt: '2026-10-01T00:00:00Z',
    metrics: daily('2026-10-01', 14, { impressions: 3000, clicks: 30, spend: 3000, conversions: 1 }),
  });
  const d = decide({
    creatives: [winner], policy: policy(), today: '2026-10-14',
    adsetsByJob: new Map([['factory', [{ id: 'ja_set', dailyBudget: 10000, personaIds: ['p1'] }, { id: 'vi_set', dailyBudget: 10000, personaIds: ['vi'] }]]]),
  });
  assert.deepEqual(d.filter((x) => x.action === 'scale_budget').map((x) => x.adsetId), ['vi_set']);
});
