import * as XLSX from "xlsx";
import { HiringPlan } from "@/types/recruiting";
import { PLAN_CATEGORIES, SHOP_MASTER, normalizeShopKey } from "./shops";
import { shortageByShop } from "./plan";

/**
 * 採用チームが管理しているExcel（採用管理表）の「元データ」シートを読む。
 *
 * ジョブオプのエクスポートには分野（コース）が入っていないため、校舎ごとの人数までしか出せない。
 * こちらのシートには分野が入っているので、校舎 × コースで数えられる。
 *
 * 氏名・年齢・性別・評価コメントは読まない。集計に使う列だけを取り出す。
 * 人の判断で書かれた表なので、ジョブオプ側の数字とは必ずしも一致しない。
 * どちらが正しいかはこちらでは決められないので、両方を並べて見せる。
 */

/** 採用とみなすステータス。採用チームはここに「合格」と書いている。 */
const HIRED = new Set(["合格", "採用"]);

export interface HrRow {
  /** 「栄校」など。ジョブオプ側と突き合わせるときは normalizeShopKey を通す。 */
  shopShortName: string;
  /** IT / WEBDTP / CAD など、シートに書かれている分野そのまま。空欄は「(未記入)」。 */
  course: string;
  /**
   * コースの区分。IT / D/W（Webデザイン）/ C（CAD）/ none（分野が空欄）。
   * 区分を入れる前に取り込んだデータには無いので、読むときは必ず categoryOf を通す。
   */
  category?: HrCategory;
  status: string;
  hired: boolean;
  /** 応募日（YYYY-MM-DD）。読めなければ null。 */
  receivedDate: string | null;
}

export interface HrSheet {
  rows: HrRow[];
  sourceFileName: string;
  /** 取り込んだ時刻 */
  importedAt: string;
  /** 読み飛ばした行数（校舎が空など） */
  skipped: number;
}

