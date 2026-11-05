import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { shopCourseMatrix } from "@/lib/recruiting/aggregate";
import { OTHER_COURSE } from "@/lib/recruiting/course";
import { crossTab, parseHrSheet, planTargets } from "@/lib/recruiting/hrsheet";
import { courseFill } from "@/lib/recruiting/coursefill";
import { Application, HiringPlan, PlanCategory, PlanRow, DEFAULT_PLAN_LABELS } from "@/types/recruiting";

/**
 * 校舎 × コースの応募と採用を1つの表にまとめるテスト。
 *
 * 応募（ジョブオプ）と採用（採用チームのExcel）と目標（不足人数管理表）は
 * 校舎名の書き方が揃っていないので、ここが崩れると同じ校舎が2行に分かれる。
 * 「足りていないのに応募が来ていない校舎」を探す表なので、
 * 目標しか無い校舎（応募も採用も0）が落ちるのも困る。
 */

function app(id: string, jobTitle: string, shopShortName = "栄校"): Application {
  return {
    applicationId: id,
    receivedAt: "2026-09-30T10:00:00.000Z",
    receivedDate: "2026-09-30",
    shopShortName,
    shopName: `Winスクール ${shopShortName}`,
    shopId: "1106584",
    employmentType: "業務委託",
    employmentTypeCode: "3",
    jobTitle,
    media: "ジョブオプ",
    route: "Web",
    statusId: "1",
    statusName: "未対応",
    statusUpdatedAt: null,
    interviewStartAt: null,
    age: null,
    gender: null,
    rejectReason: null,
  };
}

