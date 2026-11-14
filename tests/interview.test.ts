import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { outcomeOf, parseHrSheet } from "@/lib/recruiting/hrsheet";
import { interviewWeeks } from "@/lib/recruiting/interview";

/**
 * 週ごとの面接数・内定数・合格率。
 *
 * 結果が書かれる列が3つある（ステータス・面接結果・面接結果2）ので、
 * どれを優先するかを間違えると、直近の週が全部「検討中」になったり、
 * まだ決まっていない「採用候補」が内定に混ざったりする。
 */

function hrOf(
  rows: { school: string; 面接日?: string; ステータス?: string; 面接結果?: string; 面接結果2?: string }[]
) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      応募日時: "2026/10/01 10:00",
      スクール: r.school,
      分野: "IT",
      ステータス: r.ステータス ?? "",
      面接日: r.面接日 ?? "",
      面接結果: r.面接結果 ?? "",
      面接結果2: r.面接結果2 ?? "",
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, "元データ");
  return parseHrSheet("採用管理表.xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

test("結果は 面接結果2 → ステータス → 面接結果 の順に見る", () => {
  const sheet = hrOf([
    { school: "A校", ステータス: "面接実施済", 面接結果: "不採用" },
    { school: "A校", ステータス: "面接実施済", 面接結果: "採用候補" },
    { school: "A校", ステータス: "面接実施済", 面接結果: "相談" },
    { school: "A校", ステータス: "合格", 面接結果: "採用候補" },
    { school: "A校", ステータス: "面接実施済", 面接結果2: "辞退" },
    // 書き換えは矢印の右を採る
    { school: "A校", ステータス: "面接実施済", 面接結果: "不採用＞採用" },
    { school: "A校", ステータス: "面接実施済", 面接結果: "相談＞不採用" },
    { school: "A校", ステータス: "面接実施済", 面接結果: "相談：不採用候補" },
  ]);
  assert.deepEqual(
    sheet.rows.map(outcomeOf),
    ["rejected", "pending", "pending", "hired", "declined", "hired", "rejected", "pending"]
  );
});

test("結果が何も書かれていなければ検討中", () => {
  const sheet = hrOf([{ school: "A校", ステータス: "面接実施済" }, { school: "A校" }]);
  assert.deepEqual(sheet.rows.map(outcomeOf), ["pending", "pending"]);
});

test("面接日の週ごとに数え、合格率は内定÷(内定+見送り)", () => {
  const sheet = hrOf([
    // 2026/11/2 は月曜。11/2〜11/8 が1つの週。
    { school: "A校", 面接日: "2026/11/02", ステータス: "合格" },
    { school: "A校", 面接日: "2026/11/05", ステータス: "面接実施済", 面接結果: "不採用" },
    { school: "A校", 面接日: "2026/11/08", ステータス: "面接実施済", 面接結果: "採用候補" },
    { school: "A校", 面接日: "2026/11/08", ステータス: "面接実施済", 面接結果2: "辞退" },
    // 翌週
    { school: "A校", 面接日: "2026/11/09", ステータス: "合格" },
    // 面接日が無い行は数えない
    { school: "A校", ステータス: "面接調整中" },
  ]);

  const stats = interviewWeeks(sheet, { today: new Date(2026, 10, 12) })!;
  assert.equal(stats.noDate, 1);

  const first = stats.rows.find((r) => r.week.start === "2026-11-02")!;
  assert.equal(first.interviews, 4);
  assert.deepEqual(first.byOutcome, { hired: 1, rejected: 1, declined: 1, pending: 1 });
  // 内定1 ÷ (内定1 + 見送り1) = 0.5。辞退と検討中は分母に入れない。
  assert.equal(first.rate, 0.5);
  // 面接数を分母にすると 1/4
  assert.equal(first.rateOfAll, 0.25);

  const second = stats.rows.find((r) => r.week.start === "2026-11-09")!;
  assert.equal(second.interviews, 1);
  assert.equal(second.rate, 1);

  assert.equal(stats.total.interviews, 5);
  assert.equal(stats.total.byOutcome.hired, 2);
  assert.equal(stats.total.rate, 2 / 3);
});

test("面接が0件の週も行として出す", () => {
  const sheet = hrOf([
    { school: "A校", 面接日: "2026/10/19", ステータス: "合格" },
    { school: "A校", 面接日: "2026/11/02", ステータス: "合格" },
  ]);
  const stats = interviewWeeks(sheet, { today: new Date(2026, 10, 12) })!;
  assert.deepEqual(
    stats.rows.map((r) => `${r.week.start}:${r.interviews}`),
    ["2026-10-19:1", "2026-10-26:0", "2026-11-02:1"]
  );
  // 間の週は判定が無いので率は null（0% と書くと「全員落ちた」に見える）
  assert.equal(stats.rows[1].rate, null);
});

test("これから面接する予定の数を分けて持つ", () => {
  const sheet = hrOf([
    { school: "A校", 面接日: "2026/11/10", ステータス: "面接実施済", 面接結果: "採用候補" },
    { school: "A校", 面接日: "2026/11/20", ステータス: "面接日決定" },
  ]);
  const stats = interviewWeeks(sheet, { today: new Date(2026, 10, 12) })!;
  assert.equal(stats.upcoming, 1);
  assert.equal(stats.total.interviews, 2);
});

test("対象校舎と期間の条件で外した行を数える", () => {
  const sheet = hrOf([
    { school: "A校", 面接日: "2026/10/05", ステータス: "合格" },
    { school: "B校", 面接日: "2026/11/02", ステータス: "合格" },
  ]);
  const stats = interviewWeeks(sheet, {
    from: "2026-10-26",
    include: (key) => key !== "B",
    today: new Date(2026, 10, 12),
  })!;
  assert.equal(stats.excluded, 2);
  assert.equal(stats.total.interviews, 0);
});
