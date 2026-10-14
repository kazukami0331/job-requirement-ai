import test from "node:test";
import assert from "node:assert/strict";
import { CourseFillRow, fillStatus, shortCourses } from "@/lib/recruiting/coursefill";

/**
 * 「人数は足りているが、埋まっていないコースがある」を充足と見ないためのテスト。
 *
 * 船橋のように IT を2名採った校舎は、CADがゼロのままでも校舎の人数では 3/3 になる。
 * ここが緑になると「もう採らなくていい」と読めてしまうので、色で分ける。
 */
function row(
  by: Partial<Record<"IT" | "D/W" | "C", [hired: number, target: number | null]>>,
  total: [hired: number, target: number | null]
): CourseFillRow {
  const cell = (hired = 0, target: number | null = null) => ({ applied: 0, hired, target });
  return {
    key: "テスト",
    shopShortName: "テスト校",
    byCourse: {
      IT: cell(...(by.IT ?? [0, null])),
      "D/W": cell(...(by["D/W"] ?? [0, null])),
      C: cell(...(by.C ?? [0, null])),
      none: cell(),
    },
    total: cell(...total),
    remaining: 0,
  };
}

test("人数は足りていてもコースが空なら充足にしない", () => {
  // 船橋：IT 3/1・Webデザイン 1/1・CAD 0/1 → 人数は 4/3 だがCADが空
  const r = row({ IT: [3, 1], "D/W": [1, 1], C: [0, 1] }, [4, 3]);
  assert.deepEqual(shortCourses(r), ["C"]);
  assert.equal(fillStatus(r), "headcount");
});

test("コースも含めて埋まったら充足", () => {
  const r = row({ IT: [1, 1], "D/W": [1, 1], C: [1, 1] }, [3, 3]);
  assert.deepEqual(shortCourses(r), []);
  assert.equal(fillStatus(r), "done");
});

test("まだ0名はnone、採れているが足りないときはprogress", () => {
  assert.equal(fillStatus(row({ IT: [0, 1], "D/W": [0, 1], C: [0, 1] }, [0, 3])), "none");
  assert.equal(fillStatus(row({ IT: [1, 1], "D/W": [0, 1], C: [0, 1] }, [1, 3])), "progress");
});

test("目標が無い校舎は、採れていれば充足として扱う", () => {
  assert.equal(fillStatus(row({}, [2, null])), "done");
  assert.equal(fillStatus(row({}, [0, null])), "none");
});
