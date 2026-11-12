import * as XLSX from "xlsx";
import type { CourseFill } from "./coursefill";
import { HR_CATEGORY_LABEL, HrCategory } from "./hrsheet";
import { normalizeShopKey } from "./shops";

/**
 * 求人の掲載ステータス（有料 / 無料）の表を読む。
 *
 * 知りたいのは「お金を払って出しているのに応募が来ていない枠」（2026-11-12 指示）。
 * 無料掲載で応募が無いのは当たり前だが、有料で0なら求人そのもの（文面・条件・エリア）を
 * 疑う話になる。同じ「応募0」でも打ち手が変わるので、画面の上で区別できるようにする。
 *
 * 表は 校舎 × 求人 のマス目に「有料」「無料」が入っている形を想定している。
 * 列の見出し（IT / Webデザイン / CAD / Python / APスクール事務 /
 * 業務委託・パソコンスクール講師 / オンラインカウンセラー …）は増減するので、
 * **見出しの文字からコースを判定する**。読めなかった見出しは捨てずに持ち帰って画面に出す。
 */

export type PostingState = "paid" | "free";

export const POSTING_LABEL: Record<PostingState, string> = { paid: "有料", free: "無料" };

export interface PostingCell {
  /** 同じコースに複数の求人列があるときは、1つでも有料なら有料にする */
  state: PostingState;
  /** もとの列の見出しと状態。画面のツールチップに出す */
  columns: { label: string; state: PostingState }[];
}

export interface PostingRow {
  shopShortName: string;
  /** コースごとの掲載ステータス。表に無いコースはキーを持たない（「無料」と「掲載なし」を混ぜない） */
  byCategory: Partial<Record<HrCategory, PostingCell>>;
}

export interface PostingSheet {
  rows: PostingRow[];
  sheetName: string;
  sourceFileName: string;
  importedAt: string;
  /** コースに結び付けた列の見出し */
  columns: string[];
  /** コースが分からず読み飛ばした列の見出し */
  unknownColumns: string[];
  /** 有料・無料のどちらでもない値（「停止」など）。取り込み後の案内に出す */
  otherValues: string[];
}

