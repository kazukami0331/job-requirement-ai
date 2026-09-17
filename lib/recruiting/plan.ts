import * as XLSX from "xlsx";
import {
  DEFAULT_PLAN_LABELS,
  HiringPlan,
  PlanCategory,
  PlanLabels,
  PlanRow,
} from "@/types/recruiting";
import { PLAN_CATEGORIES, SHOP_MASTER, normalizeShopKey } from "./shops";

/**
 * 採用計画（不足人数マスタ）の読み書き。
 *
 * 元シートは 校舎 × 講座区分(IT / D/W / C) の3行1組で、
 * 校舎名・フェーズ・校舎計の不足人数・期限は先頭行（IT行）にだけ入り、
 * 残り2行は結合セルで空になっている。取り込み時はそこを前方補完する。
 *
 * 列構成（0始まり）:
 *   0: フェーズ区分 / 1: 校舎名 / 2: 講座区分
 *   3-5: グループA / 6-8: グループB / 9-11: グループC（不足人数）
 *   12: 校舎計の不足人数 / 13: 期限 / 14: フラグ / 15: 備考
 */

const CATEGORY_SET = new Set<string>(PLAN_CATEGORIES);

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function cell(row: unknown[], i: number): string {
  return String(row[i] ?? "").trim();
}

function triple(row: unknown[], start: number): [number, number, number] {
  return [toNum(row[start]), toNum(row[start + 1]), toNum(row[start + 2])];
}

function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 見出し行からラベルを拾う。読めなければ既定ラベルのまま。 */
function readLabels(grid: unknown[][]): PlanLabels {
  const groupRow = grid[0] ?? [];
  const subRow = grid[1] ?? [];
  const use = (v: string, fallback: string) => {
    const t = v.replace(/\s+/g, " ").trim();
    // 文字化けで「?」だけになった見出しは採用しない
    return t && !/^[?\s]+$/.test(t) ? t : fallback;
  };

  return {
    groupA: use(cell(groupRow, 3), DEFAULT_PLAN_LABELS.groupA),
    groupB: use(cell(groupRow, 6), DEFAULT_PLAN_LABELS.groupB),
    groupC: use(cell(groupRow, 9), DEFAULT_PLAN_LABELS.groupC),
    sub: [
      use(cell(subRow, 3), DEFAULT_PLAN_LABELS.sub[0]),
      use(cell(subRow, 4), DEFAULT_PLAN_LABELS.sub[1]),
      use(cell(subRow, 5), DEFAULT_PLAN_LABELS.sub[2]),
    ],
    shortage: use(cell(subRow, 12), DEFAULT_PLAN_LABELS.shortage),
    deadline: use(cell(subRow, 13), DEFAULT_PLAN_LABELS.deadline),
    flag: use(cell(subRow, 14), DEFAULT_PLAN_LABELS.flag),
  };
}

/** 採用計画のCSV / Excelを取り込む */
export function parsePlanFile(fileName: string, buf: ArrayBuffer): HiringPlan {
  const wb = /\.(csv|txt|tsv)$/i.test(fileName)
    ? XLSX.read(decodeText(buf), { type: "string", raw: true })
    : XLSX.read(new Uint8Array(buf), { type: "array", codepage: 932, raw: true });

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });

  const labels = readLabels(grid);
  const rows: PlanRow[] = [];

  // 結合セルで空になっている校舎名・フェーズ・校舎計を前方補完する
  let phase = "";
  let shop = "";

  for (const raw of grid) {
    const category = cell(raw, 2);
    if (!CATEGORY_SET.has(category)) continue;

    if (cell(raw, 0)) phase = cell(raw, 0);
    if (cell(raw, 1)) shop = cell(raw, 1);
    if (!shop) continue;

    const shortageCell = cell(raw, 12);

    rows.push({
      id: `${phase}|${shop}|${category}`,
      phase,
      shopShortName: shop,
      category: category as PlanCategory,
      groupA: triple(raw, 3),
      groupB: triple(raw, 6),
      groupC: triple(raw, 9),
      shortage: shortageCell === "" ? null : toNum(shortageCell),
      deadline: cell(raw, 13),
      flag: cell(raw, 14),
      note: cell(raw, 15),
    });
  }

  return { labels, rows, updatedAt: new Date().toISOString() };
}

