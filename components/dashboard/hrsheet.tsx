"use client";

import { ReactNode, useState } from "react";
import { HR_CATEGORY_LABEL, HrCategory, HrCompareRow, HrCross } from "@/lib/recruiting/hrsheet";

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
export function useSort<K extends string>() {
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

export type SortState<K extends string> = ReturnType<typeof useSort<K>>;

export function sorted<T, K extends string>(rows: T[], state: SortState<K>, value: (row: T, key: K) => number | string): T[] {
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
export function SortTh<K extends string>({
  children,
  sortKey,
  state,
  align = "right",
  width,
  rowSpan,
  groupStart = false,
  sticky = false,
}: {
  children: ReactNode;
  sortKey: K;
  state: SortState<K>;
  align?: "left" | "right" | "center";
  /** 数値の列は中身ぶんだけに詰める。空けると校舎名と数字が離れて読みにくい。 */
  width?: string;
  /** 見出しが2段の表で、上の段と通して1つの見出しにするとき */
  rowSpan?: number;
  /** コースのまとまりの先頭の列。縦の区切り線を引いて、どこからどこまでが1コースか分かるようにする。 */
  groupStart?: boolean;
  /** 横に長い表で、スクロールしても校舎名が残るようにする */
  sticky?: boolean;
}) {
  const on = state.key === sortKey;
  return (
    <th
      scope="col"
      rowSpan={rowSpan}
      className={`px-2 py-1.5 text-[11px] font-medium whitespace-nowrap ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      } ${sticky ? "sticky left-0 z-10" : ""}`}
      style={{
        color: on ? "var(--series-1)" : "var(--text-secondary)",
        width,
        borderLeft: groupStart ? "1px solid var(--gridline)" : undefined,
        background: sticky ? "var(--surface-1)" : undefined,
      }}
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

/**
 * 「実績 / 目標」のセル。
 *
 * 目標が無い（不足人数管理表に記入が無い）ところは分母を出さない。
 * 0 / 1 のように分母を付けると、埋めるべき枠かどうかが一目で分かる。
 */
export function Fill({ actual, target }: { actual: number; target: number | null }) {
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
