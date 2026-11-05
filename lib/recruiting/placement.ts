import * as XLSX from "xlsx";
import { SLOTS, SLOT_IN_SHEET, Slot, zeroSlots } from "./slots";

/**
 * 委託講師配置表の「一般充足」シートを読む。
 *
 * 採用のゴールはこのシートの**不足数が全部0になること**（2026-11-05 指示）。
 * 校舎 × 分野 × 時間帯 のコマごとに「あと何人分足りないか」が入っていて、
 * 右端に校舎ごとの判定（充足 / 空欄）と、必要な採用人数が入っている。
 *
 * 不足のコマ数（合計）と必要な採用人数（不足数）は別物で、
 * 「1名が約3日シフトに入れる」前提で人数に直されている。
 * こちらで計算し直すと元の表と食い違うので、**シートの数字をそのまま読む**。
 */

/** 配置表が持っている分野。採用管理表の「分野」より粗い（Officeなどの枠は無い）。 */
export const PLACEMENT_FIELDS = ["IT", "WEB", "CAD"] as const;

export type PlacementField = (typeof PLACEMENT_FIELDS)[number];

export const FIELD_LABEL: Record<PlacementField, string> = {
  IT: "IT",
  WEB: "Webデザイン",
  CAD: "CAD",
};

export interface PlacementRow {
  /** 「仙台駅前」。応募データと突き合わせるときは normalizeShopKey を通す。 */
  shopShortName: string;
  manager: string;
  /** 存続校舎 / FY28判断校舎 */
  shopStatus: string;
  /** 現状と方針（シートに書かれているコメント） */
  note: string;
  /** 分野 × 時間帯 の不足コマ数 */
  shortage: Record<PlacementField, Record<Slot, number>>;
  /** 不足コマの合計（シートの「合計」列） */
  slots: number;
  /** 一般充足判定。「充足」なら埋まっている。 */
  judgement: string;
  /** 不足数＝これから採る人数（シートの「不足数」列） */
  needHires: number;
  /** 全分野募集停止（STOP など）。空欄なら募集中。 */
  stop: string;
}

export interface PlacementSheet {
  rows: PlacementRow[];
  /** 読んだシート名 */
  sheetName: string;
  sourceFileName: string;
  importedAt: string;
  /** 読み飛ばした行数（校舎名が空など） */
  skipped: number;
}

function text(v: unknown): string {
  return String(v ?? "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 見出しの「IT\n【平日】」のような書き方から、分野と時間帯を取る */
function slotColumn(header: string): { field: PlacementField; slot: Slot } | null {
  const t = header.replace(/[\s　]/g, "");
  for (const field of PLACEMENT_FIELDS) {
    if (!t.startsWith(field)) continue;
    for (const slot of SLOTS) {
      if (t.includes(`【${SLOT_IN_SHEET[slot]}】`)) return { field, slot };
    }
  }
  return null;
}

const emptyShortage = (): Record<PlacementField, Record<Slot, number>> => ({
  IT: zeroSlots(),
  WEB: zeroSlots(),
  CAD: zeroSlots(),
});

/**
 * シートを選ぶ。既定は「一般充足」。
 *
 * 同じ形のシートが「完全充足」「最低条件」などいくつもあるので、
 * 名前で決め打ちせず、見出しの形（校舎名 ＋ IT【平日】）が合うシートの中から
 * 「一般充足」を優先する。名前が変わっても読めるようにするため。
 */
function pickSheet(wb: XLSX.WorkBook): { name: string; header: number; cols: string[] } | null {
  const candidates: { name: string; header: number; cols: string[] }[] = [];

  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", raw: false });
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const cols = (grid[i] ?? []).map((c) => text(c));
      const hasShop = cols.some((c) => c.replace(/[\s　]/g, "") === "校舎名");
      const hasSlot = cols.some((c) => slotColumn(c) !== null);
      if (hasShop && hasSlot) {
        candidates.push({ name, header: i, cols });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.find((c) => c.name.includes("一般充足")) ?? candidates[0];
}

export function parsePlacementSheet(fileName: string, buf: ArrayBuffer): PlacementSheet {
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", raw: false });
  const picked = pickSheet(wb);
  if (!picked) {
    return { rows: [], sheetName: "", sourceFileName: fileName, importedAt: new Date().toISOString(), skipped: 0 };
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[picked.name], { header: 1, defval: "", raw: false });
  const at = (name: string) =>
    picked.cols.findIndex((c) => c.replace(/[\s　]/g, "") === name);

  const col = {
    manager: at("管理者"),
    shopStatus: at("校舎ステータス"),
    shop: at("校舎名"),
    note: at("現状と方針"),
    slots: at("合計"),
    judgement: at("一般充足判定"),
    needHires: at("不足数"),
    stop: at("全分野募集停止"),
  };
  const slotCols = picked.cols
    .map((c, i) => ({ i, hit: slotColumn(c) }))
    .filter((x): x is { i: number; hit: { field: PlacementField; slot: Slot } } => x.hit !== null);

  const rows: PlacementRow[] = [];
  let skipped = 0;

  for (const raw of grid.slice(picked.header + 1)) {
    const shop = text(raw[col.shop]);
    if (!shop || shop === "校舎名") {
      skipped++;
      continue;
    }

    const shortage = emptyShortage();
    for (const { i, hit } of slotCols) shortage[hit.field][hit.slot] = num(raw[i]);
    const sum = PLACEMENT_FIELDS.reduce(
      (a, f) => a + SLOTS.reduce((b, s) => b + shortage[f][s], 0),
      0
    );

    rows.push({
      shopShortName: shop,
      manager: col.manager >= 0 ? text(raw[col.manager]) : "",
      shopStatus: col.shopStatus >= 0 ? text(raw[col.shopStatus]) : "",
      note: col.note >= 0 ? text(raw[col.note]) : "",
      shortage,
      // 「合計」列が空でも、コマを足せば出せる
      slots: col.slots >= 0 && text(raw[col.slots]) ? num(raw[col.slots]) : sum,
      judgement: col.judgement >= 0 ? text(raw[col.judgement]) : "",
      needHires: col.needHires >= 0 ? num(raw[col.needHires]) : 0,
      stop: col.stop >= 0 ? text(raw[col.stop]) : "",
    });
  }

  return {
    rows,
    sheetName: picked.name,
    sourceFileName: fileName,
    importedAt: new Date().toISOString(),
    skipped,
  };
}

/** 全校舎の不足数（これから採る人数）の合計 */
export function totalNeedHires(sheet: PlacementSheet | null): number {
  return sheet ? sheet.rows.reduce((a, r) => a + r.needHires, 0) : 0;
}

/** 全校舎の不足コマ数の合計 */
export function totalShortageSlots(sheet: PlacementSheet | null): number {
  return sheet ? sheet.rows.reduce((a, r) => a + r.slots, 0) : 0;
}