/** 全校舎 × 全区分をゼロで並べた空の採用計画 */
export function emptyPlan(phase = "今期"): HiringPlan {
  const rows: PlanRow[] = [];
  for (const shop of SHOP_MASTER) {
    for (const category of PLAN_CATEGORIES) {
      rows.push({
        id: `${phase}|${shop.short}|${category}`,
        phase,
        shopShortName: shop.short,
        category,
        groupA: [0, 0, 0],
        groupB: [0, 0, 0],
        groupC: [0, 0, 0],
        shortage: category === "IT" ? 0 : null,
        deadline: "",
        flag: "",
        note: "",
      });
    }
  }
  return { labels: { ...DEFAULT_PLAN_LABELS }, rows, updatedAt: new Date().toISOString() };
}

/** 採用計画を元と同じ16列レイアウトの二次元配列に戻す（スプレッドシート書き出し用） */
export function planToGrid(plan: HiringPlan): unknown[][] {
  const { labels } = plan;
  const grid: unknown[][] = [
    ["", "", "", labels.groupA, "", "", labels.groupB, "", "", labels.groupC, "", "", "", "", "", ""],
    [
      "フェーズ",
      "校舎",
      "講座区分",
      ...labels.sub,
      ...labels.sub,
      ...labels.sub,
      labels.shortage,
      labels.deadline,
      labels.flag,
      "備考",
    ],
  ];

  for (const r of plan.rows) {
    grid.push([
      r.phase,
      r.shopShortName,
      r.category,
      ...r.groupA,
      ...r.groupB,
      ...r.groupC,
      r.shortage ?? "",
      r.deadline,
      r.flag,
      r.note,
    ]);
  }
  return grid;
}

export interface ShopShortage {
  shopShortName: string;
  phase: string;
  /** 校舎計の不足人数（IT行の値、無ければグループCの合計） */
  shortage: number;
  /** 講座区分ごとのグループC合計 */
  byCategory: Record<PlanCategory, number>;
  deadline: string;
  note: string;
}

/** 校舎ごとに不足人数をまとめる */
export function shortageByShop(plan: HiringPlan): ShopShortage[] {
  const map = new Map<string, ShopShortage>();

  for (const r of plan.rows) {
    let entry = map.get(r.shopShortName);
    if (!entry) {
      entry = {
        shopShortName: r.shopShortName,
        phase: r.phase,
        shortage: 0,
        byCategory: { IT: 0, "D/W": 0, C: 0 },
        deadline: "",
        note: "",
      };
      map.set(r.shopShortName, entry);
    }
    entry.byCategory[r.category] += r.groupC.reduce((a, b) => a + b, 0);
    if (r.shortage !== null) entry.shortage += r.shortage;
    if (r.deadline) entry.deadline = r.deadline;
    if (r.note) entry.note = entry.note ? `${entry.note} / ${r.note}` : r.note;
  }

  // 校舎計が未入力なら区分ごとの不足人数の合計で代用する
  for (const entry of map.values()) {
    if (entry.shortage === 0) {
      const sum = Object.values(entry.byCategory).reduce((a, b) => a + b, 0);
      if (sum > 0) entry.shortage = sum;
    }
  }

  return [...map.values()].sort((a, b) => b.shortage - a.shortage || a.shopShortName.localeCompare(b.shopShortName, "ja"));
}

/** 応募データ側の校舎名 → 採用計画の不足人数 を引けるMapを作る */
export function shortageLookup(plan: HiringPlan): Map<string, ShopShortage> {
  const map = new Map<string, ShopShortage>();
  for (const entry of shortageByShop(plan)) {
    map.set(normalizeShopKey(entry.shopShortName), entry);
  }
  return map;
}

export function totalShortage(plan: HiringPlan): number {
  return shortageByShop(plan).reduce((a, b) => a + b.shortage, 0);
}
