import * as XLSX from "xlsx";
import { SHOP_MASTER, normalizeShopKey } from "./shops";

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
  /** IT / WEBDTP / CAD など、シートに書かれている分野。空欄は「(未記入)」。 */
  course: string;
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
    rows.push({
      shopShortName: shop,
      course: course(String(r["分野"] ?? "")),
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
  byCourse: Record<string, number>;
  total: number;
  applied: number;
}

export interface HrCross {
  /** 列（分野）。多い順。 */
  courses: string[];
  /** 行（校舎）。採用が多い順。 */
  shops: HrCrossShop[];
  totalByCourse: Record<string, number>;
  total: number;
  totalApplied: number;
  /** 期間や対象校舎の条件で外した行数 */
  excluded: number;
}

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
  const byCourse = new Map<string, number>();
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
      e = { key, shopShortName: MASTER_BY_KEY.get(key) ?? r.shopShortName, byCourse: {}, total: 0, applied: 0 };
      byShop.set(key, e);
    }
    e.applied++;
    totalApplied++;
    if (!r.hired) continue;
    e.byCourse[r.course] = (e.byCourse[r.course] ?? 0) + 1;
    e.total++;
    total++;
    byCourse.set(r.course, (byCourse.get(r.course) ?? 0) + 1);
  }

  const courses = [...byCourse.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(([c]) => c);

  return {
    courses,
    shops: [...byShop.values()].sort(
      (a, b) => b.total - a.total || b.applied - a.applied || a.shopShortName.localeCompare(b.shopShortName, "ja")
    ),
    totalByCourse: Object.fromEntries(byCourse),
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
