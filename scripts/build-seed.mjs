/**
 * 初期表示用のシードデータを作る。
 *
 * ダッシュボードの保存先はブラウザのIndexedDBなので、初めて開いた人の画面は空になる。
 * すでに受け取っている分をアプリに同梱して、URLを開いた時点で中身が見えるようにする。
 *
 * 使い方:
 *   node scripts/build-seed.mjs <応募エクスポート> [不足人数管理表] > /dev/null
 *
 * 個人情報（氏名・連絡先・住所など）は元から取り込んでおらず、
 * 年齢・性別も集計に使っていないためシードには含めない。
 */
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const OUT = "public/seed/initial.json";

const pad = (n) => String(n).padStart(2, "0");

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  const raw = String(value).trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function shortenShopName(name) {
  const t = name.trim();
  const i = t.search(/[\s　]/);
  return i > 0 ? t.slice(i + 1).trim() : t;
}

const pick = (row, keys) => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

function parseApplications(file) {
  const wb = XLSX.read(new Uint8Array(readFileSync(file)), { type: "array", codepage: 932, raw: true });
  const name = wb.SheetNames.find((n) => n.toLowerCase() === "data") ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { raw: false, defval: "" });

  const applications = [];
  for (const row of rows) {
    const applicationId = pick(row, ["応募ID"]);
    const receivedAt = toIso(pick(row, ["応募受付日", "応募受付日時"]));
    if (!applicationId || !receivedAt) continue;

    const shopName = pick(row, ["店舗名"]);
    const statusId = pick(row, ["選考ステータスID"]);
    const d = new Date(receivedAt);

    applications.push({
      applicationId,
      receivedAt,
      receivedDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      shopId: pick(row, ["店舗ID"]),
      shopName,
      shopShortName: shortenShopName(shopName) || "(店舗不明)",
      employmentType: pick(row, ["雇用形態名", "掲載雇用形態名称"]) || "(不明)",
      employmentTypeCode: pick(row, ["雇用形態コード"]),
      statusId,
      statusName: pick(row, ["選考ステータス名"]) || "(不明)",
      statusUpdatedAt: toIso(pick(row, ["選考ステータス最終更新日時"])),
      interviewStartAt: toIso(pick(row, ["面接開始日時"])),
      rejectReason: pick(row, ["不採用理由"]) || null,
      media: pick(row, ["媒体名"]) || "(不明)",
      route: pick(row, ["応募経路名"]) || "(不明)",
      jobTitle: pick(row, ["表示用職種名", "掲載職種名称", "応募職種名"]) || "(不明)",
      // 年齢・性別は集計に使っていないのでシードには含めない
      age: null,
      gender: null,
    });
  }

  const latest = applications.reduce((acc, a) => {
    for (const c of [a.statusUpdatedAt, a.receivedAt].filter(Boolean)) if (!acc || c > acc) acc = c;
    return acc;
  }, null);

  return {
    id: `seed-${applications.length}`,
    takenAt: latest ?? new Date().toISOString(),
    sourceFileName: basename(file),
    applications,
  };
}

const CATEGORIES = new Set(["IT", "D/W", "C"]);
const sheet_ref = (wb, name) => wb.Sheets[name]["!ref"] ?? "A1";
const cell = (r, i) => String(r[i] ?? "").trim();
const toNum = (v) => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : 0; };

function dateCell(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}/${pad(v.getMonth() + 1)}/${pad(v.getDate())}`;
  if (typeof v === "number" && v > 20000 && v < 90000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}/${pad(d.m)}/${pad(d.d)}`;
  }
  return String(v ?? "").trim();
}

function isFilled(sheet, address) {
  const style = sheet[address]?.s;
  if (!style || style.patternType !== "solid") return false;
  const raw = String(style.fgColor?.rgb ?? "").toUpperCase();
  if (!raw) return false;
  const hex = raw.length === 8 ? raw.slice(2) : raw;
  return !/^(FFFFFF|000000)$/.test(hex);
}

function parsePlan(file) {
  const wb = XLSX.read(new Uint8Array(readFileSync(file)), { type: "array", codepage: 932, cellDates: true, cellStyles: true });
  const name = wb.SheetNames.find((n) => n.includes("不足人数")) ?? wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });

  const use = (v, f) => { const t = v.replace(/\s+/g, " ").trim(); return t && !/^[?\s]+$/.test(t) ? t : f; };
  const g = grid[0] ?? [], s = grid[1] ?? [];
  const labels = {
    groupA: use(cell(g, 3), "既存"),
    groupB: use(cell(g, 6), "新規採用"),
    groupC: use(cell(g, 9), "不足"),
    sub: [use(cell(s, 3), "朝昼"), use(cell(s, 4), "夜"), use(cell(s, 5), "土日")],
    shortage: use(cell(s, 12), "最小採用人数"),
    deadline: use(cell(s, 13), "社員最終勤務日"),
    flag: use(cell(s, 14), "元社員PT"),
    note: use(cell(s, 15), "応援PT"),
  };

  const rows = [];
  const origin = XLSX.utils.decode_range(sheet_ref(wb, name));
  let phase = "", shop = "", urgent = false;
  for (let i = 0; i < grid.length; i++) {
    const raw = grid[i];
    const category = cell(raw, 2);
    if (!CATEGORIES.has(category)) continue;
    if (cell(raw, 0)) phase = cell(raw, 0);
    if (cell(raw, 1)) {
      shop = cell(raw, 1);
      // 校舎名セルに色が付いている＝緊急度が高い校舎
      urgent = isFilled(wb.Sheets[name], XLSX.utils.encode_cell({ r: origin.s.r + i, c: origin.s.c + 1 }));
    }
    if (!shop) continue;
    const sc = cell(raw, 12);
    rows.push({
      id: `${phase}|${shop}|${category}`,
      phase,
      shopShortName: shop,
      category,
      groupA: [toNum(raw[3]), toNum(raw[4]), toNum(raw[5])],
      groupB: [toNum(raw[6]), toNum(raw[7]), toNum(raw[8])],
      groupC: [toNum(raw[9]), toNum(raw[10]), toNum(raw[11])],
      shortage: sc === "" ? null : toNum(sc),
      deadline: dateCell(raw[13]),
      flag: cell(raw, 14),
      note: cell(raw, 15),
      urgent,
    });
  }
  return { labels, rows, updatedAt: new Date().toISOString() };
}

const [appFile, planFile] = process.argv.slice(2);
if (!appFile) {
  console.error("usage: node scripts/build-seed.mjs <応募エクスポート> [不足人数管理表]");
  process.exit(1);
}

const snapshot = parseApplications(appFile);
const plan = planFile ? parsePlan(planFile) : null;

writeFileSync(OUT, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), snapshots: [snapshot], plan }, null, 2));
console.error(`${OUT}: 応募 ${snapshot.applications.length}件 / 計画 ${plan ? plan.rows.length : 0}行`);
