import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { HrSheet, compareWithJobop, crossTab, parseHrSheet } from "@/lib/recruiting/hrsheet";

/**
 * 採用チームのExcel（採用管理表）から作る集計のテスト。
 *
 * この表はジョブオプ側の数字を置き換えるものではなく、隣に並べて差を見るためのもの。
 * だからこそ「合計がどこを足しても同じ」「校舎名の表記ゆれで二重に出ない」が崩れると、
 * 差の原因がこちらの集計バグなのか運用のずれなのか分からなくなる。
 */

/** テスト用の「元データ」シートを作る（実ファイルは候補者情報を含むのでリポジトリに置かない） */
function sheetOf(rows: { school: string; course: string; status: string; date: string }[]): HrSheet {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      応募日時: r.date,
      氏名: "テスト 太郎",
      年齢: 30,
      性別: "男性",
      スクール: r.school,
      ステータス: r.status,
      分野: r.course,
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, "元データ");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return parseHrSheet("テスト.xlsx", buf);
}

const SAMPLE = [
  { school: "福岡天神", course: "IT", status: "合格", date: "2026/08/01(土) 10:00" },
  { school: "福岡天神校", course: "WEBDTP", status: "合格", date: "2026/09/02(水) 10:00" },
  { school: "北千住校", course: "IT？", status: "合格", date: "2026/09/03(木) 10:00" },
  { school: "北千住校", course: "IT", status: "不採用", date: "2026/09/04(金) 10:00" },
  { school: "栄校", course: "", status: "合格", date: "2026/09/05(土) 10:00" },
  { school: "栄校", course: "CAD", status: "面接調整中", date: "2026/09/06(日) 10:00" },
];

test("氏名・年齢・性別は読み取らない", () => {
  const sheet = sheetOf(SAMPLE);
  const dumped = JSON.stringify(sheet);
  assert.equal(dumped.includes("テスト 太郎"), false);
  assert.equal(dumped.includes("男性"), false);
  assert.deepEqual(Object.keys(sheet.rows[0]).sort(), ["course", "hired", "receivedDate", "shopShortName", "status"]);
});

test("採用とみなすのは「合格」「採用」だけ", () => {
  const sheet = sheetOf(SAMPLE);
  assert.equal(sheet.rows.length, 6);
  assert.equal(sheet.rows.filter((r) => r.hired).length, 4);
});

test("校舎名の表記ゆれは1行にまとまる", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  const fukuoka = cross.shops.filter((s) => s.shopShortName.startsWith("福岡天神"));
  assert.equal(fukuoka.length, 1, "「福岡天神」と「福岡天神校」が別の行になっている");
  assert.equal(fukuoka[0].shopShortName, "福岡天神校", "店舗マスタの略称にそろえる");
  assert.equal(fukuoka[0].total, 2);
});

test("どこを足しても採用の合計に戻る", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.equal(
    cross.shops.reduce((a, s) => a + s.total, 0),
    cross.total
  );
  assert.equal(
    cross.courses.reduce((a, c) => a + (cross.totalByCourse[c] ?? 0), 0),
    cross.total
  );
  assert.equal(
    cross.shops.reduce((a, s) => a + s.applied, 0),
    cross.totalApplied
  );
  for (const s of cross.shops) {
    assert.equal(
      Object.values(s.byCourse).reduce((a, b) => a + b, 0),
      s.total,
      `${s.shopShortName} の分野ごとの合計が採用数と合わない`
    );
  }
});

test("期間で切ると、外した行数が除外として出る", () => {
  const sheet = sheetOf(SAMPLE);
  const all = crossTab(sheet);
  const sep = crossTab(sheet, "2026-09-01");
  assert.equal(all.total, 4);
  assert.equal(sep.total, 3, "8月の採用が1件外れる");
  assert.equal(sep.excluded, 1);
  assert.equal(sep.totalApplied + sep.excluded, all.totalApplied);
});

test("対象校舎の絞り込みは、画面と同じ条件で渡せる", () => {
  const sheet = sheetOf(SAMPLE);
  const only = crossTab(sheet, { include: (key) => key === "北千住" });
  assert.deepEqual(
    only.shops.map((s) => s.shopShortName),
    ["北千住校"]
  );
  assert.equal(only.totalApplied, 2);
  assert.equal(only.excluded, 4);
});

test("分野の末尾の「？」は同じコースとして数える", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.equal(cross.courses.includes("IT？"), false);
  assert.equal(cross.totalByCourse["IT"], 2, "福岡天神のITと北千住のIT？で2名");
});

test("分野が空欄の行は (未記入) にまとまる", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.equal(cross.totalByCourse["(未記入)"], 1);
});

test("ジョブオプとの比較は、片側しかない校舎も残す", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  const rows = compareWithJobop(
    cross,
    new Map([
      ["福岡天神", 3],
      ["横浜", 1],
    ])
  );
  const by = new Map(rows.map((r) => [r.shopShortName, r]));
  assert.equal(by.get("福岡天神校")?.excel, 2);
  assert.equal(by.get("福岡天神校")?.jobop, 3);
  assert.equal(by.get("福岡天神校")?.diff, -1);
  assert.equal(by.get("横浜校")?.excel, 0, "Excelに無くてもジョブオプ側にあれば出す");
  assert.equal(by.get("横浜校")?.jobop, 1);
  assert.equal(by.get("北千住校")?.jobop, 0, "ジョブオプ側に無くてもExcelにあれば出す");
  // 差の合計は、両者の採用数の差と一致する
  assert.equal(
    rows.reduce((a, r) => a + r.diff, 0),
    cross.total - 4
  );
});
