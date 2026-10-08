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
  weeklyHires,
  weeklyMatrix,
  weeklyTrend,
} from "@/lib/recruiting/aggregate";
import { DEFAULT_RATES, monthlyGoals } from "@/lib/recruiting/goal";
import { FUNNEL_STEPS, stageOf } from "@/lib/recruiting/status";
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

/**
 * 採用は「採用が決まった日」で期間を切る。応募日で切ると、8月に応募して9月に
 * 採れた人が今期の採用に入らず、週次グラフと月次表で数が食い違う。
 */
const movedOn = (a: Application) => (a.statusUpdatedAt ?? a.receivedAt).slice(0, 10);
const scoped = everything.filter((a) => master.has(normalizeShopKey(a.shopShortName)));
const hires = scoped.filter((a) => stageOf(a.statusId) === "hired" && movedOn(a) >= termFrom);
const interviews = scoped.filter((a) => FUNNEL_STEPS[1].reached(stageOf(a.statusId)) && movedOn(a) >= termFrom);

const weeks = recentWeekKeys(apps, asOf);
const summary = kpis(apps, weeks, asOf);
const goals = monthlyGoals(apps, plan, DEFAULT_RATES, asOf, undefined, undefined, { hires, interviews });
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

test("採用数は、採用タイル・週次グラフ・月次目標で一致する", () => {
  // 画面に出る「採用」は、どれも「この期間に採用が決まった人数」で揃える。
  assert.equal(total.alreadyHired, hires.length);
  assert.equal(
    total.months.reduce((a, m) => a + m.hireActual, 0),
    hires.length
  );
  // 充足のほうは、目標を超えたぶんを除いた数になる
  assert.equal(
    total.months.reduce((a, m) => a + m.hireFilledActual, 0),
    total.filledHired
  );
  assert.equal(
    weeklyHires(hires, weeklyTrend(apps).map((p) => p.week)).reduce((a, p) => a + p.hired, 0),
    hires.length
  );
});

test("ファネルの採用は、応募を追いかけたコホートとして筋が通っている", () => {
  // ファネルだけは「この期間に応募した人がどこまで進んだか」。数が違うのは当然だが、
  // 応募数を超えることはないし、校舎別の合計とは一致する。
  const f = funnel(apps);
  assert.ok(f[3].count <= apps.length);
  assert.equal(breakdown(apps, "shopShortName", weeks).reduce((a, r) => a + r.hired, 0), f[3].count);
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
  // 月へ配ったのは按分開始時点の残り。期間中に採れたぶん、いまの残りのほうが少なくなる。
  assert.equal(
    total.months.reduce((a, m) => a + m.targetHire, 0),
    total.planRemaining
  );
  assert.ok(total.planRemaining >= total.remainingTarget);
  assert.equal(total.remainingTarget, total.hireTarget - total.filledHired);
  // 月へ配るのは「按分開始時点の残り」。採用目標そのものを割り直しているわけではない。
  assert.equal(
    total.months.reduce((a, m) => a + m.targetHire, 0) + total.filledAtStart,
    total.hireTarget
  );
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

test("目標を超えて採れたぶんは、月の進捗に乗せない", () => {
  // 目標3名の校舎で5名採れても、充足は3名まで。残り2名は他校舎の不足を埋めないので、
  // 月の実績（進捗）には入れず、別枠（+N）で出す。
  for (const r of [...goals.rows, total]) {
    const filled = r.months.reduce((a, m) => a + m.hireFilledActual, 0);
    const raw = r.months.reduce((a, m) => a + m.hireActual, 0);
    assert.equal(filled, r.filledHired, `${r.shopShortName} の充足が月の合計と合わない`);
    assert.equal(raw, r.alreadyHired, `${r.shopShortName} の採用が月の合計と合わない`);
    assert.ok(filled <= raw);
  }
});

test("月次目標の採用実績は、その月に決まった採用で数える", () => {
  // 10/5週に9名決まったのに10月の実績が3名、のような食い違いを防ぐ。
  for (const m of total.months) {
    const inMonth = hires.filter((h) => movedOn(h).slice(0, 7) === m.month).length;
    assert.equal(m.hireActual, inMonth, `${m.label} の採用実績が決定月と合わない`);
  }
});

test("目標より多く採れた校舎があっても、採用 / 目標 / 残りの引き算が合う", () => {
  // 目標1名の校舎で2名採れるケース。超過分を残りから引くと、合計が1名ぶん合わなくなる。
  const over = goals.rows.filter((r) => r.alreadyHired > r.hireTarget);
  for (const r of [...goals.rows, total]) {
    assert.equal(r.filledHired + r.remainingTarget, r.hireTarget, `${r.shopShortName} の引き算が合わない`);
    assert.ok(r.filledHired <= r.alreadyHired, `${r.shopShortName} の充足が採用を超えている`);
  }
  // 超過がある場合、採用の総数は充足の総数より多くなる
  if (over.length > 0) assert.ok(total.alreadyHired > total.filledHired);
});

test("目標を超えて採れた校舎を作っても、合計が壊れない", () => {
  // 実データに超過が無くても壊れないよう、採用済みを水増しした計画で確かめる
  const one = shortageByShop(plan).find((s) => s.shortage > 0)!;
  const key = normalizeShopKey(one.shopShortName);
  const extra: Application[] = [...apps];
  const sample = apps[0];
  for (let i = 0; i < one.shortage + 2; i++) {
    extra.push({ ...sample, applicationId: `dummy-${i}`, shopShortName: one.shopShortName, statusId: "5", statusName: "採用" });
  }
  const g = monthlyGoals(extra, plan, DEFAULT_RATES, asOf);
  const t = g.total!;
  assert.equal(t.filledHired + t.remainingTarget, t.hireTarget);
  assert.ok(t.alreadyHired > t.filledHired);
  const row = g.rows.find((r) => normalizeShopKey(r.shopShortName) === key)!;
  assert.equal(row.remainingTarget, 0);
  assert.equal(row.filledHired, row.hireTarget);
});

test("期間中に採れた人は、その月の目標を減らさない", () => {
  // 10月に15名採れたのに10月の目標も15名のまま、という二重計上を防ぐ。
  // 月の目標は按分開始時点の残りから作るので、期間中の採用では動かない。
  const start = goals.window.from;
  const inWindow = hires.filter((h) => movedOn(h).slice(0, 7) >= start).length;
  if (inWindow > 0) {
    assert.ok(
      total.months.reduce((a, m) => a + m.targetHire, 0) > total.remainingTarget,
      "期間中の採用ぶん、月の目標の合計はいまの残りより多いはず"
    );
  }
  for (const r of goals.rows) {
    assert.equal(r.planRemaining, r.hireTarget - r.filledAtStart);
    assert.equal(
      r.months.reduce((a, m) => a + m.targetHire, 0),
      r.planRemaining,
      `${r.shopShortName} の月配分が計画と合わない`
    );
  }
});

test("表に載らなかった応募は、校舎名まで出せる", () => {
  const g = monthlyGoals(apps, plan, DEFAULT_RATES, asOf, undefined, everything);
  assert.equal(
    g.coverage.missing.reduce((a, m) => a + m.count, 0),
    g.coverage.all - g.coverage.inTable
  );
});
