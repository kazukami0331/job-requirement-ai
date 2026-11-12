import * as XLSX from "xlsx";
import { HiringPlan } from "@/types/recruiting";
import { PLAN_CATEGORIES, SHOP_MASTER, normalizeShopKey } from "./shops";
import { SLOTS, Slot } from "./slots";
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

/**
 * 採用の判定。
 *
 * **採否が決まるのは「面接結果2」列**（2026-11-05 確認）。
 * 「ステータス」列は選考の途中経過が残っていて、採否と一致しない。
 * 実ファイル392行で、ステータスが合格なのは79名、面接結果2が採用なのは100名。
 * ずれの中身は「面接結果2が採用なのにステータスが合格になっていない」が23名、
 * 「ステータスは合格のまま、面接結果2が辞退」が2名。CADは5名と7名で食い違っていた。
 *
 * ただし**I列（ステータス）に「採用」と書かれることもある**（2026-11-05 指示）。
 * どちらか片方にしか書かれていない運用があるので、**どちらかに採用と書いてあれば採用**とする。
 * 面接結果2が「辞退」「不採用」「不合格」のときだけは、ステータスが合格のままでも採用にしない
 * （合格のあとで辞退した人が、合格のまま残っているため）。
 */
/** 面接結果2 が採用で確定 */
const DECIDED_HIRED = "採用";
/** 面接結果2 がこれなら、ステータスが何であっても採用ではない */
const DECIDED_OUT = new Set(["辞退", "不採用", "不合格"]);
/** ステータス側で採用とみなす書き方 */
const HIRED = new Set(["合格", "採用"]);

/**
 * 採否を決める。
 * 面接結果2 の打ち消し（辞退・不採用・不合格）が最優先。
 * そのうえで、面接結果2 かステータスのどちらかに採用と書いてあれば採用。
 */
function isHired(status: string, decision: string): boolean {
  if (DECIDED_OUT.has(decision)) return false;
  return decision === DECIDED_HIRED || HIRED.has(status);
}

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
  /** 「ステータス」列。選考の途中経過。採否はこれでは決まらない。 */
  status: string;
  /** 「面接結果2」列。採用 / 不採用 / 辞退 / 不合格。採否はこちらで決まる。 */
  decision?: string;
  /** 採用日（YYYY-MM-DD）。「（採用日）」列。読めなければ null。 */
  hiredDate?: string | null;
  /** 面接日（YYYY-MM-DD）。「面接日」列。読めなければ null。 */
  interviewDate?: string | null;
  hired: boolean;
  /** 応募日（YYYY-MM-DD）。読めなければ null。 */
  receivedDate: string | null;
  /**
   * 採用後に入れる時間帯。採用管理表の W〜Y列（平日昼 / 平日夜 / 土日）に ◯ が付いていれば true。
   * 列が増える前に取り込んだデータには無いので、読むときは必ず slotsOf を通す。
   */
  slots?: Record<Slot, boolean>;
}

/** 時間帯の記入。◯ 以外（〇・○・1・✓）でも拾う。書き方は人によって揺れるため。 */
function slotMark(v: unknown): boolean {
  const t = String(v ?? "").trim();
  return t !== "" && t !== "0" && !/^[×x✕－-]$/i.test(t);
}

