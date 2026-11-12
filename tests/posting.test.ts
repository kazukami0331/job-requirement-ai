import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { courseFill } from "@/lib/recruiting/coursefill";
import {
  categoryOfPostingColumn,
  paidGaps,
  parsePostingSheet,
  postingIndex,
  stateOfCell,
} from "@/lib/recruiting/posting";

/**
 * 掲載ステータス（有料 / 無料）の取り込み。
 *
 * 見たいのは「お金を払って出しているのに応募0」なので、
 * 有料を無料や空欄に取り違えると、直すべき求人を見落とす。
 */

/** 校舎 × 求人 の表を作る。列の見出しは実ファイルの書き方に合わせる。 */
function sheetOf(
  header: string[],
  rows: (string | number)[][],
  sheetName = "掲載状況",
  extra?: { name: string; grid: (string | number)[][] }
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["11/5 時点"], header, ...rows]), sheetName);
  if (extra) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extra.grid), extra.name);
  return parsePostingSheet("掲載ステータス.xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const HEADER = [
  "校舎",
  "IT",
  "Webデザイン",
  "CAD",
  "Python",
  "APスクール事務",
  "業務委託/パソコンスクール講師",
  "オンラインカウンセラー",
  "確認",
];

test("列の見出しからコースを判定する", () => {
  assert.equal(categoryOfPostingColumn("IT"), "IT");
  assert.equal(categoryOfPostingColumn("Python"), "IT");
  assert.equal(categoryOfPostingColumn("Webデザイン"), "D/W");
  assert.equal(categoryOfPostingColumn("WEBDTP"), "D/W");
  assert.equal(categoryOfPostingColumn("CAD"), "C");
  assert.equal(categoryOfPostingColumn("APスクール事務"), "事務");
  assert.equal(categoryOfPostingColumn("Officeスキル講師"), "Office");
  assert.equal(categoryOfPostingColumn("オンラインカウンセラー"), "カウンセラー");
  // コースを分ける前のまとめ求人は「コース不明」。応募もそこに入っているため。
  assert.equal(categoryOfPostingColumn("業務委託/パソコンスクール講師"), "none");
  assert.equal(categoryOfPostingColumn("確認"), null);
  assert.equal(categoryOfPostingColumn("備考"), null);
  assert.equal(categoryOfPostingColumn(""), null);
});

test("マスの値は有料と無料だけを見る", () => {
  assert.equal(stateOfCell("有料"), "paid");
  assert.equal(stateOfCell(" 有料 "), "paid");
  assert.equal(stateOfCell("無料"), "free");
  assert.equal(stateOfCell(""), null);
  assert.equal(stateOfCell("〇"), null);
});

test("校舎 × コースの有料・無料を読む", () => {
  const sheet = sheetOf(HEADER, [
    ["札幌駅前", "無料", "無料", "有料", "", "", "無料", "", "済"],
    ["仙台駅前", "有料", "有料", "有料", "有料", "有料", "", "有料", ""],
  ]);

  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.sheetName, "掲載状況");
  assert.deepEqual(sheet.unknownColumns, []);

  const sapporo = sheet.rows[0];
  assert.equal(sapporo.byCategory.C?.state, "paid");
  assert.equal(sapporo.byCategory["D/W"]?.state, "free");
  // 空欄は「掲載なし」。無料として持たない。
  assert.equal(sapporo.byCategory.事務, undefined);
  assert.equal(sapporo.byCategory.カウンセラー, undefined);
  assert.equal(sapporo.byCategory.none?.state, "free");

  const sendai = sheet.rows[1];
  assert.equal(sendai.byCategory.IT?.state, "paid");
  assert.equal(sendai.byCategory.事務?.state, "paid");
  assert.equal(sendai.byCategory.カウンセラー?.state, "paid");
});

test("同じコースに有料と無料の求人があれば有料を優先する", () => {
  // IT の列が無料、Python の列が有料。どちらも IT の枠に入る。
  const sheet = sheetOf(HEADER, [["大宮", "無料", "", "", "有料", "", "", "", ""]]);
  const cell = sheet.rows[0].byCategory.IT;
  assert.equal(cell?.state, "paid");
  // どの求人が有料なのかは、画面のツールチップに出すため残す
  assert.deepEqual(cell?.columns, [
    { label: "IT", state: "free" },
    { label: "Python", state: "paid" },
  ]);
});

test("読めなかった列と値は捨てずに持ち帰る", () => {
  const sheet = sheetOf(
    ["校舎", "IT", "CAD", "電気電子", "エリア"],
    [["高崎", "有料", "停止", "有料", "関東"]]
  );
  // 「電気電子」も結び付くコースが無いので、読めなかった列として持ち帰る
  assert.deepEqual(sheet.unknownColumns, ["電気電子", "エリア"]);
  assert.deepEqual(sheet.otherValues, ["停止"]);
  // 「電気電子」はコースに結び付かないので、列として読まない
  assert.equal(sheet.columns.includes("電気電子"), false);
});

test("有料・無料がいちばん多いシートを本体として選ぶ", () => {
  const sheet = sheetOf(
    HEADER,
    [["町田", "有料", "有料", "有料", "", "", "", "", ""]],
    "掲載状況",
    // 同じ形だが中身が空のシート。こちらを選ぶと全部空になる。
    { name: "旧", grid: [HEADER, ["町田", "", "", "", "", "", "", "", ""]] }
  );
  assert.equal(sheet.sheetName, "掲載状況");
  assert.equal(sheet.rows[0].byCategory.IT?.state, "paid");
});

test("校舎名の表記ゆれをそろえて引ける", () => {
  const sheet = sheetOf(HEADER, [["福岡天神校", "有料", "", "", "", "", "", "", ""]]);
  const index = postingIndex(sheet)!;
  assert.equal(index.at("福岡天神", "IT")?.state, "paid");
  assert.equal(index.paid, 1);
  assert.equal(index.shops, 1);
});

test("有料なのに応募0の枠を拾う", () => {
  const matrix = {
    rows: [
      { shopShortName: "札幌駅前", applied: 3, byCourse: { IT: 3 } },
      { shopShortName: "仙台駅前", applied: 0, byCourse: {} },
    ],
    totalByCourse: { IT: 3 },
    applied: 3,
    split: 3,
    splitFrom: null,
    splitTo: null,
  } as unknown as Parameters<typeof courseFill>[0];

  const fill = courseFill(matrix, null, null);
  const index = postingIndex(
    sheetOf(HEADER, [
      ["札幌駅前", "有料", "", "", "", "", "", "", ""],
      ["仙台駅前", "有料", "有料", "", "", "", "", "", ""],
    ])
  )!;

  const { paid, gaps } = paidGaps(fill, index);
  assert.equal(paid, 3);
  // 札幌駅前のITは応募が来ているので対象外
  assert.deepEqual(
    gaps.map((g) => g.label).sort(),
    // 校舎名は店舗マスタの正式な略称にそろう
    ["仙台駅前校 IT", "仙台駅前校 Webデザイン"]
  );
});