function hrSheetOf(rows: { school: string; course: string; status: string }[]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      応募日時: "2026/09/01(火) 10:00",
      氏名: "テスト 太郎",
      スクール: r.school,
      ステータス: r.status,
      分野: r.course,
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, "元データ");
  return parseHrSheet("テスト.xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** 最小採用人数は結合セルなので、実ファイルでは校舎の先頭行（IT行）にだけ入っている。 */
function planRow(shop: string, category: PlanCategory, groupC: [number, number, number], shortage: number | null): PlanRow {
  return {
    id: `${shop}-${category}`,
    phase: "存続校舎",
    shopShortName: shop,
    category,
    groupA: [0, 0, 0],
    groupB: [0, 0, 0],
    groupC,
    shortage,
    deadline: "2026/12/31",
    flag: "",
    note: "",
    urgent: false,
  };
}

function planOf(rows: PlanRow[]): HiringPlan {
  return { rows, labels: DEFAULT_PLAN_LABELS, updatedAt: "2026-10-01T00:00:00.000Z" };
}

test("同じ校舎の応募と採用が1行に並ぶ（校舎名の表記ゆれをまとめる）", () => {
  const matrix = shopCourseMatrix([
    app("1", "パソコンスクール講師（Webデザイン）"),
    app("2", "パソコンスクール講師（プログラミング）"),
    app("3", "パソコンスクール講師"),
  ]);
  // Excel側は「栄」、ジョブオプ側は「栄校」
  const cross = crossTab(hrSheetOf([{ school: "栄", course: "IT", status: "合格" }]));

  const fill = courseFill(matrix, cross, null);
  assert.equal(fill.rows.length, 1, "表記ゆれで2行に分かれている");

  const r = fill.rows[0];
  assert.equal(r.shopShortName, "栄校", "店舗マスタの略称に揃える");
  assert.equal(r.byCourse.IT.applied, 1);
  assert.equal(r.byCourse.IT.hired, 1);
  assert.equal(r.byCourse["D/W"].applied, 1);
  assert.equal(r.byCourse["D/W"].hired, 0, "応募はあるが採れていないコースが0で出る");
  assert.equal(r.byCourse.none.applied, 1, "その他の応募はコース不明に置く");
  assert.equal(r.total.applied, 3);
  assert.equal(r.total.hired, 1);
});

test("コースごとの応募と採用を足すと、合計の列に戻る", () => {
  const matrix = shopCourseMatrix([
    app("1", "パソコンスクール講師（Webデザイン）"),
    app("2", "パソコンスクール講師（CAD）"),
    app("3", "パソコンスクール講師"),
    app("4", "パソコンスクール講師（プログラミング）", "梅田校"),
  ]);
  const cross = crossTab(
    hrSheetOf([
      { school: "栄校", course: "CAD", status: "合格" },
      { school: "栄校", course: "", status: "合格" },
      { school: "梅田校", course: "IT", status: "不採用" },
    ])
  );

  const fill = courseFill(matrix, cross, null);
  const all = [...fill.courses, "none" as const];

  for (const r of [...fill.rows, fill.totalRow]) {
    assert.equal(
      all.reduce((a, c) => a + r.byCourse[c].applied, 0),
      r.total.applied,
      `${r.shopShortName} の応募がコース別の合計と合わない`
    );
    assert.equal(
      all.reduce((a, c) => a + r.byCourse[c].hired, 0),
      r.total.hired,
      `${r.shopShortName} の採用がコース別の合計と合わない`
    );
  }

  assert.equal(fill.totalRow.total.applied, 4);
  assert.equal(fill.totalRow.total.hired, 2, "不採用は採用に数えない");
  assert.equal(fill.totalRow.byCourse.none.applied, 1);
  assert.equal(fill.totalRow.byCourse.none.hired, 1, "分野が未記入の採用はコース不明に置く");
});

test("目標しか無い校舎も行に出す（不足しているのに応募が来ていない校舎）", () => {
  const matrix = shopCourseMatrix([app("1", "パソコンスクール講師（Webデザイン）")]);
  const targets = planTargets(
    planOf([
      planRow("栄校", "IT", [0, 0, 0], 0),
      planRow("仙台駅前校", "IT", [1, 0, 0], 2),
      planRow("仙台駅前校", "D/W", [0, 1, 0], null),
    ])
  );

  const fill = courseFill(matrix, null, targets);
  const sendai = fill.rows.find((r) => r.shopShortName === "仙台駅前校");
  assert.ok(sendai, "応募も採用も無い校舎が落ちている");
  assert.equal(sendai!.total.applied, 0);
  assert.equal(sendai!.byCourse.IT.target, 1, "不足のあるコースに1名");
  assert.equal(sendai!.byCourse.C.target, 0, "不足の無いコースは0");
  assert.equal(sendai!.byCourse.none.target, null, "コース不明には目標を置かない");
  assert.equal(sendai!.total.target, 2, "合計の分母は最小採用人数");

  assert.equal(fill.rows[0].shopShortName, "仙台駅前校", "埋まっていない枠が多い校舎から並べる");
  assert.equal(sendai!.remaining, 2);
});

test("Excelが無いときは採用を0と言い切らない", () => {
  const matrix = shopCourseMatrix([app("1", "パソコンスクール講師（Webデザイン）")]);
  const fill = courseFill(matrix, null, null);

  assert.equal(fill.hasHires, false);
  assert.equal(fill.hasTargets, false);
  assert.equal(fill.rows[0].byCourse["D/W"].applied, 1);
  assert.equal(fill.rows[0].byCourse["D/W"].target, null);
});

test("コースを分ける前に応募した人が採用されると、応募より採用が多い列ができる", () => {
  const matrix = shopCourseMatrix([app("1", "パソコンスクール講師")]);
  const cross = crossTab(hrSheetOf([{ school: "栄校", course: "CAD", status: "合格" }]));
  const fill = courseFill(matrix, cross, null);

  const r = fill.rows[0];
  assert.equal(r.byCourse.C.applied, 0);
  assert.equal(r.byCourse.C.hired, 1, "採用はExcelの分野から数えるので、応募が0でも立つ");
  assert.equal(r.byCourse.none.applied, 1);
  assert.equal(r.total.applied, 1);
  assert.equal(r.total.hired, 1, "合計では応募と採用が食い違わない");
  assert.equal(OTHER_COURSE, "その他");
});
