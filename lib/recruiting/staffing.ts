import { HrRow, HrSheet, slotsOf } from "./hrsheet";
import { PLACEMENT_FIELDS, PlacementField, PlacementRow, PlacementSheet } from "./placement";
import { SLOTS, Slot } from "./slots";
import { SHOP_MASTER, normalizeShopKey } from "./shops";

/**
 * 委託講師配置表の不足と、採用管理表の合格者を、**校舎 × 分野 × 時間帯**で突き合わせる。
 *
 * コースだけ見ていても埋まらない。平日夜しか入れない人を3人採っても、土日のコマは空いたまま。
 * 配置表はコマ単位で足りない数を持ち、採用管理表は1人ずつ入れる時間帯（W〜Y列）を持つので、
 * その2つを同じマスに並べる。
 *
 * **引き算の前提**：配置表の不足は、いま入っている講師を引いたあとの数。
 * 採用した人がまだ配置表に反映されていない場合に、残りがいくつになるかを出している。
 * すでに反映済みなら二重に引くことになるので、画面にその旨を書いておく。
 */

/** 採用管理表の「分野」を、配置表の分野に寄せる。Office・英語などは配置表に枠が無い。 */
export function placementFieldOf(course: string): PlacementField | null {
  const t = course.replace(/[\s　]/g, "").toUpperCase();
  if (!t || t === "(未記入)") return null;
  if (t.includes("CAD")) return "CAD";
  if (t.startsWith("IT")) return "IT";
  if (/WEB|DTP|デザイン|映像/.test(t)) return "WEB";
  return null;
}

export interface StaffingCell {
  /** 配置表の不足コマ */
  shortage: number;
  /** その枠に入れる合格者の人数 */
  hired: number;
  /** 残りコマ。マイナスにはしない。 */
  remaining: number;
}

export interface StaffingRow {
  /** normalizeShopKey 済み */
  key: string;
  shopShortName: string;
  manager: string;
  shopStatus: string;
  note: string;
  /** 一般充足判定（シートの値） */
  judgement: string;
  /** 不足数＝これから採る人数（シートの値） */
  needHires: number;
  /** 全分野募集停止 */
  stop: string;
  cells: Record<PlacementField, Record<Slot, StaffingCell>>;
  byField: Record<PlacementField, StaffingCell>;
  bySlot: Record<Slot, StaffingCell>;
  total: StaffingCell;
  /** この校舎の合格者の人数（配置表に枠の無い分野も含む） */
  hiredPeople: number;
  /** 分野が配置表に無い合格者（Office・英語・未記入など） */
  hiredOutsideFields: number;
  /** 時間帯がどこも記入されていない合格者。埋まる枠が分からないので別に数える。 */
  hiredWithoutSlots: number;
}

export interface Staffing {
  rows: StaffingRow[];
  total: StaffingRow;
  /** 配置表に無い校舎で採用があった場合の人数 */
  unmatchedHires: number;
  /** 配置表を取り込んでいるか */
  hasPlacement: boolean;
  /** 採用管理表を取り込んでいるか */
  hasHires: boolean;
}

const MASTER_BY_KEY = new Map(SHOP_MASTER.map((s) => [normalizeShopKey(s.short), s.short]));

const emptyCell = (): StaffingCell => ({ shortage: 0, hired: 0, remaining: 0 });

const emptyCells = (): Record<PlacementField, Record<Slot, StaffingCell>> =>
  Object.fromEntries(
    PLACEMENT_FIELDS.map((f) => [f, Object.fromEntries(SLOTS.map((s) => [s, emptyCell()]))])
  ) as Record<PlacementField, Record<Slot, StaffingCell>>;

const emptyByField = (): Record<PlacementField, StaffingCell> =>
  Object.fromEntries(PLACEMENT_FIELDS.map((f) => [f, emptyCell()])) as Record<PlacementField, StaffingCell>;

const emptyBySlot = (): Record<Slot, StaffingCell> =>
  Object.fromEntries(SLOTS.map((s) => [s, emptyCell()])) as Record<Slot, StaffingCell>;

function emptyRow(key: string, shopShortName: string): StaffingRow {
  return {
    key,
    shopShortName,
    manager: "",
    shopStatus: "",
    note: "",
    judgement: "",
    needHires: 0,
    stop: "",
    cells: emptyCells(),
    byField: emptyByField(),
    bySlot: emptyBySlot(),
    total: emptyCell(),
    hiredPeople: 0,
    hiredOutsideFields: 0,
    hiredWithoutSlots: 0,
  };
}

