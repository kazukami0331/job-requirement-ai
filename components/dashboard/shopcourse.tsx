"use client";

import { ShopCourseMatrix, ShopCourseRow } from "@/lib/recruiting/aggregate";
import { BEFORE_SPLIT } from "@/lib/recruiting/course";
import { SortTh, sorted, useSort } from "./hrsheet";

/**
 * 校舎 × コースの応募数。
 *
 * 不足しているコースに応募が来ていない校舎を探すための表なので、
 * コース分けして以降の求人からの応募が多い校舎から並べる。
 * コース分け前の応募は、推測で3つに割らず最後の列にそのまま置く。
 */

const cell = "px-2 py-1 text-xs tabular whitespace-nowrap";
const NUM_W = "5.5rem";
const COURSE_W = "7rem";

type Key = "shop" | "split" | "applied" | string;

export function ShopCourseTable({ matrix }: { matrix: ShopCourseMatrix }) {
  const sort = useSort<Key>();
  if (matrix.rows.length === 0) return null;

  const value = (r: ShopCourseRow, key: Key): number | string => {
    if (key === "shop") return r.shopShortName;
    if (key === "split") return r.split;
    if (key === "applied") return r.applied;
    return r.byCourse[key] ?? 0;
  };

  /** 0 は薄く出す。応募が来ていないコースを見つけるための表なので、0が目立つ必要がある。 */
  const Count = ({ n, muted = false }: { n: number; muted?: boolean }) => (
    <span style={{ color: n > 0 ? (muted ? "var(--text-secondary)" : "var(--text-primary)") : "var(--text-muted)" }}>
      {n || "–"}
    </span>
  );

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <SortTh sortKey="shop" state={sort} align="left">
              校舎
            </SortTh>
            {matrix.courses
              .filter((c) => c !== BEFORE_SPLIT)
              .map((c) => (
                <SortTh key={c} sortKey={c} state={sort} align="center" width={COURSE_W}>
                  {c}
                </SortTh>
              ))}
            <SortTh sortKey="split" state={sort} width={NUM_W}>
              小計
            </SortTh>
            <SortTh sortKey={BEFORE_SPLIT} state={sort} align="center" width={COURSE_W}>
              コース分け前
            </SortTh>
            <SortTh sortKey="applied" state={sort} width={NUM_W}>
              累計応募
            </SortTh>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
              合計
            </td>
            {matrix.courses
              .filter((c) => c !== BEFORE_SPLIT)
              .map((c) => (
                <td key={c} className={`${cell} text-center font-semibold`} style={{ color: "var(--text-primary)" }}>
                  {matrix.totalByCourse[c]}
                </td>
              ))}
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--series-1)" }}>
              {matrix.split}
            </td>
            <td className={`${cell} text-center`} style={{ color: "var(--text-secondary)" }}>
              {matrix.totalByCourse[BEFORE_SPLIT]}
            </td>
            <td className={`${cell} text-right font-semibold`} style={{ color: "var(--text-primary)" }}>
              {matrix.applied}
            </td>
          </tr>
          {sorted(matrix.rows, sort, value).map((r) => (
            <tr key={r.shopShortName} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={cell} style={{ color: "var(--text-primary)" }}>
                {r.shopShortName}
              </td>
              {matrix.courses
                .filter((c) => c !== BEFORE_SPLIT)
                .map((c) => (
                  <td key={c} className={`${cell} text-center`}>
                    <Count n={r.byCourse[c]} />
                  </td>
                ))}
              <td className={`${cell} text-right font-semibold`}>
                <Count n={r.split} />
              </td>
              <td className={`${cell} text-center`}>
                <Count n={r.byCourse[BEFORE_SPLIT]} muted />
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {r.applied}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
