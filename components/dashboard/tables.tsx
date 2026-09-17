"use client";

import { BreakdownRow, Matrix } from "@/lib/recruiting/aggregate";

const cellBase = "px-2 py-1.5 text-xs whitespace-nowrap";

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`${cellBase} font-medium ${align === "right" ? "text-right" : "text-left"}`}
      style={{ color: "var(--text-secondary)" }}
      scope="col"
    >
      {children}
    </th>
  );
}

/**
 * 軸 × 週 のクロス集計。値の大小は単一色相の濃淡で表す。
 * 文字色は常に本文色のままにしたいので、色は地に対する不透明度で載せる。
 */
export function WeeklyMatrixTable({ matrix, dimensionLabel }: { matrix: Matrix; dimensionLabel: string }) {
  const max = Math.max(...matrix.rows.flatMap((r) => r.counts), 1);
  const totals = matrix.weeks.map((_, i) => matrix.rows.reduce((a, r) => a + r.counts[i], 0));

  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
              <Th>{dimensionLabel}</Th>
              {matrix.weeks.map((w) => (
                <Th key={w.key} align="right">
                  {w.label}
                </Th>
              ))}
              <Th align="right">合計</Th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.key} style={{ borderBottom: "1px solid var(--gridline)" }}>
                <th
                  scope="row"
                  className={`${cellBase} text-left font-normal`}
                  style={{ color: "var(--text-primary)" }}
                >
                  {row.key}
                </th>
                {row.counts.map((c, i) => (
                  <td
                    key={matrix.weeks[i].key}
                    className={`${cellBase} text-right tabular`}
                    style={{
                      color: c > 0 ? "var(--text-primary)" : "var(--text-muted)",
                      background:
                        c > 0
                          ? `color-mix(in srgb, var(--series-1) ${Math.round((c / max) * 55)}%, transparent)`
                          : "transparent",
                    }}
                  >
                    {c || "–"}
                  </td>
                ))}
                <td className={`${cellBase} text-right font-semibold tabular`} style={{ color: "var(--text-primary)" }}>
                  {row.total}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className={`${cellBase} text-left`} style={{ color: "var(--text-secondary)" }}>
                合計
              </th>
              {totals.map((t, i) => (
                <td
                  key={matrix.weeks[i].key}
                  className={`${cellBase} text-right font-semibold tabular`}
                  style={{ color: "var(--text-primary)" }}
                >
                  {t}
                </td>
              ))}
              <td className={`${cellBase} text-right font-semibold tabular`} style={{ color: "var(--text-primary)" }}>
                {totals.reduce((a, b) => a + b, 0)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>少ない</span>
        {[10, 25, 40, 55].map((pctAlpha) => (
          <span
            key={pctAlpha}
            className="h-3 w-6 rounded-sm"
            style={{ background: `color-mix(in srgb, var(--series-1) ${pctAlpha}%, transparent)` }}
            aria-hidden
          />
        ))}
        <span>多い（最大 {max}件）</span>
      </div>
    </div>
  );
}

/** 軸ごとの応募状況の一覧 */
export function BreakdownTable({ rows, dimensionLabel }: { rows: BreakdownRow[]; dimensionLabel: string }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <Th>{dimensionLabel}</Th>
            <Th align="right">累計応募</Th>
            <Th align="right">直近週</Th>
            <Th align="right">前週差</Th>
            <Th align="right">選考中</Th>
            <Th align="right">面接設定</Th>
            <Th align="right">採用</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.lastWeekApplied - r.prevWeekApplied;
            return (
              <tr key={r.key} style={{ borderBottom: "1px solid var(--gridline)" }}>
                <th scope="row" className={`${cellBase} text-left font-normal`} style={{ color: "var(--text-primary)" }}>
                  {r.key}
                </th>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                  {r.applied}
                </td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                  {r.lastWeekApplied}
                </td>
                <td
                  className={`${cellBase} text-right tabular`}
                  style={{
                    color: delta > 0 ? "var(--delta-up)" : delta < 0 ? "var(--delta-down)" : "var(--text-muted)",
                  }}
                >
                  {delta > 0 ? `▲${delta}` : delta < 0 ? `▼${Math.abs(delta)}` : "±0"}
                </td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                  {r.activePool}
                </td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                  {r.scheduled}
                </td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                  {r.hired}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface PlanVsActualRow {
  shopShortName: string;
  shortage: number;
  applied: number;
  pool: number;
  hired: number;
  remaining: number;
  deadline: string;
  matched: boolean;
}

/** 不足人数（採用計画）に対して、いま応募がどれだけ積み上がっているか */
export function PlanVsActualTable({ rows }: { rows: PlanVsActualRow[] }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <Th>校舎</Th>
            <Th align="right">不足人数</Th>
            <Th align="right">累計応募</Th>
            <Th align="right">選考中</Th>
            <Th align="right">採用</Th>
            <Th align="right">残不足</Th>
            <Th align="right">期限</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.shopShortName} style={{ borderBottom: "1px solid var(--gridline)" }}>
              <th scope="row" className={`${cellBase} text-left font-normal`} style={{ color: "var(--text-primary)" }}>
                {r.shopShortName}
                {!r.matched && (
                  <span className="ml-1 text-[10px]" style={{ color: "var(--text-muted)" }} title="応募データ側に同名の校舎が見つかりませんでした">
                    （応募データ未突合）
                  </span>
                )}
              </th>
              <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                {r.shortage}
              </td>
              <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                {r.applied}
              </td>
              <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                {r.pool}
              </td>
              <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>
                {r.hired}
              </td>
              <td className={`${cellBase} text-right font-semibold tabular`}>
                {r.remaining === 0 ? (
                  <span style={{ color: "var(--status-good)" }}>✓ 充足</span>
                ) : (
                  <span style={{ color: r.pool === 0 ? "var(--status-critical)" : "var(--text-primary)" }}>
                    {r.pool === 0 ? "⚠ " : ""}
                    {r.remaining}
                  </span>
                )}
              </td>
              <td className={`${cellBase} text-right`} style={{ color: "var(--text-secondary)" }}>
                {r.deadline || "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