function text(v: unknown): string {
  return String(v ?? "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

/**
 * 分野の表記ゆれを最小限だけ直す。
 * 勝手にまとめると実態が見えなくなるので、明らかな打ち間違いだけに留める。
 */
function course(raw: string): string {
  const t = text(raw).replace(/[？?]+$/, "");
  return t || "(未記入)";
}

/**
 * コースの区分。不足人数マスタの IT / D/W / C に、Excel側の未記入を足した4つ。
 *
 * 未記入を D/W に混ぜるとWebデザインの実績が実態より多く見えるので、列を分けて出す
 * （2026-10-12 カズヒコさん指示）。
 */
export type HrCategory = "IT" | "D/W" | "C" | "none";

export const HR_CATEGORIES: HrCategory[] = ["IT", "D/W", "C", "none"];

export const HR_CATEGORY_LABEL: Record<HrCategory, string> = {
  IT: "IT",
  "D/W": "Webデザイン",
  C: "CAD",
  none: "未記入",
};

/**
 * 分野を区分に寄せる。
 *
 * Excelの分野欄は WEBDTP / WEB / DTP / 映像 / Office … と細かく、校舎ごとに書き方も違う。
 * 採用目標は IT / Webデザイン / CAD の3区分で持っているので、そこに合わせないと
 * 「何がどれだけ足りないのか」と並べて見られない。
 *
 * IT と CAD だけを拾い、残りは D/W。空欄だけは寄せずに未記入のまま残す。
 */
export function courseCategory(raw: string): HrCategory {
  const t = course(raw).toUpperCase();
  if (t === "(未記入)") return "none";
  if (t.startsWith("IT")) return "IT";
  if (t.includes("CAD")) return "C";
  return "D/W";
}

/**
 * 行の区分を取る。
 *
 * 3区分に分ける前に取り込んだ行（保存済みのデータ・古いバックアップ・公開データ）には
 * category が入っていない。取り込み直しを強いると、その間だけ画面が壊れるので、
 * 無ければ分野から作り直す。
 */
export function categoryOf(row: HrRow): HrCategory {
  return row.category && HR_CATEGORIES.includes(row.category) ? row.category : courseCategory(row.course);
}

/** 「2026/10/07(水) 14:27」のような書き方から日付だけ取る */
function dateOf(raw: string): string | null {
  const m = text(raw).match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function parseHrSheet(fileName: string, buf: ArrayBuffer): HrSheet {
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", raw: false });
  const name = wb.SheetNames.find((n) => n.includes("元データ")) ?? wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { raw: false, defval: "" });

  const rows: HrRow[] = [];
  let skipped = 0;

  for (const r of grid) {
    const shop = text(r["スクール"]);
    if (!shop) {
      skipped++;
      continue;
    }
    const status = text(r["ステータス"]);
    const raw = String(r["分野"] ?? "");
    rows.push({
      shopShortName: shop,
      course: course(raw),
      category: courseCategory(raw),
      status: status || "(未記入)",
      hired: HIRED.has(status),
      receivedDate: dateOf(String(r["応募日時"] ?? "")),
    });
  }

  return { rows, sourceFileName: fileName, importedAt: new Date().toISOString(), skipped };
}

export interface HrCrossShop {
  /** 突き合わせ用のキー（normalizeShopKey 済み） */
  key: string;
  /** 表に出す校舎名。店舗マスタに当たれば正式な略称にそろえる。 */
  shopShortName: string;
  /** 区分ごとの採用数 */
  byCategory: Record<HrCategory, number>;
  total: number;
  applied: number;
}

export interface HrCross {
  /** 列。IT / D/W / C / 未記入 で固定する。 */
  categories: HrCategory[];
  /** 行（校舎）。採用が多い順。 */
  shops: HrCrossShop[];
  totalByCategory: Record<HrCategory, number>;
  /**
   * 区分それぞれに、Excelのどの分野が何件入ったか。
   * 「Webデザイン 13名」の中身が WEBDTP なのか映像なのかを、表の下に出すために持つ。
   */
  rawByCategory: Record<HrCategory, Record<string, number>>;
  total: number;
  totalApplied: number;
  /** 期間や対象校舎の条件で外した行数 */
  excluded: number;
}

const zero = (): Record<HrCategory, number> => ({ IT: 0, "D/W": 0, C: 0, none: 0 });

/** 店舗マスタに当たる校舎は正式な略称にそろえる（「福岡天神」と「福岡天神校」を1行にする） */
const MASTER_BY_KEY = new Map(SHOP_MASTER.map((s) => [normalizeShopKey(s.short), s.short]));

export interface CrossOptions {
  /** 応募日がこの日以降の行だけ数える */
  from?: string | null;
  /** 対象の校舎（normalizeShopKey 済みのキーで判定）。省略すると全校舎。 */
  include?: (key: string) => boolean;
}

/**
 * 校舎 × 分野 の集計。
 *
 * 校舎名は表記ゆれがあるので normalizeShopKey でまとめる。
 * 期間と対象校舎は画面の絞り込みに合わせて渡す（ここが画面と違うと、
 * 同じ画面の中でジョブオプ側と母数が変わって比べられなくなる）。
 */
export function crossTab(sheet: HrSheet, options: CrossOptions | string | null = null): HrCross {
  // 以前の呼び出し方（第2引数が開始日）も受ける
  const { from = null, include } = typeof options === "string" || options === null ? { from: options } : options;

  const byShop = new Map<string, HrCrossShop>();
  const totalByCategory = zero();
  const rawByCategory: Record<HrCategory, Record<string, number>> = { IT: {}, "D/W": {}, C: {}, none: {} };
  let excluded = 0;
  let total = 0;
  let totalApplied = 0;

  for (const r of sheet.rows) {
    if (from && r.receivedDate && r.receivedDate < from) {
      excluded++;
      continue;
    }
    const key = normalizeShopKey(r.shopShortName);
    if (include && !include(key)) {
      excluded++;
      continue;
    }

    let e = byShop.get(key);
    if (!e) {
      e = { key, shopShortName: MASTER_BY_KEY.get(key) ?? r.shopShortName, byCategory: zero(), total: 0, applied: 0 };
      byShop.set(key, e);
    }
    e.applied++;
    totalApplied++;
    if (!r.hired) continue;
    const cat = categoryOf(r);
    e.byCategory[cat]++;
    e.total++;
    total++;
    totalByCategory[cat]++;
    rawByCategory[cat][r.course] = (rawByCategory[cat][r.course] ?? 0) + 1;
  }

  return {
    categories: HR_CATEGORIES,
    shops: [...byShop.values()].sort(
      (a, b) => b.total - a.total || b.applied - a.applied || a.shopShortName.localeCompare(b.shopShortName, "ja")
    ),
    totalByCategory,
    rawByCategory,
    total,
    totalApplied,
    excluded,
  };
}

export interface HrCompareRow {
  shopShortName: string;
  /** Excel（採用チームの管理表）の採用数 */
  excel: number;
  /** ジョブオプのデータから数えた採用数 */
  jobop: number;
  diff: number;
}

/**
 * Excelとジョブオプの採用数を校舎ごとに並べる。
 * 数が合わないこと自体は珍しくない（判断のタイミングも、数え方の起点も違う）。
 * どこがどれだけ違うかを出して、確認の手掛かりにする。
 */
export function compareWithJobop(cross: HrCross, jobopByShop: Map<string, number>): HrCompareRow[] {
  const out = new Map<string, HrCompareRow>();

  for (const s of cross.shops) {
    out.set(s.key, { shopShortName: s.shopShortName, excel: s.total, jobop: jobopByShop.get(s.key) ?? 0, diff: 0 });
  }
  for (const [key, n] of jobopByShop) {
    if (!out.has(key)) out.set(key, { shopShortName: MASTER_BY_KEY.get(key) ?? key, excel: 0, jobop: n, diff: 0 });
  }

  return [...out.values()]
    .map((r) => ({ ...r, diff: r.excel - r.jobop }))
    .filter((r) => r.excel > 0 || r.jobop > 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.excel - a.excel);
}

/**
 * 不足人数管理表から、校舎 × コースの採用目標を作る。
 *
 * 管理表は 校舎 × コース × 時間帯（朝昼・夜・土日）の枠ごとに「不足」を持っていて、
 * ピンクで 1 と書かれているところが足りていない枠。
 *
 * **コースの目標は「不足のあるコースに1名」**。枠の数をそのまま分母にすると
 * 「IT 15 / 50」のようになり、1人が朝昼も夜も持つ実態と合わない。
 * 校舎の「最小採用人数（全分野充足）」も、ほとんどの校舎で不足のあるコース数と一致していて、
 * 1コースにつき1名を採る前提で置かれている。
 *
 * ただし一致しない校舎もある（1人に2コース持たせる前提で最小採用人数を減らしている校舎）。
 * 勝手に片方へ寄せると元の表と食い違うので、校舎の目標は最小採用人数のまま出し、
 * コース別の合計と差が出ることは画面に書いておく。
 */
export interface HrTargets {
  byShop: Map<string, { minHires: number; slots: number; byCategory: Record<HrCategory, number> }>;
  /** 校舎の最小採用人数の合計（＝不足人数マスタの採用目標・58名） */
  minHires: number;
  /** 不足している枠（校舎 × コース × 時間帯）の合計。説明用。 */
  slots: number;
  totalByCategory: Record<HrCategory, number>;
}

export function planTargets(plan: HiringPlan | null, include?: (key: string) => boolean): HrTargets | null {
  if (!plan) return null;

  const byShop = new Map<string, { minHires: number; slots: number; byCategory: Record<HrCategory, number> }>();
  const totalByCategory = zero();
  let minHires = 0;
  let slots = 0;

  for (const s of shortageByShop(plan)) {
    const key = normalizeShopKey(s.shopShortName);
    if (include && !include(key)) continue;

    const byCategory = zero();
    let shopSlots = 0;
    for (const c of PLAN_CATEGORIES) {
      byCategory[c] = s.byCategory[c] > 0 ? 1 : 0;
      totalByCategory[c] += byCategory[c];
      shopSlots += s.byCategory[c];
    }
    if (s.shortage === 0 && shopSlots === 0) continue;

    byShop.set(key, { minHires: s.shortage, slots: shopSlots, byCategory });
    minHires += s.shortage;
    slots += shopSlots;
  }

  return { byShop, minHires, slots, totalByCategory };
}
