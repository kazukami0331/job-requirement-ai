import * as XLSX from "xlsx";
import { Application, HiringPlan } from "@/types/recruiting";
import { STAGES, stageOf } from "./status";
import { Dimension, DIMENSION_LABEL, funnel, weeklyMatrix, weeklyTrend } from "./aggregate";
import { planToGrid, shortageByShop } from "./plan";

export interface SheetSpec {
  name: string;
  grid: unknown[][];
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // アンカーをDOMに入れないとdownload属性（ファイル名）が効かないブラウザがある。
  // URLの解放もダウンロード開始より先に走らないよう、次のタスクに回す。
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** UTF-8 BOM付きCSV。Excel・Googleスプレッドシートのどちらでも文字化けしない。 */
export function downloadCsv(grid: unknown[][], fileName: string) {
  const sheet = XLSX.utils.aoa_to_sheet(grid);
  const csv = XLSX.utils.sheet_to_csv(sheet);
  download(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), fileName);
}

/** 複数シートのxlsx。そのままGoogleスプレッドシートにインポートできる。 */
export function downloadWorkbook(sheets: SheetSpec[], fileName: string) {
  const wb = XLSX.utils.book_new();
  for (const { name, grid } of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), name.slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  download(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName);
}

export function downloadJson(data: unknown, fileName: string) {
  download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), fileName);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 週次推移シート */
export function weeklyTrendGrid(apps: Application[]): unknown[][] {
  const trend = weeklyTrend(apps);
  const grid: unknown[][] = [
    ["週(月曜)", "週ラベル", "応募数", "前週差", "面接設定", "面接実施", "採用", "選考中プール", "応募→採用率"],
  ];
  trend.forEach((p, i) => {
    const prev = i > 0 ? trend[i - 1].applied : null;
    grid.push([
      p.week.start,
      p.week.label,
      p.applied,
      prev === null ? "" : p.applied - prev,
      p.scheduled,
      p.interviewed,
      p.hired,
      p.activePool,
      p.applied > 0 ? pct(p.hired / p.applied) : "",
    ]);
  });
  return grid;
}

/** 軸 × 週 のクロス集計シート */
export function matrixGrid(apps: Application[], dimension: Dimension, maxWeeks = 12): unknown[][] {
  const matrix = weeklyMatrix(apps, dimension, maxWeeks);
  const grid: unknown[][] = [[DIMENSION_LABEL[dimension], ...matrix.weeks.map((w) => w.label), "合計"]];
  for (const row of matrix.rows) grid.push([row.key, ...row.counts, row.total]);
  grid.push([
    "合計",
    ...matrix.weeks.map((_, i) => matrix.rows.reduce((a, r) => a + r.counts[i], 0)),
    matrix.rows.reduce((a, r) => a + r.total, 0),
  ]);
  return grid;
}

/** ファネルシート */
export function funnelGrid(apps: Application[]): unknown[][] {
  const steps = funnel(apps);
  const grid: unknown[][] = [["段階", "件数", "前段階からの転換率", "応募比"]];
  for (const s of steps) {
    grid.push([s.label, s.count, s.conversionFromPrev === null ? "" : pct(s.conversionFromPrev), pct(s.conversionFromTop)]);
  }
  grid.push([]);
  grid.push(["選考ステータス別プール", "件数"]);
  const counts = new Map<string, number>();
  for (const a of apps) {
    const stage = stageOf(a.statusId);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  for (const s of STAGES) grid.push([s.label, counts.get(s.key) ?? 0]);
  return grid;
}

/** 応募明細シート（個人情報は含めず、集計に必要な列だけ） */
export function detailGrid(apps: Application[]): unknown[][] {
  const grid: unknown[][] = [
    ["応募ID", "応募受付日", "校舎", "雇用形態", "職種", "媒体", "応募経路", "選考ステータス", "ステータス更新日", "面接日時", "不採用理由"],
  ];
  for (const a of [...apps].sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))) {
    grid.push([
      a.applicationId,
      a.receivedAt.slice(0, 16).replace("T", " "),
      a.shopShortName,
      a.employmentType,
      a.jobTitle,
      a.media,
      a.route,
      a.statusName,
      a.statusUpdatedAt ? a.statusUpdatedAt.slice(0, 16).replace("T", " ") : "",
      a.interviewStartAt ? a.interviewStartAt.slice(0, 16).replace("T", " ") : "",
      a.rejectReason ?? "",
    ]);
  }
  return grid;
}

/** 採用計画 vs 応募実績シート */
export function planVsActualGrid(apps: Application[], plan: HiringPlan | null): unknown[][] {
  const grid: unknown[][] = [
    ["校舎", "緊急", "不足人数", "累計応募", "選考中プール", "採用", "残不足", "充足率", "期限", "備考"],
  ];
  if (!plan) return grid;

  const byShop = new Map<string, { applied: number; pool: number; hired: number }>();
  for (const a of apps) {
    const key = a.shopShortName.replace(/[\s　]/g, "").replace(/校$/, "");
    const e = byShop.get(key) ?? { applied: 0, pool: 0, hired: 0 };
    const stage = stageOf(a.statusId);
    e.applied++;
    if (["untouched", "scheduling", "interviewScheduled", "interviewed"].includes(stage)) e.pool++;
    if (stage === "hired") e.hired++;
    byShop.set(key, e);
  }

  for (const s of shortageByShop(plan)) {
    const key = s.shopShortName.replace(/[\s　]/g, "").replace(/校$/, "");
    const actual = byShop.get(key) ?? { applied: 0, pool: 0, hired: 0 };
    grid.push([
      s.shopShortName,
      s.urgent ? "緊急" : "",
      s.shortage,
      actual.applied,
      actual.pool,
      actual.hired,
      Math.max(0, s.shortage - actual.hired),
      s.shortage > 0 ? pct(actual.hired / s.shortage) : "",
      s.deadline,
      s.note,
    ]);
  }
  return grid;
}

/** ダッシュボード一式をスプレッドシート用のブックとして書き出す */
export function buildWorkbookSheets(apps: Application[], plan: HiringPlan | null): SheetSpec[] {
  const sheets: SheetSpec[] = [
    { name: "週次推移", grid: weeklyTrendGrid(apps) },
    { name: "校舎別×週", grid: matrixGrid(apps, "shopShortName") },
    { name: "雇用形態別×週", grid: matrixGrid(apps, "employmentType") },
    { name: "媒体別×週", grid: matrixGrid(apps, "media") },
    { name: "ファネル", grid: funnelGrid(apps) },
    { name: "応募明細", grid: detailGrid(apps) },
  ];
  if (plan) {
    sheets.push({ name: "計画vs実績", grid: planVsActualGrid(apps, plan) });
    sheets.push({ name: "採用計画", grid: planToGrid(plan) });
  }
  return sheets;
}
