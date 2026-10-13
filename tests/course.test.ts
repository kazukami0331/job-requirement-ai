import test from "node:test";
import assert from "node:assert/strict";
import { BEFORE_SPLIT, courseOfJobTitle } from "@/lib/recruiting/course";
import { DIMENSION_LABEL, breakdown } from "@/lib/recruiting/aggregate";
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

test("分ける前の求人はコース分け前として残す", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師"), BEFORE_SPLIT);
  assert.equal(courseOfJobTitle(""), BEFORE_SPLIT);
  assert.equal(courseOfJobTitle("スクール講師(OA/パソコンインストラクター)"), BEFORE_SPLIT);
});

test("職種名の書き方が変わっても拾う", () => {
  assert.equal(courseOfJobTitle("パソコンスクール講師 (WEBDTP)"), "Webデザイン");
  assert.equal(courseOfJobTitle("CADオペレーター講師"), "CAD");
  assert.equal(courseOfJobTitle("IT・DX研修講師"), "IT");
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
    shopId: "1106584",
    employmentType: "業務委託",
    jobTitle,
    media: "ジョブオプ",
    route: "Web",
    statusId: "1",
    statusLabel: "未対応",
    statusUpdatedAt: null,
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
  assert.equal(by.get(BEFORE_SPLIT), 1);
  assert.equal(
    rows.reduce((a, r) => a + r.applied, 0),
    4,
    "どのコースにも入らない応募が消えていない"
  );
  assert.equal(DIMENSION_LABEL.course, "コース");
});
