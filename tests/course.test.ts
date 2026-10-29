import test from "node:test";
import assert from "node:assert/strict";
import { OTHER_COURSE, courseOfJobTitle } from "@/lib/recruiting/course";
import { DIMENSION_LABEL, breakdown, otherCourseTitles, shopCourseMatrix } from "@/lib/recruiting/aggregate";
import { Application } from "@/types/recruiting";

/**
 * 求人をコース別に分けたあとの応募数を取るテスト。
 *
 * 分ける前の求人は推測で3つに割らず、そのまま1つに置く。
 * ここが崩れると「ITの応募がいきなり増えた」ように見えてしまう。
 */

test("職種名の括弧からコースを取る", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師（Webデザイン）"), "Webデザイン");
  assert.equal(courseOfJobTitle("パソコンスクール講師（プログラミング）"), "IT");
  assert.equal(courseOfJobTitle("パソコンスクール講師（CAD）"), "CAD");
});

test("どのコースにも当てはまらない求人は「その他」に残す", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師"), OTHER_COURSE);
  assert.equal(courseOfJobTitle(""), OTHER_COURSE);
  assert.equal(courseOfJobTitle("スクール講師(OA/パソコンインストラクター)"), OTHER_COURSE);
});

test("職種名の書き方が変わっても拾う", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師 (WEBDTP)"), "Webデザイン");
  assert.equal(courseOfJobTitle("CADオペレーター講師"), "CAD");
  assert.equal(courseOfJobTitle("IT・DX研修講師"), "IT");
});

test("事務とPythonの求人は、それぞれのコースにする", () => {
  // 求人を分けたあとに増えた求人。足し忘れると「その他」に積み上がって、
  // 画面では「コースの分からない応募が増えた」ようにしか見えない。
  assert.equal(courseOfJobTitle("パソコンスクール講師（事務）"), "事務");
  assert.equal(courseOfJobTitle("パソコンスクール講師（Python）"), "Python");
  assert.equal(courseOfJobTitle("Pythonプログラミング講師"), "Python", "Pythonを先に見る");
  assert.equal(courseOfJobTitle("医療事務講師"), "事務");
});

test("「事務」を広く取りすぎない（旧求人を巻き込まない）", () => {
  // OA は3コースまとめ時代の求人名に入っているので、事務の判定には使わない
  assert.equal(courseOfJobTitle("スクール講師(OA/パソコンインストラクター)"), OTHER_COURSE);
  assert.equal(courseOfJobTitle("エンジニア研修講師(OA/パソコンインストラクター)"), "IT");
  // 「人事」は「事務」ではない
  assert.equal(courseOfJobTitle("パソコンスクール運営企業の人事・採用担当"), OTHER_COURSE);
});

test("コースはCAD→Webデザイン→ITの順に見る（Web CADのような名前で取り違えない）", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師（CAD・Web）"), "CAD");
});

function app(id: string, jobTitle: string): Application {
  return {
    applicationId: id,
    receivedAt: "2026-09-30T10:00:00.000Z",
    receivedDate: "2026-09-30",
    shopShortName: "栄校",
    shopName: "Winスクール 栄校",
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

test("コースを集計の軸として使える", () => {
  const rows = breakdown(
    [
      app("1", "パソコンスクール講師（Webデザイン）"),
      app("2", "パソコンスクール講師（Webデザイン）"),
      app("3", "パソコンスクール講師（プログラミング）"),
      app("4", "パソコンスクール講師"),
    ],
    "course"
  );
  const by = new Map(rows.map((r) => [r.key, r.applied]));
  assert.equal(by.get("Webデザイン"), 2);
  assert.equal(by.get("IT"), 1);
  assert.equal(by.get(OTHER_COURSE), 1);
  assert.equal(
    rows.reduce((a, r) => a + r.applied, 0),
    4,
    "どのコースにも入らない応募が消えていない"
  );
  assert.equal(DIMENSION_LABEL.course, "コース");
});

test("校舎 × コースの応募数が、どこを足しても合計に戻る", () => {
  const m = shopCourseMatrix([
    app("1", "パソコンスクール講師（Webデザイン）"),
    app("2", "パソコンスクール講師（CAD）"),
    app("3", "パソコンスクール講師"),
    { ...app("4", "パソコンスクール講師（プログラミング）"), shopShortName: "梅田校" },
  ]);

  assert.deepEqual(m.courses, ["IT", "Python", "Webデザイン", "CAD", "事務", OTHER_COURSE]);
  assert.equal(m.applied, 4);
  assert.equal(m.split, 3, "その他はコース別の小計に入れない");
  assert.equal(
    m.rows.reduce((a, r) => a + r.applied, 0),
    m.applied
  );
  assert.equal(
    m.courses.reduce((a, c) => a + m.totalByCourse[c], 0),
    m.applied
  );
  for (const r of m.rows) {
    assert.equal(
      m.courses.reduce((a, c) => a + r.byCourse[c], 0),
      r.applied,
      `${r.shopShortName} のコースごとの合計が応募数と合わない`
    );
    assert.equal(r.split + r.byCourse[OTHER_COURSE], r.applied);
  }

  const sakae = m.rows.find((r) => r.shopShortName === "栄校")!;
  assert.equal(sakae.byCourse["Webデザイン"], 1);
  assert.equal(sakae.byCourse["CAD"], 1);
  assert.equal(sakae.byCourse["IT"], 0, "応募が来ていないコースは0のまま");
  assert.equal(sakae.byCourse[OTHER_COURSE], 1);
});

test("コース別に数えられる期間は、最初に分割求人から応募が来た日から", () => {
  const before = { ...app("1", "パソコンスクール講師"), receivedDate: "2026-07-23" };
  const first = { ...app("2", "パソコンスクール講師（Webデザイン）"), receivedDate: "2026-09-30" };
  const last = { ...app("3", "パソコンスクール講師（CAD）"), receivedDate: "2026-10-13" };

  const m = shopCourseMatrix([before, last, first]);
  assert.equal(m.splitFrom, "2026-09-30", "分ける前の応募日は起点にしない");
  assert.equal(m.splitTo, "2026-10-13");

  const none = shopCourseMatrix([before]);
  assert.equal(none.splitFrom, null, "分割求人からの応募がまだ無ければ期間は出さない");
  assert.equal(none.splitTo, null);
});

test("「その他」の中身を職種名ごとに出せる", () => {
  // 何が「その他」に入っているか見えないと、足すべき判定に気付けない
  const rows = otherCourseTitles([
    app("1", "パソコンスクール講師"),
    app("2", "パソコンスクール講師"),
    app("3", "パソコンスクール運営企業の人事・採用担当"),
    app("4", "パソコンスクール講師（Python）"),
    app("5", "パソコンスクール講師（事務）"),
  ]);

  assert.deepEqual(rows, [
    { title: "パソコンスクール講師", applied: 2 },
    { title: "パソコンスクール運営企業の人事・採用担当", applied: 1 },
  ]);
});
