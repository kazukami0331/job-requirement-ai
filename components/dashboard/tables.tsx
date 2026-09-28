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

/** スマホ用のカード。値は見出しと縦に並べる */
function MobileCard({
  title,
  badge,
  items,
}: {
  title: ReactNode;
  badge?: ReactNode;
  items: { label: string; value: ReactNode }[];
}) {
  return (
    <li
      className="overflow-hidden rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--gridline)", background: "var(--background)" }}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-1 text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
        {badge}
      </div>
      {/* 項目が増えたら3列。2列のままだと縦に伸びて、校舎を1画面で見比べられなくなる */}
      <dl className={`grid gap-x-2 gap-y-1.5 ${items.length >= 5 ? "grid-cols-3" : "grid-cols-2"}`}>
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
              // 定例が週の途中にあると直近週は数日ぶんしかない。前週を実数でも置かないと
              // 増えたのか減ったのかを会議で判断できない。
              { label: "前週", value: r.prevWeekApplied },
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
              <Th align="right">前週</Th>
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
                <td className={`${cellBase} text-right tabular`} style={{ color: "var(--text-primary)" }}>{r.prevWeekApplied}</td>
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

/**
 * 不足人数管理表でオレンジに塗られている校舎を、色だけに頼らず「緊急」の札でも示す。
 * 文字色だけだと見落とすという指摘があったため、札と並び順（緊急が先頭）の3つで示している。
 */
export function UrgentName({ name, urgent }: { name: string; urgent: boolean }) {
  if (!urgent) return <>{name}</>;
  return (
    <span className="inline-flex items-center gap-1" title="不足人数管理表でオレンジに塗られている＝緊急度が高い校舎">
      <span style={{ color: "var(--urgent-text)", fontWeight: 700 }}>{name}</span>
      {/* 地を塗ると、ダークテーマでは白抜き文字のコントラストが 2.1:1 まで落ちて読めない。
          枠線と文字だけにすれば、両テーマとも本文と同じ 5.5:1 / 9.4:1 を保てる。 */}
      <span
        className="rounded border px-1 py-px text-[10px] font-semibold leading-none"
        style={{ color: "var(--urgent-text)", borderColor: "var(--urgent-text)" }}
      >
        緊急
      </span>
    </span>
  );
}

