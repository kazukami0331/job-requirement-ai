"use client";

import { ReactNode } from "react";
import { BreakdownRow, Matrix } from "@/lib/recruiting/aggregate";

const cellBase = "px-2 py-1.5 text-xs whitespace-nowrap";

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
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

/** 色だけに意味を持たせないよう、必ずラベルと記号をセットで出す */
export function UrgentBadge() {
  return (
    <span
      className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold align-middle"
      style={{
        background: "color-mix(in srgb, var(--status-warning) 28%, transparent)",
        color: "var(--text-primary)",
      }}
    >
      ⚠ 緊急
    </span>
  );
}

/** スマホ用のカード。値は見出しと縦に並べる */
function MobileCard({
  title,
  badge,
  items,
  accent = false,
}: {
  title: ReactNode;
  badge?: ReactNode;
  items: { label: string; value: ReactNode }[];
  /** 緊急の校舎は左に色の帯を付けて、スクロール中でも拾えるようにする */
  accent?: boolean;
}) {
  return (
    <li
      className="overflow-hidden rounded-lg border px-3 py-2"
      style={{
        borderColor: accent ? "color-mix(in srgb, var(--status-warning) 55%, transparent)" : "var(--gridline)",
        background: accent
          ? "color-mix(in srgb, var(--status-warning) 8%, var(--background))"
          : "var(--background)",
        boxShadow: accent ? "inset 3px 0 0 0 var(--status-warning)" : undefined,
      }}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-1 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
        {badge}
      </div>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-1.5">
        {items.map((it) => (
          <div key={it.label}>
            <dt className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {it.label}
            </dt>
            <dd className="text-xs tabular" style={{ color: "var(--text-primary)" }}>
              {it.value}
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function Delta({ value }: { value: number }) {
  return (
    <span
      className="tabular"
      style={{ color: value > 0 ? "var(--delta-up)" : value < 0 ? "var(--delta-down)" : "var(--text-muted)" }}
    >
      {value > 0 ? `▲${value}` : value < 0 ? `▼${Math.abs(value)}` : "±0"}
    </span>
  );
}

/**
 * 軸 × 週 のクロス集計。値の大小は単一色相の濃淡で表す。
 * 文字色は常に本文色のままにしたいので、色は地に対する不透明度で載せる。
 * 横に広い表なので、スマホでは横スクロールしつつ校舎名の列を貼り付けておく。
 */
export function WeeklyMatrixTable({ matrix, dimensionLabel }: { matrix: Matrix; dimensionLabel: string }) {
  const max = Math.max(...matrix.rows.flatMap((r) => r.counts), 1);
  const totals = matrix.weeks.map((_, i) => matrix.rows.reduce((a, r) => a + r.counts[i], 0));
  const stickyBg = { background: "var(--surface-1)" };

  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
              <th
                className={`${cellBase} sticky left-0 z-10 text-left font-medium`}
                style={{ ...stickyBg, color: "var(--text-secondary)" }}
                scope="col"
              >
                {dimensionLabel}
              </th>
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
                  className={`${cellBase} sticky left-0 z-10 text-left font-normal`}
                  style={{ ...stickyBg, color: "var(--text-primary)" }}
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
              <th
                scope="row"
                className={`${cellBase} sticky left-0 z-10 text-left`}
                style={{ ...stickyBg, color: "var(--text-secondary)" }}
              >
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

      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
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
        <span className="sm:hidden">・横にスクロールできます</span>
      </div>
    </div>
  );
}

/** 軸ごとの応募状況。スマホではカード、それ以上では表で出す。 */
export function BreakdownTable({ rows, dimensionLabel }: { rows: BreakdownRow[]; dimensionLabel: string }) {
  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <MobileCard
            key={r.key}
            title={r.key}
            items={[
              { label: "累計応募", value: r.applied },
              { label: "直近週", value: r.lastWeekApplied },
              { label: "前週差", value: <Delta value={r.lastWeekApplied - r.prevWeekApplied} /> },
              { label: "選考中", value: r.activePool },
              { label: "面接設定", value: r.scheduled },
              { label: "採用", value: r.hired },
            ]}
          />
        ))}
      </ul>

      <div className="-mx-1 hidden overflow-x-auto sm:block">
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
            {rows.map((r) => (
              <tr key={r.key} style={{ borderBottom: "1px solid var(--gridline)" }}>
                <th scope="row" className={`${cellBase} text-left font-normal`} style={{ color: "var(--text-primary)" }}>
                  {r.key}
                </th>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.applied}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.lastWeekApplied}</td>
                <td className={`${cellBase} text-right`}>
                  <Delta value={r.lastWeekApplied - r.prevWeekApplied} />
                </td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.activePool}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.scheduled}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.hired}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export interface PlanVsActualRow {
  shopShortName: string;
  /** 緊急度が高い校舎（元シートで色が塗られている） */
  urgent: boolean;
  shortage: number;
  applied: number;
  pool: number;
  hired: number;
  remaining: number;
  deadline: string;
  matched: boolean;
}

function Remaining({ row }: { row: PlanVsActualRow }) {
  if (row.remaining === 0) return <span style={{ color: "var(--status-good)" }}>✓ 充足</span>;
  return (
    <span style={{ color: row.pool === 0 ? "var(--status-critical)" : "var(--text-primary)" }}>
      {row.pool === 0 ? "⚠ " : ""}
      {row.remaining}
    </span>
  );
}

function Unmatched() {
  return (
    <span className="text-[10px] font-normal" style={{ color: "var(--text-muted)" }}>
      （応募データ未突合）
    </span>
  );
}

/** 不足人数（採用計画）に対して、いま応募がどれだけ積み上がっているか */
export function PlanVsActualTable({ rows }: { rows: PlanVsActualRow[] }) {
  // 緊急の校舎は左に色の帯を足して、一覧の中で先に目に入るようにする
  const urgentEdge = (urgent: boolean) =>
    urgent ? { boxShadow: "inset 3px 0 0 0 var(--status-warning)" } : undefined;

  return (
    <>
      <ul className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <MobileCard
            key={r.shopShortName}
            accent={r.urgent}
            title={
              <>
                {r.shopShortName}
                {!r.matched && <Unmatched />}
              </>
            }
            badge={r.urgent ? <UrgentBadge /> : undefined}
            items={[
              { label: "不足人数", value: r.shortage },
              { label: "累計応募", value: r.applied },
              { label: "選考中", value: r.pool },
              { label: "採用", value: r.hired },
              { label: "残不足", value: <Remaining row={r} /> },
              { label: "期限", value: r.deadline || "–" },
            ]}
          />
        ))}
      </ul>

      <div className="-mx-1 hidden overflow-x-auto sm:block">
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
              <tr key={r.shopShortName} style={{ borderBottom: "1px solid var(--gridline)", ...urgentEdge(r.urgent) }}>
                <th scope="row" className={`${cellBase} text-left font-normal`} style={{ color: "var(--text-primary)" }}>
                  {r.shopShortName}
                  {r.urgent && <UrgentBadge />}
                  {!r.matched && <Unmatched />}
                </th>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.shortage}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.applied}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.pool}</td>
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.hired}</td>
                <td className={`${cellBase} text-right font-semibold tabular`}>
                  <Remaining row={r} />
                </td>
                <td className={`${cellBase} text-right`} style={{ color: "var(--text-secondary)" }}>{r.deadline || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
