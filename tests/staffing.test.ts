import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parsePlacementSheet } from "@/lib/recruiting/placement";
import { parseHrSheet } from "@/lib/recruiting/hrsheet";
import { placementFieldOf, staffing } from "@/lib/recruiting/staffing";

/**
 * 委託講師配置表（不足）と採用管理表（合格者の時間帯）の突き合わせ。
 *
 * コースが合っていても入れる時間帯が違えばコマは埋まらない。
 * ここが崩れると「3名採ったのに土日が空いたまま」を見落とす。
 */

/** 一般充足シートを作る。見出しは実ファイルと同じく改行入り。 */
function placementOf(
  rows: { shop: string; it: [number, number, number]; web: [number, number, number]; cad: [number, number, number]; judgement?: string; need?: number }[]
) {
  const header = [
    "管理者",
    "校舎ステータス",
    "校舎名",
    "緊急度",
    "現状と方針",
    "多スキル講師",
    "IT\n【平日】",
    "IT\n【夜】",
    "IT\n【土日】",
    "WEB\n【平日】",
    "WEB\n【夜】",
    "WEB\n【土日】",
    "CAD\n【平日】",
    "CAD\n【夜】",
    "CAD\n【土日】",
    "合計",
    "一般充足判定",
    "不足数",
    "全分野募集停止",
  ];
  const grid = [
    ["新規採用者が1名約3日シフトに入れる場合の不足人数"],
    header,
    ...rows.map((r) => {
      const slots = [...r.it, ...r.web, ...r.cad];
      return [
        "山本",
        "存続校舎",
        r.shop,
        "",
        "",
        "募集中",
        ...slots,
        slots.reduce((a, b) => a + b, 0),
        r.judgement ?? "",
        r.need ?? 0,
        "",
      ];
    }),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), "一般充足");
  // 同じ形の別シートがあっても「一般充足」を選ぶ
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), "完全充足");
  return parsePlacementSheet("配置表.xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

function hrOf(rows: { school: string; course: string; status: string; 平日昼?: string; 平日夜?: string; 土日?: string }[]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      応募日時: "2026/10/01(木) 10:00",
      氏名: "テスト 太郎",
      スクール: r.school,
      ステータス: r.status,
      分野: r.course,
      平日昼: r.平日昼 ?? "",
      平日夜: r.平日夜 ?? "",
      土日: r.土日 ?? "",
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, "元データ");
  return parseHrSheet("採用管理表.xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

test("一般充足シートから、校舎 × 分野 × 時間帯の不足を読む", () => {
  const p = placementOf([{ shop: "仙台駅前", it: [1, 1, 1], web: [1, 1, 0], cad: [2, 1, 1], need: 7 }]);
  assert.equal(p.sheetName, "一般充足", "同じ形のシートが複数あっても一般充足を選ぶ");
  assert.equal(p.rows.length, 1);

  const r = p.rows[0];
  assert.equal(r.shopShortName, "仙台駅前");
  assert.equal(r.shortage.IT["平日昼"], 1);
  assert.equal(r.shortage.CAD["平日昼"], 2);
  assert.equal(r.shortage.WEB["土日"], 0);
  assert.equal(r.slots, 9, "合計は9コマ");
  assert.equal(r.needHires, 7, "不足数はシートの値をそのまま使う（こちらで計算し直さない）");
});

test("合格者は、入れる時間帯のコマだけ埋める", () => {
  const p = placementOf([{ shop: "仙台駅前", it: [1, 1, 1], web: [0, 0, 0], cad: [0, 0, 0], need: 2 }]);
  const hr = hrOf([
    // 平日夜だけ入れるIT講師。土日のコマは埋まらない。
    { school: "仙台駅前", course: "IT", status: "合格", 平日夜: "◯" },
    // 平日昼と土日に入れるIT講師
    { school: "仙台駅前", course: "IT", status: "合格", 平日昼: "◯", 土日: "◯" },
  ]);

  const s = staffing(p, hr);
  const r = s.rows[0];
  assert.equal(r.cells.IT["平日昼"].hired, 1);
  assert.equal(r.cells.IT["平日夜"].hired, 1);
  assert.equal(r.cells.IT["土日"].hired, 1);
  assert.equal(r.total.remaining, 0, "3コマとも埋まった");
  assert.equal(r.hiredPeople, 2, "人数は2名（1人が2コマに入る）");
});

test("時間帯が合わないと、採っても残る", () => {
  const p = placementOf([{ shop: "立川", it: [0, 0, 1], web: [0, 0, 0], cad: [0, 0, 0], need: 1 }]);
  const hr = hrOf([
    { school: "立川", course: "IT", status: "合格", 平日昼: "◯" },
    { school: "立川", course: "IT", status: "合格", 平日昼: "◯" },
  ]);

  const r = staffing(p, hr).rows[0];
  assert.equal(r.cells.IT["土日"].hired, 0);
  assert.equal(r.cells.IT["土日"].remaining, 1, "土日は空いたまま");
  assert.equal(r.cells.IT["平日昼"].hired, 2);
  assert.equal(r.cells.IT["平日昼"].remaining, 0, "不足の無い枠はマイナスにしない");
});

test("合格以外・期間外・時間帯の記入が無い人は数えない", () => {
  const p = placementOf([{ shop: "大宮", it: [1, 0, 0], web: [0, 0, 0], cad: [0, 0, 0], need: 1 }]);
  const hr = hrOf([
    { school: "大宮", course: "IT", status: "面接実施済", 平日昼: "◯" },
    { school: "大宮", course: "IT", status: "合格" },
  ]);

  const r = staffing(p, hr).rows[0];
  assert.equal(r.cells.IT["平日昼"].hired, 0, "選考中の人は数えない");
  assert.equal(r.hiredWithoutSlots, 1, "時間帯の記入が無い合格者は、推測で割り振らず別に数える");
  assert.equal(r.total.remaining, 1);

  const later = staffing(p, hr, { from: "2026-11-01" });
  assert.equal(later.rows[0].hiredPeople, 0, "期間より前の合格者は数えない");
});

test("配置表に枠の無い分野と校舎は、別に数える", () => {
  const p = placementOf([{ shop: "京都駅前", it: [1, 0, 0], web: [0, 0, 0], cad: [0, 0, 0], need: 1 }]);
  const hr = hrOf([
    { school: "京都駅前", course: "Office", status: "合格", 平日昼: "◯" },
    { school: "新宿本", course: "IT", status: "合格", 平日昼: "◯" },
  ]);

  const s = staffing(p, hr);
  assert.equal(s.rows[0].hiredOutsideFields, 1, "Officeは配置表に枠が無い");
  assert.equal(s.rows[0].cells.IT["平日昼"].hired, 0);
  assert.equal(s.unmatchedHires, 1, "配置表に無い校舎の採用は行を作らずに数える");
});

test("採用管理表の分野を、配置表の分野に寄せる", () => {
  assert.equal(placementFieldOf("IT"), "IT");
  assert.equal(placementFieldOf("WEB"), "WEB");
  assert.equal(placementFieldOf("WEBDTP"), "WEB");
  assert.equal(placementFieldOf("DTP"), "WEB");
  assert.equal(placementFieldOf("CAD"), "CAD");
  assert.equal(placementFieldOf("Office"), null, "配置表に枠が無い");
  assert.equal(placementFieldOf(""), null);
});

test("合計は、どこを足しても同じになる", () => {
  const p = placementOf([
    { shop: "仙台駅前", it: [1, 1, 1], web: [1, 0, 0], cad: [0, 0, 1], need: 4 },
    { shop: "立川", it: [1, 0, 0], web: [0, 1, 0], cad: [0, 0, 1], need: 3 },
  ]);
  const hr = hrOf([{ school: "立川", course: "CAD", status: "合格", 土日: "◯" }]);

  const s = staffing(p, hr);
  const sum = (f: (r: (typeof s.rows)[number]) => number) => s.rows.reduce((a, r) => a + f(r), 0);
  assert.equal(s.total.total.shortage, sum((r) => r.total.shortage));
  assert.equal(s.total.total.hired, sum((r) => r.total.hired));
  assert.equal(s.total.total.remaining, sum((r) => r.total.remaining));
  assert.equal(s.total.needHires, 7);
  assert.equal(
    s.total.total.shortage,
    (["平日昼", "平日夜", "土日"] as const).reduce((a, x) => a + s.total.bySlot[x].shortage, 0),
    "時間帯ごとの小計も合計に戻る"
  );
});
