import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { HrSheet, compareWithJobop, crossTab, parseHrSheet, planTargets } from "@/lib/recruiting/hrsheet";
import { DEFAULT_PLAN_LABELS, HiringPlan, PlanCategory, PlanRow } from "@/types/recruiting";

/** テスト用の不足人数マスタの行。使うのは校舎・区分・不足（groupC）・校舎計だけ。 */
function row(shop: string, category: PlanCategory, groupC: [number, number, number], shortage: number | null): PlanRow {
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
  assert.deepEqual(Object.keys(sheet.rows[0]).sort(), [
    "category",
    "course",
    "hired",
    "receivedDate",
    "shopShortName",
    "status",
  ]);
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
    cross.categories.reduce((a, c) => a + cross.totalByCategory[c], 0),
    cross.total
  );
  assert.equal(
    cross.shops.reduce((a, s) => a + s.applied, 0),
    cross.totalApplied
  );
  for (const s of cross.shops) {
    assert.equal(
      cross.categories.reduce((a, c) => a + s.byCategory[c], 0),
      s.total,
      `${s.shopShortName} の区分ごとの合計が採用数と合わない`
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

test("列は IT / D/W / C / 未記入 の4つで固定する", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.deepEqual(cross.categories, ["IT", "D/W", "C", "none"]);
});

test("分野の末尾の「？」が付いていても IT として数える", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.equal(cross.totalByCategory["IT"], 2, "福岡天神のITと北千住のIT？で2名");
  assert.deepEqual(cross.rawByCategory["IT"], { IT: 2 }, "「IT？」は「IT」に寄せる");
});

test("IT と CAD 以外は D/W に寄せる。分野が空欄の行だけは未記入として分ける", () => {
  const cross = crossTab(sheetOf(SAMPLE));
  assert.equal(cross.totalByCategory["D/W"], 1, "WEBDTPの1名だけ");
  assert.deepEqual(cross.rawByCategory["D/W"], { WEBDTP: 1 });
  assert.equal(cross.totalByCategory["none"], 1, "分野が空欄の1名はD/Wに混ぜない");
  assert.deepEqual(cross.rawByCategory["none"], { "(未記入)": 1 });
  assert.equal(cross.totalByCategory["C"], 0, "CADの応募はあるが採用には至っていない");
});

test("分野ごとの中身は、寄せる前の書き方のまま残す", () => {
  const sheet = sheetOf(SAMPLE);
  assert.equal(sheet.rows[2].course, "IT", "「IT？」は表記ゆれとして「IT」に寄せる");
  assert.equal(sheet.rows[2].category, "IT");
  assert.equal(sheet.rows[4].course, "(未記入)");
  assert.equal(sheet.rows[4].category, "none");
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

test("区分を入れる前に取り込んだデータでも壊れない", () => {
  const sheet = sheetOf(SAMPLE);
  // 保存済みのデータ・古いバックアップ・公開データには category が入っていない
  const old: HrSheet = { ...sheet, rows: sheet.rows.map(({ category, ...r }) => r) };
  const cross = crossTab(old);
  assert.equal(cross.total, 4);
  assert.equal(cross.totalByCategory["IT"], 2, "分野から区分を作り直す");
  assert.equal(cross.totalByCategory["D/W"], 1);
  assert.equal(cross.totalByCategory["none"], 1);
});

test("コースの目標は、不足のあるコースに1名ずつ置く", () => {
  const plan: HiringPlan = {
    labels: DEFAULT_PLAN_LABELS,
    updatedAt: "2026-10-12T00:00:00.000Z",
    rows: [
      // 朝昼・夜・土日のどこかに不足があれば、そのコースは1名必要
      row("豊田", "IT", [1, 1, 1], 2),
      row("豊田", "D/W", [1, 1, 1], null),
      row("豊田", "C", [0, 0, 0], null),
      row("梅田", "IT", [0, 1, 0], 3),
      row("梅田", "D/W", [0, 1, 0], null),
      row("梅田", "C", [0, 1, 0], null),
    ],
  };

  const t = planTargets(plan)!;
  assert.equal(t.byShop.get("豊田")?.byCategory["IT"], 1, "枠が3つあっても1名");
  assert.equal(t.byShop.get("豊田")?.byCategory["C"], 0, "不足が無いコースは0");
  assert.equal(t.byShop.get("梅田")?.byCategory["IT"], 1, "夜だけの不足でも1名");
  assert.deepEqual(t.totalByCategory, { IT: 2, "D/W": 2, C: 1, none: 0 });
  assert.equal(t.minHires, 5, "校舎の目標は最小採用人数のまま（豊田2＋梅田3）");
  assert.equal(t.slots, 9, "不足の枠数も説明用に持つ");
});

test("対象の校舎を絞ると、目標もその校舎だけになる", () => {
  const plan: HiringPlan = {
    labels: DEFAULT_PLAN_LABELS,
    updatedAt: "2026-10-12T00:00:00.000Z",
    rows: [row("豊田", "IT", [1, 0, 0], 1), row("梅田", "IT", [1, 0, 0], 1)],
  };
  const t = planTargets(plan, (key) => key === "豊田")!;
  assert.deepEqual([...t.byShop.keys()], ["豊田"]);
  assert.equal(t.minHires, 1);
});
