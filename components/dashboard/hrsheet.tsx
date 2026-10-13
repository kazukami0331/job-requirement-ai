"use client";

import { ReactNode, useState } from "react";
import { HR_CATEGORY_LABEL, HrCategory, HrCompareRow, HrCross, HrCrossShop, HrTargets } from "@/lib/recruiting/hrsheet";
import { ratioLabel } from "@/lib/recruiting/format";

/**
 * 採用チームのExcelから作った集計。
 *
 * ジョブオプ側には分野（コース）が無いので、この表はExcelだけから作る。
 * 数が合わないことは珍しくないので、比較の表を並べて差が見えるようにする。
 */

/**
 * 並び替え。押すたびに 降順 → 昇順 → 既定 と戻る。
 * 「どこが多いか」を見ることが多いので、最初の一押しは降順にする。
 */
function useSort<K extends string>() {
  const [key, setKey] = useState<K | "default">("default");
  const [asc, setAsc] = useState(false);
  const toggle = (k: K) => {
    if (k !== key) {
      setKey(k);
      setAsc(false);
      return;
    }
    if (!asc) setAsc(true);
    else {
      setKey("default");
      setAsc(false);
    }
  };
  return { key, asc, toggle };
}

type SortState<K extends string> = ReturnType<typeof useSort<K>>;

function sorted<T, K extends string>(rows: T[], state: SortState<K>, value: (row: T, key: K) => number | string): T[] {
  if (state.key === "default") return rows;
  const k = state.key as K;
  return [...rows].sort((a, b) => {
    const x = value(a, k);
    const y = value(b, k);
    const d = typeof x === "string" ? x.localeCompare(String(y), "ja") : x - (y as number);
    return state.asc ? d : -d;
  });
}

/** 並び替えできる見出し。押せることが分かるよう、効いている列には矢印を出す。 */
function SortTh<K extends string>({
  children,
  sortKey,
  state,
  align = "right",
  width,
}: {
  children: ReactNode;
  sortKey: K;
  state: SortState<K>;
  align?: "left" | "right" | "center";
  /** 数値の列は中身ぶんだけに詰める。空けると校舎名と数字が離れて読みにくい。 */
  width?: string;
}) {
  const on = state.key === sortKey;
  return (
    <th
      scope="col"
      className={`px-2 py-1.5 text-[11px] font-medium whitespace-nowrap ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      }`}
      style={{ color: on ? "var(--series-1)" : "var(--text-secondary)", width }}
    >
      <button type="button" onClick={() => state.toggle(sortKey)} className="inline-flex items-center gap-0.5">
        {children}
        <span aria-hidden style={{ opacity: on ? 1 : 0.25 }}>
          {on ? (state.asc ? "▲" : "▼") : "▾"}
        </span>
      </button>
    </th>
  );
}

const cell = "px-2 py-1 text-xs tabular whitespace-nowrap";
/** 数値の列。中身に合わせて詰め、余った幅は校舎名の列に渡す。 */
const NUM_W = "6.5rem";
/** コースの列。見出しが列からはみ出さないよう、見出しの長さぶんを確保する。 */
const COURSE_W = "7.5rem";

/**
 * 「実績 / 目標」のセル。
 *
 * 目標が無い（不足人数管理表に記入が無い）ところは分母を出さない。
 * 0 / 1 のように分母を付けると、埋めるべき枠かどうかが一目で分かる。
 */
function Fill({ actual, target }: { actual: number; target: number | null }) {
  if (target === null) {
    return <span style={{ color: actual ? "var(--text-primary)" : "var(--text-muted)" }}>{actual || "–"}</span>;
  }
  if (target === 0 && actual === 0) return <span style={{ color: "var(--text-muted)" }}>–</span>;

  const done = target > 0 && actual >= target;
  return (
    <span>
      <span style={{ color: done ? "var(--status-good)" : actual ? "var(--text-primary)" : "var(--status-serious)", fontWeight: 600 }}>
        {actual}
      </span>
      <span style={{ color: "var(--text-muted)" }}> / {target}</span>
    </span>
  );
}

type CrossKey = "shop" | "total" | "applied" | "rate" | HrCategory;