function text(v: unknown): string {
  return String(v ?? "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

const squeeze = (s: string) => s.replace(/[\s　]/g, "").toUpperCase();

/** 校舎名の列。「パソコンスクール講師」を校舎列と間違えないよう、見出しは完全一致で見る。 */
const SHOP_HEADERS = new Set(["校舎", "校舎名", "校舎略称", "教室", "スクール", "スクール名"]);

/** 校舎でもコースでもない列（読み飛ばす） */
const IGNORE_HEADERS = /^(確認|備考|メモ|補足|管理者|校舎ステータス|合計|日付|更新日|No|NO|#)$/;

/**
 * 列の見出しからコースを決める。採用管理表の「分野」とは語彙が違うので別に持つ。
 *
 * - Python はプログラミングの求人なので IT の枠として数える（校舎 × コースの表と同じ扱い）。
 * - 「業務委託／パソコンスクール講師」はコースを分ける前のまとめ求人なので「コース不明」に入れる。
 *   この求人からの応募はコースが分からず「コース不明」の列に入っているため、そこが対応する。
 */
export function categoryOfPostingColumn(header: string): HrCategory | null {
  const t = squeeze(header);
  if (!t || IGNORE_HEADERS.test(t)) return null;
  if (/カウンセラー|カウンセリング/.test(t)) return "カウンセラー";
  if (t.includes("CAD")) return "C";
  if (t.includes("PYTHON")) return "IT";
  if (/WEB|デザイン|DTP|映像/.test(t)) return "D/W";
  if (t.includes("事務")) return "事務";
  if (t.includes("OFFICE")) return "Office";
  if (/IT|プログラミング|エンジニア/.test(t)) return "IT";
  if (/講師|業務委託/.test(t)) return "none";
  return null;
}

/** マスの値。有料・無料以外は判断に使わない（空欄＝掲載なしと同じ扱い）。 */
export function stateOfCell(value: string): PostingState | null {
  const t = squeeze(value);
  if (!t) return null;
  if (t.includes("有料")) return "paid";
  if (t.includes("無料")) return "free";
  return null;
}

interface Candidate {
  name: string;
  header: number;
  shopCol: number;
  courseCols: { i: number; label: string; category: HrCategory }[];
  /** 見出しより下にある「有料 / 無料」の数。いちばん多いシートを本体と見る */
  score: number;
}

function candidates(wb: XLSX.WorkBook): Candidate[] {
  const out: Candidate[] = [];

  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "", raw: false });

    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const cols = (grid[i] ?? []).map((c) => text(c));
      const courseCols = cols
        .map((label, idx) => ({ i: idx, label, category: categoryOfPostingColumn(label) }))
        .filter((c): c is { i: number; label: string; category: HrCategory } => c.category !== null);
      // 1列だけ当たるのは偶然もあるので、2列以上そろった行を見出しとみなす
      if (courseCols.length < 2) continue;

      const shopHit = cols.findIndex((c) => SHOP_HEADERS.has(squeeze(c)) || SHOP_HEADERS.has(c));
      const shopCol = shopHit >= 0 ? shopHit : 0;
      if (courseCols.some((c) => c.i === shopCol)) continue;

      let score = 0;
      for (const raw of grid.slice(i + 1)) {
        for (const c of courseCols) if (stateOfCell(text(raw[c.i]))) score++;
      }
      out.push({ name, header: i, shopCol, courseCols, score });
      break;
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

export function parsePostingSheet(fileName: string, buf: ArrayBuffer): PostingSheet {
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", raw: false });
  const empty: PostingSheet = {
    rows: [],
    sheetName: "",
    sourceFileName: fileName,
    importedAt: new Date().toISOString(),
    columns: [],
    unknownColumns: [],
    otherValues: [],
  };

  const picked = candidates(wb).find((c) => c.score > 0) ?? candidates(wb)[0];
  if (!picked) return empty;

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[picked.name], { header: 1, defval: "", raw: false });
  const header = (grid[picked.header] ?? []).map((c) => text(c));
  const unknownColumns = header.filter(
    (c, i) =>
      c &&
      i !== picked.shopCol &&
      !picked.courseCols.some((x) => x.i === i) &&
      !IGNORE_HEADERS.test(squeeze(c))
  );

  const rows: PostingRow[] = [];
  const otherValues = new Set<string>();

  for (const raw of grid.slice(picked.header + 1)) {
    const shop = text(raw[picked.shopCol]);
    if (!shop || SHOP_HEADERS.has(squeeze(shop))) continue;

    const byCategory: Partial<Record<HrCategory, PostingCell>> = {};
    for (const c of picked.courseCols) {
      const value = text(raw[c.i]);
      const state = stateOfCell(value);
      if (!state) {
        if (value) otherValues.add(value);
        continue;
      }
      const cell = byCategory[c.category] ?? { state, columns: [] };
      // 同じコースに有料と無料の求人が両方あるときは有料を優先する。
      // 「お金を払っている枠に応募が来ているか」を見たいので、有料が隠れると意味が無い。
      if (state === "paid") cell.state = "paid";
      cell.columns.push({ label: c.label, state });
      byCategory[c.category] = cell;
    }

    if (Object.keys(byCategory).length === 0) continue;
    rows.push({ shopShortName: shop, byCategory });
  }

  return {
    rows,
    sheetName: picked.name,
    sourceFileName: fileName,
    importedAt: new Date().toISOString(),
    columns: picked.courseCols.map((c) => c.label),
    unknownColumns,
    otherValues: [...otherValues],
  };
}

/** 校舎キー × コースで引ける形にする。校舎名の表記ゆれは normalizeShopKey でそろえる。 */
export interface PostingIndex {
  at(shopKey: string, category: HrCategory): PostingCell | null;
  /** 有料の枠の数（表に出ているぶん全部） */
  paid: number;
  /** 校舎の数 */
  shops: number;
}

export function postingIndex(sheet: PostingSheet | null): PostingIndex | null {
  if (!sheet || sheet.rows.length === 0) return null;

  const map = new Map<string, Partial<Record<HrCategory, PostingCell>>>();
  let paid = 0;
  for (const r of sheet.rows) {
    const key = normalizeShopKey(r.shopShortName);
    const into = map.get(key) ?? {};
    for (const [cat, cell] of Object.entries(r.byCategory)) {
      if (!cell) continue;
      const prev = into[cat as HrCategory];
      into[cat as HrCategory] = prev
        ? {
            state: prev.state === "paid" || cell.state === "paid" ? "paid" : "free",
            columns: [...prev.columns, ...cell.columns],
          }
        : cell;
    }
    map.set(key, into);
    paid += Object.values(r.byCategory).filter((c) => c?.state === "paid").length;
  }

  return {
    at: (shopKey, category) => map.get(shopKey)?.[category] ?? null,
    paid,
    shops: map.size,
  };
}

export interface PaidGap {
  shopShortName: string;
  category: HrCategory;
  label: string;
}

/**
 * 有料で出しているのに応募が0の枠。これが「求人を直す」対象。
 *
 * 表に出ている校舎・コースだけを見る（表に無い校舎の有料枠は、応募数が分からないので数えない）。
 */
export function paidGaps(fill: CourseFill, index: PostingIndex): { paid: number; gaps: PaidGap[] } {
  const cats: HrCategory[] = [...fill.courses, "none"];
  let paid = 0;
  const gaps: PaidGap[] = [];

  for (const r of fill.rows) {
    for (const c of cats) {
      if (index.at(r.key, c)?.state !== "paid") continue;
      paid++;
      if (r.byCourse[c].applied === 0) {
        gaps.push({
          shopShortName: r.shopShortName,
          category: c,
          label: `${r.shopShortName} ${c === "none" ? "コース不明" : HR_CATEGORY_LABEL[c]}`,
        });
      }
    }
  }

  return { paid, gaps };
}
