"use client";

import { HrCompareRow, HrCross } from "@/lib/recruiting/hrsheet";
import { CATEGORY_LABEL } from "@/lib/recruiting/shops";
import { ratioLabel } from "@/lib/recruiting/format";

/**
 * 採用チームのExcelから作った集計。
 *
 * ジョブオプ側には分野（コース）が無いので、この表はExcelだけから作る。
 * 数が合わないことは珍しくないので、比較の表を並べて差が見えるようにする。
 */

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`px-2 py-1.5 text-[11px] font-medium whitespace-nowrap ${align === "right" ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </th>
  );
}

const cell = "px-2 py-1 text-xs tabular";

export function HrCrossTable({ cross }: { cross: HrCross }) {
  if (cross.shops.length === 0) return null;

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <Th>校舎</Th>
            <Th align="right">採用</Th>
            <Th align="right">応募</Th>
            <Th align="right">採用率</Th>
            {cross.categories.map((c) => (
              <Th key={c} align="right">
                {CATEGORY_LABEL[c]}
              </Th>
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
            </td>
            <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
              {cross.totalApplied}
            </td>
            <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
              {ratioLabel(cross.total, cross.totalApplied)}
            </td>
            {cross.categories.map((c) => (
              <td key={c} className={`${cell} text-right font-semibold`} style={{ color: "var(--text-primary)" }}>
                {cross.totalByCategory[c]}
              </td>
            ))}
          </tr>
          {cross.shops.map((s) => (
            <tr key={s.shopShortName} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={cell} style={{ color: "var(--text-primary)" }}>
                {s.shopShortName}
              </td>
              <td
                className={`${cell} text-right font-semibold`}
                style={{ color: s.total > 0 ? "var(--status-good)" : "var(--text-muted)" }}
              >
                {s.total}
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {s.applied}
              </td>
              <td className={`${cell} text-right`} style={{ color: "var(--text-secondary)" }}>
                {ratioLabel(s.total, s.applied)}
              </td>
              {cross.categories.map((c) => (
                <td
                  key={c}
                  className={`${cell} text-right`}
                  style={{ color: s.byCategory[c] ? "var(--text-primary)" : "var(--text-muted)" }}
                >
                  {s.byCategory[c] || "–"}
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
 * 3区分それぞれに、Excelのどの分野が入ったかを出す。
 *
 * IT と CAD 以外はすべて D/W に寄せているので、中身を見せないと
 * 「D/W 11名」が何なのか分からない。未記入がどれだけ混ざっているかもここで分かる。
 */
export function HrCategoryNote({ cross }: { cross: HrCross }) {
  const lines = cross.categories
    .map((c) => {
      const entries = Object.entries(cross.rawByCategory[c]).sort((a, b) => b[1] - a[1]);
      return entries.length === 0 ? null : { c, text: entries.map(([k, v]) => `${k} ${v}`).join("・") };
    })
    .filter((x): x is { c: (typeof cross.categories)[number]; text: string } => x !== null);

  if (lines.length === 0) return null;

  return (
    <ul className="space-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
      {lines.map((l) => (
        <li key={l.c}>
          <span style={{ color: "var(--text-secondary)" }}>{CATEGORY_LABEL[l.c]}</span> の内訳 … {l.text}
        </li>
      ))}
    </ul>
  );
}

export function HrCompareTable({ rows }: { rows: HrCompareRow[] }) {
  if (rows.length === 0) return null;
  const sum = (f: (r: HrCompareRow) => number) => rows.reduce((a, r) => a + f(r), 0);

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <Th>校舎</Th>
            <Th align="right">Excel</Th>
            <Th align="right">ジョブオプ</Th>
            <Th align="right">差</Th>
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
          {rows.map((r) => (
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