export function HrCrossTable({ cross, targets }: { cross: HrCross; targets?: HrTargets | null }) {
  const sort = useSort<CrossKey>();
  if (cross.shops.length === 0) return null;

  /** 目標が無い区分（未記入）と、管理表に載っていない校舎は分母を出さない */
  const targetOf = (key: string, c: HrCategory): number | null => {
    if (!targets || c === "none") return null;
    return targets.byShop.get(key)?.byCategory[c] ?? null;
  };

  const value = (s: HrCrossShop, key: CrossKey): number | string => {
    if (key === "shop") return s.shopShortName;
    if (key === "total") return s.total;
    if (key === "applied") return s.applied;
    if (key === "rate") return s.applied > 0 ? s.total / s.applied : -1;
    return s.byCategory[key];
  };

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <SortTh sortKey="shop" state={sort} align="left">
              校舎
            </SortTh>
            <SortTh sortKey="total" state={sort} width={NUM_W}>
              採用
            </SortTh>
            <SortTh sortKey="applied" state={sort} width={NUM_W}>
              応募
            </SortTh>
            <SortTh sortKey="rate" state={sort} width={NUM_W}>
              採用率
            </SortTh>
            {cross.categories.map((c) => (
              <SortTh key={c} sortKey={c} state={sort} align="center" width={COURSE_W}>
                {HR_CATEGORY_LABEL[c]}
              </SortTh>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
              合計
            </td>
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--status-good)" }}>
              {cross.total}
              {targets && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> / {targets.minHires}</span>}
            </td>
            <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
              {cross.totalApplied}
            </td>
            <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
              {ratioLabel(cross.total, cross.totalApplied)}
            </td>
            {cross.categories.map((c) => (
              <td key={c} className={`${cell} text-center font-semibold`} style={{ color: "var(--text-primary)" }}>
                {cross.totalByCategory[c]}
                {targets && c !== "none" && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> / {targets.totalByCategory[c]}</span>
                )}
              </td>
            ))}
          </tr>
          {sorted(cross.shops, sort, value).map((s) => (
            <tr key={s.key} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={cell} style={{ color: "var(--text-primary)" }}>
                {s.shopShortName}
              </td>
              <td className={`${cell} text-right`}>
                <Fill actual={s.total} target={targets ? (targets.byShop.get(s.key)?.minHires ?? null) : null} />
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {s.applied}
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {ratioLabel(s.total, s.applied)}
              </td>
              {cross.categories.map((c) => (
                <td key={c} className={`${cell} text-center`}>
                  <Fill actual={s.byCategory[c]} target={targetOf(s.key, c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 区分それぞれに、Excelのどの分野が入ったかを出す。
 *
 * IT・CAD・未記入 以外はすべて Webデザイン に寄せているので、
 * 中身を見せないと「Webデザイン 13名」が何なのか分からない。
 */
export function HrCategoryNote({ cross }: { cross: HrCross }) {
  const lines = cross.categories
    .map((c) => {
      const entries = Object.entries(cross.rawByCategory[c]).sort((a, b) => b[1] - a[1]);
      return entries.length === 0 ? null : { c, text: entries.map(([k, v]) => `${k} ${v}`).join("・") };
    })
    .filter((x): x is { c: HrCategory; text: string } => x !== null);

  if (lines.length === 0) return null;

  return (
    <ul className="space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
      {lines.map((l) => (
        <li key={l.c}>
          <span style={{ color: "var(--text-secondary)" }}>{HR_CATEGORY_LABEL[l.c]}</span> の内訳 … {l.text}
        </li>
      ))}
    </ul>
  );
}

type CompareKey = "shop" | "excel" | "jobop" | "diff";

export function HrCompareTable({ rows }: { rows: HrCompareRow[] }) {
  const sort = useSort<CompareKey>();
  if (rows.length === 0) return null;
  const sum = (f: (r: HrCompareRow) => number) => rows.reduce((a, r) => a + f(r), 0);

  const value = (r: HrCompareRow, key: CompareKey): number | string =>
    key === "shop" ? r.shopShortName : key === "excel" ? r.excel : key === "jobop" ? r.jobop : r.diff;

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <SortTh sortKey="shop" state={sort} align="left">
              校舎
            </SortTh>
            <SortTh sortKey="excel" state={sort} width={NUM_W}>
              Excel
            </SortTh>
            <SortTh sortKey="jobop" state={sort} width={NUM_W}>
              ジョブオプ
            </SortTh>
            <SortTh sortKey="diff" state={sort} width={NUM_W}>
              差
            </SortTh>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
              合計
            </td>
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--text-primary)" }}>
              {sum((r) => r.excel)}
            </td>
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--text-primary)" }}>
              {sum((r) => r.jobop)}
            </td>
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--text-secondary)" }}>
              {sum((r) => r.diff) > 0 ? `+${sum((r) => r.diff)}` : sum((r) => r.diff)}
            </td>
          </tr>
          {sorted(rows, sort, value).map((r) => (
            <tr key={r.shopShortName} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={cell} style={{ color: "var(--text-primary)" }}>
                {r.shopShortName}
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {r.excel}
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {r.jobop}
              </td>
              <td
                className={`${cell} text-right font-semibold`}
                style={{ color: r.diff === 0 ? "var(--text-muted)" : "var(--status-serious)" }}
              >
                {r.diff === 0 ? "±0" : r.diff > 0 ? `+${r.diff}` : r.diff}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