export interface StaffingOptions {
  /** 採用日（無ければ応募日）がこの日以降の合格者だけ数える */
  from?: string | null;
  /** 対象の校舎（normalizeShopKey 済みのキーで判定） */
  include?: (key: string) => boolean;
}

/** 行の小計をとり直す。コマを足し込んだあとに呼ぶ。 */
function roll(row: StaffingRow) {
  row.byField = emptyByField();
  row.bySlot = emptyBySlot();
  row.total = emptyCell();
  for (const f of PLACEMENT_FIELDS) {
    for (const s of SLOTS) {
      const c = row.cells[f][s];
      c.remaining = Math.max(0, c.shortage - c.hired);
      for (const into of [row.byField[f], row.bySlot[s], row.total]) {
        into.shortage += c.shortage;
        into.hired += c.hired;
        into.remaining += c.remaining;
      }
    }
  }
}

export function staffing(
  placement: PlacementSheet | null,
  hrSheet: HrSheet | null,
  options: StaffingOptions = {}
): Staffing {
  const { from = null, include } = options;
  const rows = new Map<string, StaffingRow>();

  const row = (key: string, fallbackName: string): StaffingRow => {
    let r = rows.get(key);
    if (!r) {
      r = emptyRow(key, MASTER_BY_KEY.get(key) ?? fallbackName);
      rows.set(key, r);
    }
    return r;
  };

  for (const p of placement?.rows ?? []) {
    const key = normalizeShopKey(p.shopShortName);
    if (include && !include(key)) continue;
    const r = row(key, p.shopShortName);
    fillFromPlacement(r, p);
  }

  let unmatchedHires = 0;

  for (const h of hrSheet?.rows ?? []) {
    if (!h.hired) continue;
    // 「この期間に採った人」なので、採用日があればそれで切る（無ければ応募日）
    const on = h.hiredDate ?? h.receivedDate;
    if (from && on && on < from) continue;
    const key = normalizeShopKey(h.shopShortName);
    if (include && !include(key)) continue;
    if (!rows.has(key)) {
      // 配置表に無い校舎。勝手に行を作ると「不足0なのに採用だけある」行が並ぶので、件数だけ持つ。
      unmatchedHires++;
      continue;
    }
    countHire(rows.get(key)!, h);
  }

  const list = [...rows.values()];
  for (const r of list) roll(r);

  list.sort(
    (a, b) =>
      b.total.remaining - a.total.remaining ||
      b.needHires - a.needHires ||
      a.shopShortName.localeCompare(b.shopShortName, "ja")
  );

  const total = emptyRow("(合計)", "合計");
  for (const r of list) {
    for (const f of PLACEMENT_FIELDS) {
      for (const s of SLOTS) {
        total.cells[f][s].shortage += r.cells[f][s].shortage;
        total.cells[f][s].hired += r.cells[f][s].hired;
      }
    }
    total.needHires += r.needHires;
    total.hiredPeople += r.hiredPeople;
    total.hiredOutsideFields += r.hiredOutsideFields;
    total.hiredWithoutSlots += r.hiredWithoutSlots;
  }
  roll(total);

  return {
    rows: list,
    total,
    unmatchedHires,
    hasPlacement: (placement?.rows.length ?? 0) > 0,
    hasHires: (hrSheet?.rows.length ?? 0) > 0,
  };
}

function fillFromPlacement(r: StaffingRow, p: PlacementRow) {
  r.manager = p.manager;
  r.shopStatus = p.shopStatus;
  r.note = p.note;
  r.judgement = p.judgement;
  r.needHires = p.needHires;
  r.stop = p.stop;
  for (const f of PLACEMENT_FIELDS) {
    for (const s of SLOTS) r.cells[f][s].shortage += p.shortage[f][s];
  }
}

function countHire(r: StaffingRow, h: HrRow) {
  r.hiredPeople++;
  const field = placementFieldOf(h.course);
  if (!field) {
    r.hiredOutsideFields++;
    return;
  }
  const slots = slotsOf(h);
  const marked = SLOTS.filter((s) => slots[s]);
  if (marked.length === 0) {
    // 時間帯の記入が無いと、どのコマが埋まるか決められない。推測で割り振らない。
    r.hiredWithoutSlots++;
    return;
  }
  for (const s of marked) r.cells[field][s].hired++;
}
