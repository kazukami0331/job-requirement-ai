import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBy, rubricCalibration } from "./analysis.ts";

const m = (impressions: number, clicks: number, conversions: number, date = "2026-10-05") => ({ date, impressions, clicks, spend: clicks * 100, conversions });

test("groupBy: 値ごとに表示・クリック率・応募率・応募単価を集計し、期間外と配信なしは数えない", () => {
  const cs = [
    { briefId: "a", k: "x", metrics: [m(1000, 20, 2), m(9999, 999, 9, "2026-01-01")] },
    { briefId: "b", k: "x", metrics: [m(1000, 10, 0)] },
    { briefId: "c", k: "y", metrics: [m(500, 5, 1)] },
    { briefId: "d", k: "z", metrics: [] },
  ];
  const rows = groupBy(cs, (c) => c.k, "2026-10-01");
  assert.deepEqual(rows.map((r) => r.key), ["x", "y"]);
  assert.equal(rows[0].impressions, 2000);
  assert.equal(rows[0].ctr, 1.5);
  assert.equal(rows[0].cvr, (2 / 30) * 100);
  assert.equal(rows[0].cpa, 1500);
});

test("rubricCalibration: 項目ごとに点数の帯で分ける", () => {
  const cs = [
    { briefId: "a", review: { score: 80, scores: { stop: 5 } }, metrics: [m(1000, 30, 3)] },
    { briefId: "b", review: { score: 60, scores: { stop: 2 } }, metrics: [m(1000, 10, 0)] },
  ];
  const [r] = rubricCalibration(cs, ["stop"], "2026-10-01");
  assert.deepEqual(r.rows.map((x) => x.key), ["1〜2点", "4〜5点"]);
  assert.equal(r.rows[1].ctr, 3);
});
