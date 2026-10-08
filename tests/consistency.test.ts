import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeSnapshots } from "@/lib/recruiting/merge";
import {
  breakdown,
  funnel,
  kpis,
  recentWeekKeys,
  stagePool,
  weeklyMatrix,
  weeklyTrend,
} from "@/lib/recruiting/aggregate";
import { DEFAULT_RATES, monthlyGoals } from "@/lib/recruiting/goal";
import { shortageByShop } from "@/lib/recruiting/plan";
import { normalizeShopKey } from "@/lib/recruiting/shops";
import { Application, HiringPlan, Snapshot } from "@/types/recruiting";

/**
 * ダッシュボードの数字どうしの辻褄を見るテスト。
 *
 * 画面には同じ「応募」「採用」が何か所にも出る。計算そのものが合っていても、
 * 母数（期間・対象校舎）が揃っていないまま並ぶと、見た人には食い違いにしか見えない。
 * 実際にそれで何度も混乱させたので、母数が揃っていることを機械で見張る。
 */

const seed = JSON.parse(readFileSync(new URL("../public/seed/initial.json", import.meta.url), "utf8")) as {
  snapshots: Snapshot[];
  plan: HiringPlan;
};

const plan = seed.plan;
const asOf = seed.snapshots[seed.snapshots.length - 1].takenAt;
const everything = mergeSnapshots(seed.snapshots);

/** 画面の既定と同じ絞り込み（採用目標のある校舎 × 今期） */
const master = new Set(
  shortageByShop(plan)
    .filter((s) => s.shortage > 0)
    .map((s) => normalizeShopKey(s.shopShortName))
);
const termFrom = "2026-09-01";
const apps: Application[] = everything.filter(
  (a) => master.has(normalizeShopKey(a.shopShortName)) && a.receivedDate >= termFrom
);

const weeks = recentWeekKeys(apps, asOf);
const summary = kpis(apps, weeks, asOf);
const goals = monthlyGoals(apps, plan, DEFAULT_RATES, asOf);
const total = goals.total!;

test("応募数は、どの切り口で足しても同じになる", () => {
  assert.equal(breakdown(apps, "shopShortName", weeks).reduce((a, r) => a + r.applied, 0), apps.length);
  assert.equal(weeklyTrend(apps).reduce((a, p) => a + p.applied, 0), apps.length);
  assert.equal(stagePool(apps).reduce((a, s) => a + s.count, 0), apps.length);
  assert.equal(funnel(apps)[0].count, apps.length);
  assert.equal(weeklyMatrix(apps, "shopShortName", 99).rows.reduce((a, r) => a + r.total, 0), apps.length);
  assert.equal(
    total.months.reduce((a, m) => a + m.appliedActual, 0),
    apps.length
  );
});

test("採用数は、KPI・ファネル・校舎別・月次目標で一致する", () => {
  assert.equal(funnel(apps)[3].count, summary.hired);
  assert.equal(breakdown(apps, "shopShortName", weeks).reduce((a, r) => a + r.hired, 0), summary.hired);
  // 採用済み（充足）も同じ母数で数える。ここだけ全期間にすると画面で食い違う。
  assert.equal(total.alreadyHired, summary.hired);
  assert.equal(
    total.months.reduce((a, m) => a + m.hireActual, 0),
    summary.hired
  );
});

test("選考中プールは、ステータス内訳の選考中と一致する", () => {
  assert.equal(
    stagePool(apps)
      .filter((s) => s.active)
      .reduce((a, s) => a + s.count, 0),
    summary.activePool
  );
});

test("月ごとの目標を足すと、全体の目標に戻る", () => {
  assert.equal(
    total.months.reduce((a, m) => a + m.targetApplied, 0),
    total.requiredApplied
  );
  assert.equal(
    total.months.reduce((a, m) => a + m.targetHire, 0),
    total.remainingTarget
  );
  assert.equal(total.remainingTarget, total.hireTarget - total.alreadyHired);
  assert.equal(
    goals.rows.reduce((a, r) => a + r.requiredApplied, 0),
    total.requiredApplied
  );
});

test("必要応募は、人数 × 1名あたりの応募数から大きく離れない", () => {
  // 校舎ごとに切り上げるぶんだけ多くなる。月ごとに切り上げていた頃は1割ほど膨らんでいた。
  const perHire = 1 / (DEFAULT_RATES.applyToInterview * DEFAULT_RATES.interviewToHire);
  const naive = total.remainingTarget * perHire;
  assert.ok(total.requiredApplied >= Math.floor(naive), `${total.requiredApplied} が少なすぎる`);
  assert.ok(total.requiredApplied <= Math.ceil(naive) + goals.rows.length, `${total.requiredApplied} が多すぎる`);
});

test("4週平均は、集計途中の週を混ぜない", () => {
  const settled = weeklyTrend(apps).filter((p) => p.week.end <= asOf.slice(0, 10));
  const last4 = settled.slice(-4);
  assert.equal(summary.avg4w, last4.reduce((a, p) => a + p.applied, 0) / last4.length);
});

test("校舎名の略称が、店舗マスタの校舎に寄せられる", () => {
  // 不足人数マスタは「名古屋」、応募データは「名古屋駅前校」。別物として扱うと応募が丸ごと落ちる。
  assert.equal(normalizeShopKey("名古屋"), normalizeShopKey("名古屋駅前校"));
  // 似ているだけの別校舎は混ぜない。
  assert.notEqual(normalizeShopKey("新宿校"), normalizeShopKey("新宿本校"));
});

test("表に載らなかった応募は、校舎名まで出せる", () => {
  const g = monthlyGoals(apps, plan, DEFAULT_RATES, asOf, undefined, everything);
  assert.equal(
    g.coverage.missing.reduce((a, m) => a + m.count, 0),
    g.coverage.all - g.coverage.inTable
  );
});
