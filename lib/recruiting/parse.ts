import * as XLSX from "xlsx";
import { Application, Snapshot } from "@/types/recruiting";
import { STATUS_MASTER } from "./status";

/** ジョブオプのエクスポートで使われる列見出し */
const COL = {
  applicationId: ["応募ID"],
  receivedAt: ["応募受付日", "応募受付日時"],
  routeName: ["応募経路名"],
  shopId: ["店舗ID"],
  shopName: ["店舗名"],
  employmentTypeCode: ["雇用形態コード"],
  employmentType: ["雇用形態名", "掲載雇用形態名称"],
  statusId: ["選考ステータスID"],
  statusName: ["選考ステータス名"],
  statusUpdatedAt: ["選考ステータス最終更新日時"],
  interviewStartAt: ["面接開始日時"],
  rejectReason: ["不採用理由"],
  media: ["媒体名"],
  jobTitle: ["表示用職種名", "掲載職種名称", "応募職種名"],
  age: ["年齢"],
  gender: ["性別"],
} as const;

/**
 * ファイル全体を文字列として読む。
 * ジョブオプのCSVはShift_JIS(cp932)で出力されることがあるため、
 * UTF-8として読めなければcp932で読み直す。
 */
function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // UTF-8 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** "2026/09/16 15:14" などをISO8601に正規化する。解釈できなければnull。 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();

  const raw = String(value).trim();
  if (!raw) return null;

  // 2026/09/16 15:14 / 2026-09-16T15:14 / 2026.09.16 などを受ける
  const m = raw.match(
    /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0)
    );
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Excelのシリアル値
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const parsed = XLSX.SSF.parse_date_code(Number(raw));
    if (parsed) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S));
      return isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

/** ISO8601 → ローカル日付 YYYY-MM-DD */
export function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 「Winスクール 北千住校」→「北千住校」 */
export function shortenShopName(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.search(/[\s　]/);
  return idx > 0 ? trimmed.slice(idx + 1).trim() : trimmed;
}

type Row = Record<string, string>;

function pick(row: Row, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function readWorkbook(fileName: string, buf: ArrayBuffer): XLSX.WorkBook {
  if (/\.(csv|txt|tsv)$/i.test(fileName)) {
    return XLSX.read(decodeText(buf), { type: "string", raw: true });
  }
  return XLSX.read(new Uint8Array(buf), { type: "array", codepage: 932, raw: true });
}

/** ワークブックから応募データのシートを選ぶ（ジョブオプは "data" シート） */
function pickDataSheet(wb: XLSX.WorkBook): XLSX.WorkSheet {
  const named = wb.SheetNames.find((n) => n.toLowerCase() === "data");
  const target = named ?? wb.SheetNames[0];
  if (!target) throw new Error("シートが見つかりませんでした");
  return wb.Sheets[target];
}

export interface ParseResult {
  applications: Application[];
  /** 取り込めなかった行数（応募IDや受付日が欠けている行） */
  skipped: number;
  /** ファイルに含まれていた店舗マスタ（shopシート） */
  shops: { shopId: string; shopName: string }[];
}

/** ジョブオプの応募エクスポート（.xls / .xlsx / .csv）を正規化する */
export function parseJobOpsFile(fileName: string, buf: ArrayBuffer): ParseResult {
  const wb = readWorkbook(fileName, buf);
  const sheet = pickDataSheet(wb);
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { raw: false, defval: "" });

  const applications: Application[] = [];
  let skipped = 0;

  for (const row of rows) {
    const applicationId = pick(row, COL.applicationId);
    const receivedIso = toIso(pick(row, COL.receivedAt));
    if (!applicationId || !receivedIso) {
      skipped++;
      continue;
    }

    const statusId = pick(row, COL.statusId);
    const shopName = pick(row, COL.shopName);
    const ageRaw = pick(row, COL.age);

    applications.push({
      applicationId,
      receivedAt: receivedIso,
      receivedDate: isoToLocalDate(receivedIso),
      shopId: pick(row, COL.shopId),
      shopName,
      shopShortName: shortenShopName(shopName) || "(店舗不明)",
      employmentType: pick(row, COL.employmentType) || "(不明)",
      employmentTypeCode: pick(row, COL.employmentTypeCode),
      statusId,
      statusName: pick(row, COL.statusName) || STATUS_MASTER[statusId] || "(不明)",
      statusUpdatedAt: toIso(pick(row, COL.statusUpdatedAt)),
      interviewStartAt: toIso(pick(row, COL.interviewStartAt)),
      rejectReason: pick(row, COL.rejectReason) || null,
      media: pick(row, COL.media) || "(不明)",
      route: pick(row, COL.routeName) || "(不明)",
      jobTitle: pick(row, COL.jobTitle) || "(不明)",
      age: /^\d+$/.test(ageRaw) ? Number(ageRaw) : null,
      gender: pick(row, COL.gender) || null,
    });
  }

  // 店舗マスタ（任意）
  const shops: { shopId: string; shopName: string }[] = [];
  const shopSheetName = wb.SheetNames.find((n) => n.toLowerCase() === "shop");
  if (shopSheetName) {
    const shopRows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[shopSheetName], {
      raw: false,
      defval: "",
    });
    for (const r of shopRows) {
      const shopId = pick(r, ["店舗ID"]);
      const shopName = pick(r, ["ブランド+店舗名", "店舗名"]);
      if (shopId && shopName) shops.push({ shopId, shopName });
    }
  }

  return { applications, skipped, shops };
}

/** アップロードされたファイルからスナップショットを組み立てる */
export function buildSnapshot(fileName: string, buf: ArrayBuffer, takenAt?: Date): Snapshot & { skipped: number; shops: ParseResult["shops"] } {
  const { applications, skipped, shops } = parseJobOpsFile(fileName, buf);

  // 取得日時の既定値は「ファイル内の最新の更新日時」。
  // データ側の時点を基準にすることで、アップロードが遅れても週がずれない。
  const latest = applications.reduce<string | null>((acc, a) => {
    const candidates = [a.statusUpdatedAt, a.receivedAt].filter(Boolean) as string[];
    for (const c of candidates) if (!acc || c > acc) acc = c;
    return acc;
  }, null);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    takenAt: (takenAt ?? (latest ? new Date(latest) : new Date())).toISOString(),
    sourceFileName: fileName,
    applications,
    skipped,
    shops,
  };
}