/** 行の時間帯。記入が無い（列が無かった頃のデータを含む）ときは全部 false。 */
export function slotsOf(row: HrRow): Record<Slot, boolean> {
  return row.slots ?? { 平日昼: false, 平日夜: false, 土日: false };
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
export type HrCategory = "IT" | "D/W" | "C" | "Office" | "事務" | "カウンセラー" | "none";

export const HR_CATEGORIES: HrCategory[] = ["IT", "D/W", "C", "Office", "事務", "カウンセラー", "none"];

export const HR_CATEGORY_LABEL: Record<HrCategory, string> = {
  IT: "IT",
  "D/W": "Webデザイン",
  C: "CAD",
  Office: "Office",
  事務: "事務",
  カウンセラー: "カウンセラー",
  // 分野が空欄の行はここ
  none: "その他・未記入",
};

/**
 * 分野を区分に寄せる。
 *
 * Excelの分野欄は WEBDTP / WEB / DTP / 映像 / Office … と細かく、校舎ごとに書き方も違う。
 * 採用目標は IT / Webデザイン / CAD の3区分で持っているので、そこに合わせないと
 * 「何がどれだけ足りないのか」と並べて見られない。
 *
 * IT と CAD だけを拾い、残りは D/W。空欄だけは寄せずに未記入のまま残す。
 * **WEBDTP と 映像 は Webデザイン でよい**（2026-10-14 確認）。
 *
 * ただし講師のコースでないものは D/W に混ぜない。
 * - Python … プログラミングの求人なので IT（2026-11-05、六本木オフィスで開始）
 * - Office … Officeスキルだけの講師求人を別に開いたので、別の区分にする（2026-11-05 指示）
 * - 事務 … 事務のアルバイトを別に開いたので、別の区分にする（2026-11-05 指示）
 * - カウンセラー … 講師ではないが、応募数を見たいので別の区分にする（2026-11-12 指示）。
 *   「オンラインカウンセラー」もここに入る。目標は無い
 */
export function courseCategory(raw: string): HrCategory {
  const t = course(raw).toUpperCase();
  if (t === "(未記入)") return "none";
  if (/カウンセラー|カウンセリング/.test(t)) return "カウンセラー";
  if (t.startsWith("IT") || t.includes("PYTHON")) return "IT";
  if (t.includes("CAD")) return "C";
  // 事務 を Office より先に見る（「事務（Officeスキル）」を事務として扱うため）
  if (t.includes("事務")) return "事務";
  if (t.includes("OFFICE")) return "Office";
  return "D/W";
}

/**
 * 行の区分を取る。
 *
 * 3区分に分ける前に取り込んだ行（保存済みのデータ・古いバックアップ・公開データ）には
 * category が入っていない。取り込み直しを強いると、その間だけ画面が壊れるので、
 * 無ければ分野から作り直す。
 */
/** 画面に出す採否。面接結果2があればそれ、無ければステータス。 */
export function decisionOf(row: HrRow): string {
  return row.decision || row.status;
}

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

/**
 * 面接日・採用日。「2026/10/15」とも「10/15」とも書かれている。
 *
 * 年が省かれているときは応募日の年を使い、応募日より前になってしまう場合だけ翌年にする
 * （採用は応募より後なので、12月応募・1月採用のような年またぎを拾うため）。
 */
function afterDateOf(raw: string, receivedDate: string | null): string | null {
  const full = dateOf(raw);
  if (full) return full;

  const m = String(raw).match(/^\s*(\d{1,2})[/\-月](\d{1,2})/);
  if (!m || !receivedDate) return null;
  const [, mo, d] = m;
  const year = Number(receivedDate.slice(0, 4));
  const made = `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return made >= receivedDate ? made : `${year + 1}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
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
    const decision = text(r["面接結果2"]);
    const raw = String(r["分野"] ?? "");
    const receivedDate = dateOf(String(r["応募日時"] ?? ""));
    rows.push({
      shopShortName: shop,
      course: course(raw),
      category: courseCategory(raw),
      status: status || "(未記入)",
      decision: decision || undefined,
      hiredDate: afterDateOf(String(r["（採用日）"] ?? r["採用日"] ?? ""), receivedDate),
      interviewDate: afterDateOf(String(r["面接日"] ?? ""), receivedDate),
      hired: isHired(status, decision),
      receivedDate,
      slots: Object.fromEntries(SLOTS.map((s) => [s, slotMark(r[s])])) as Record<Slot, boolean>,
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

const zero = (): Record<HrCategory, number> =>
  Object.fromEntries(HR_CATEGORIES.map((c) => [c, 0])) as Record<HrCategory, number>;

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
  const rawByCategory = Object.fromEntries(HR_CATEGORIES.map((c) => [c, {}])) as Record<
    HrCategory,
    Record<string, number>
  >;
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
  /** normalizeShopKey 済みのキー。片方にしか無い採用の明細と突き合わせるのに使う。 */
  key: string;
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
    out.set(s.key, { key: s.key, shopShortName: s.shopShortName, excel: s.total, jobop: jobopByShop.get(s.key) ?? 0, diff: 0 });
  }
  for (const [key, n] of jobopByShop) {
    if (!out.has(key)) out.set(key, { key, shopShortName: MASTER_BY_KEY.get(key) ?? key, excel: 0, jobop: n, diff: 0 });
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
 * **目標は「不足のあるコースに1名」**。枠の数をそのまま分母にすると
 * 「IT 15 / 50」のようになり、1人が朝昼も夜も持つ実態と合わない。
 *
 * 校舎の目標もコース別の積み上げにそろえる（2026-10-14 指示）。
 * シートの「最小採用人数（全分野充足）」は1人に2コース持たせる前提で減らしている校舎があるが、
 * その1人もコースごとに1名として数えてよいとのことなので、コース数のほうを目標にする。
 * 元の表と突き合わせられるよう、シートの合計は planMinHires として残す。
 */
export interface HrTargets {
  /** キーは normalizeShopKey 済み。shopShortName は管理表に書かれている校舎名。 */
  byShop: Map<string, { shopShortName: string; minHires: number; slots: number; byCategory: Record<HrCategory, number> }>;
  /** 校舎の目標の合計（＝不足のあるコースの数） */
  minHires: number;
  /** シートの「最小採用人数（全分野充足）」の合計。元の表と見比べるとき用。 */
  planMinHires: number;
  /** 不足している枠（校舎 × コース × 時間帯）の合計。説明用。 */
  slots: number;
  totalByCategory: Record<HrCategory, number>;
}

export function planTargets(plan: HiringPlan | null, include?: (key: string) => boolean): HrTargets | null {
  if (!plan) return null;

  const byShop = new Map<string, { shopShortName: string; minHires: number; slots: number; byCategory: Record<HrCategory, number> }>();
  const totalByCategory = zero();
  let minHires = 0;
  let planMinHires = 0;
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

    byShop.set(key, { shopShortName: s.shopShortName, minHires: s.shortage, slots: shopSlots, byCategory });
    minHires += s.shortage;
    planMinHires += s.planMinHires;
    slots += shopSlots;
  }

  return { byShop, minHires, planMinHires, slots, totalByCategory };
}
