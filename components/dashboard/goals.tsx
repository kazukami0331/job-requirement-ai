"use client";

import { ReactNode } from "react";
import { GoalRates, GoalWindow, MonthGoal, MonthlyGoals, ShopGoalRow, appliesPerHire } from "@/lib/recruiting/goal";
import { UrgentName } from "./tables";

/** 表に出す指標。目標も実績も同じ形で持っているので切り替えるだけで済む。 */
export type GoalMetric = "applied" | "interview" | "hire";

export const GOAL_METRICS: { key: GoalMetric; label: string; hint: string }[] = [
  { key: "applied", label: "応募", hint: "その月に受け付けた応募" },
  { key: "interview", label: "面接設定", hint: "その月に応募した人のうち、面接日が確定した数" },
  { key: "hire", label: "採用", hint: "その月に応募した人のうち、採用まで進んだ数" },
];

function pick(m: MonthGoal, metric: GoalMetric): { target: number; actual: number } {
  if (metric === "interview") return { target: m.targetInterview, actual: m.interviewActual };
  if (metric === "hire") return { target: m.targetHire, actual: m.hireActual };
  return { target: m.targetApplied, actual: m.appliedActual };
}

/** 目標は割り戻しの結果なので小数になる。1未満を0に丸めると「目標なし」に見えてしまう。 */
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * 進捗の色。達成/未達をラベル無しの色だけで表さないよう、必ず数字と併記して使う。
 * 当月は月末までの残りがあるので、経過ぶんに対する進み具合で判定する。
 */
function tone(actual: number, target: number, elapsed: number): string {
  if (target <= 0) return "var(--text-muted)";
  const due = elapsed > 0 ? target * elapsed : target;
  const r = due > 0 ? actual / due : 0;
  if (r >= 1) return "var(--status-good)";
  if (r >= 0.6) return "var(--status-warning)";
  return "var(--status-critical)";
}

function Bar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <span className="flex h-1.5 w-full items-center" style={{ background: "var(--gridline)", borderRadius: 2 }}>
      <span
        className="h-1.5"
        style={{ width: `${ratio * 100}%`, background: color, borderRadius: 2, minWidth: ratio > 0 ? 2 : 0 }}
      />
    </span>
  );
}

/** 実績/目標を1マスに収めたもの。棒は目標を100%とした埋まり具合。 */
function Cell({ m, metric }: { m: MonthGoal; metric: GoalMetric }) {
  const { target, actual } = pick(m, metric);
  // 期限より後の月。0/0 と出すと「未達」に見えるので、対象外だと分かる形にする。
  if (target <= 0 && actual === 0) {
    return (
      <div className="text-xs" style={{ color: "var(--text-muted)" }} title="この月は目標の対象外です">
        —
      </div>
    );
  }
  const color = tone(actual, target, m.current ? m.elapsed : 0);

  return (
    <div className="space-y-1">
      <div className="text-xs tabular whitespace-nowrap">
        <span style={{ color, fontWeight: 600 }}>{fmt(actual)}</span>
        <span style={{ color: "var(--text-muted)" }}> / {fmt(target)}</span>
      </div>
      <Bar ratio={target > 0 ? Math.min(actual / target, 1) : 0} color={color} />
    </div>
  );
}

/**
 * 月ごとに、応募・面接設定・採用の目標と実績をまとめて出す。
 * 校舎別の表は指標を切り替える作りなので、全体の3本を一度に見たいときはここを見る。
 */
export function MonthSummary({ goals }: { goals: MonthlyGoals }) {
  const { total, months } = goals;
  if (!total) return null;

  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {total.months.map((m, i) => (
        <li
          key={m.month}
          className="rounded-lg border px-3 py-2.5"
          style={{ borderColor: "var(--gridline)", background: "var(--background)" }}
        >
          <div className="mb-2 flex items-baseline gap-1.5">
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {months[i].label}
            </span>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {m.current ? `途中・${Math.round(m.elapsed * 100)}%経過` : m.month.replace("-", "/")}
            </span>
          </div>
          <dl className="space-y-1.5">
            {GOAL_METRICS.map((metric) => {
              const { target, actual } = pick(m, metric.key);
              const color = tone(actual, target, m.current ? m.elapsed : 0);
              return (
                <div key={metric.key} className="grid grid-cols-[3.5rem_1fr_5rem] items-center gap-2">
                  <dt className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                    {metric.label}
                  </dt>
                  <dd>
                    <Bar ratio={target > 0 ? Math.min(actual / target, 1) : 0} color={color} />
                  </dd>
                  <dd className="text-right text-xs tabular whitespace-nowrap">
                    <span style={{ color, fontWeight: 600 }}>{fmt(actual)}</span>
                    <span style={{ color: "var(--text-muted)" }}> / {fmt(target)}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/**
 * 採用の内訳。「採用3名（済2・残1）」だと3名が目標なのか採れた数なのか読めないという
 * 指摘があったので、どの数字が何なのかを毎回名前で書く。
 */
function HireCount({ row }: { row: ShopGoalRow }) {
  if (row.alreadyHired === 0) {
    return <span style={{ color: "var(--text-muted)" }}>目標{row.hireTarget}名</span>;
  }
  return (
    <span style={{ color: "var(--text-muted)" }}>
      目標{row.hireTarget}名 ／ 採用済
      <span style={{ color: "var(--status-good)", fontWeight: 600 }}>{row.alreadyHired}</span>名 ／ 残り
      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{row.remainingTarget}</span>名
    </span>
  );
}

function ShopName({ row }: { row: ShopGoalRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 text-xs" title={row.deadlineNote}>
      <UrgentName name={row.shopShortName} urgent={row.urgent} />
      <HireCount row={row} />
    </span>
  );
}

/** 歩留まりの入力。1つ変えると必要応募数がその場で変わる。 */
function RateInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
      {label}
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0) onChange(Math.min(n, 100) / 100);
        }}
        className="w-14 rounded border px-1.5 py-0.5 text-right text-xs tabular"
        style={{ borderColor: "var(--gridline)", background: "var(--background)", color: "var(--text-primary)" }}
      />
      %
    </label>
  );
}

function MonthSelect({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: { month: string; label: string }[];
  onChange: (m: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border px-1.5 py-0.5 text-xs"
        style={{ borderColor: "var(--gridline)", background: "var(--background)", color: "var(--text-primary)" }}
      >
        {choices.map((c) => (
          <option key={c.month} value={c.month}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GoalControls({
  rates,
  onRates,
  goals,
  onWindow,
}: {
  rates: GoalRates;
  onRates: (r: GoalRates) => void;
  goals: MonthlyGoals;
  onWindow: (w: GoalWindow) => void;
}) {
  const perHire = appliesPerHire(rates);
  const { window: win, choices, observed, total } = goals;
  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : "—");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RateInput label="応募→面接" value={rates.applyToInterview} onChange={(v) => onRates({ ...rates, applyToInterview: v })} />
        <RateInput label="面接→採用" value={rates.interviewToHire} onChange={(v) => onRates({ ...rates, interviewToHire: v })} />
        <span className="text-xs" style={{ color: "var(--text-primary)" }}>
          1名採用するのに応募が
          <strong className="tabular"> {perHire === null ? "—" : perHire.toFixed(1)} </strong>
          件必要
          {total && (
            <span style={{ color: "var(--text-secondary)" }}>
              {total.alreadyHired > 0
                ? `（目標${total.hireTarget}名 − 採用済み${total.alreadyHired}名 ＝ 残り${total.remainingTarget}名で計 ${total.requiredApplied}件）`
                : `（${total.hireTarget}名で計 ${total.requiredApplied}件）`}
            </span>
          )}
        </span>
      </div>

      {choices.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            按分する期間
          </span>
          <MonthSelect label="" value={win.from} choices={choices} onChange={(m) => onWindow({ ...win, from: m })} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            〜
          </span>
          <MonthSelect label="" value={win.to} choices={choices} onChange={(m) => onWindow({ ...win, to: m })} />
        </div>
      )}

      {observed && (
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          取り込み済みの実績では 応募→面接 {pct(observed.interview, observed.applied)}／面接→採用{" "}
          {pct(observed.hire, observed.interview)}（応募{observed.applied}件・面接{observed.interview}件・採用
          {observed.hire}件）。選考が途中の応募も分母に入っているので、募集を始めたばかりだと想定値より低く出ます。
        </p>
      )}
    </div>
  );
}

export function MetricSwitch({ value, onChange }: { value: GoalMetric; onChange: (m: GoalMetric) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {GOAL_METRICS.map((m) => {
        const active = m.key === value;
        return (
          <button
            key={m.key}
            onClick={() => onChange(m.key)}
            title={m.hint}
            aria-pressed={active}
            className="rounded-full border px-2.5 py-1 text-xs"
            style={{
              borderColor: active ? "var(--series-1)" : "var(--hairline)",
              color: active ? "#ffffff" : "var(--text-secondary)",
              background: active ? "var(--series-1)" : "transparent",
              fontWeight: active ? 600 : 400,
            }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function Th({
  children,
  align = "left",
  width,
}: {
  children: ReactNode;
  align?: "left" | "right";
  width?: string;
}) {
  return (
    <th
      className={`px-2 py-1.5 text-xs font-medium ${align === "right" ? "text-right" : "text-left"} whitespace-nowrap`}
      style={{ color: "var(--text-secondary)", width }}
      scope="col"
    >
      {children}
    </th>
  );
}

/** 校舎 × 月の目標と実績。狭い画面ではカードに組み替える。 */
export function MonthlyGoalTable({ goals, metric }: { goals: MonthlyGoals; metric: GoalMetric }) {
  const { months, rows, total } = goals;
  if (rows.length === 0) return null;

  const head = (m: (typeof months)[number]) => (
    <>
      {m.label}
      {m.current && (
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>（途中 {Math.round(m.elapsed * 100)}%）</span>
      )}
    </>
  );

  return (
    <>
      {/* スマホ：校舎ごとのカード */}
      <ul className="space-y-2 sm:hidden">
        {[...(total ? [total] : []), ...rows].map((r) => (
          <li
            key={r.shopShortName}
            className="overflow-hidden rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--gridline)", background: "var(--background)" }}
          >
            <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 font-semibold">
              <ShopName row={r} />
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                必要応募 {r.requiredApplied}件
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              {r.months.map((m, i) => (
                <div key={m.month}>
                  <dt className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {head(months[i])}
                  </dt>
                  <dd>
                    <Cell m={m} metric={metric} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {/* 画面が広いとき：校舎 × 月の表 */}
      <div className="-mx-1 hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
              <Th>校舎（採用目標）</Th>
              <Th align="right">必要応募</Th>
              {months.map((m) => (
                <Th key={m.month} align="right" width={`${Math.floor(62 / months.length)}%`}>
                  {head(m)}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {total && (
              <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
                <td className="px-2 py-1.5 text-xs" style={{ color: "var(--text-primary)" }}>
                  <span className="font-semibold">合計</span> <HireCount row={total} />
                </td>
                <td className="px-2 py-1.5 text-right text-xs tabular" style={{ color: "var(--text-secondary)" }}>
                  {total.requiredApplied}
                </td>
                {total.months.map((m) => (
                  <td key={m.month} className="px-2 py-1.5 align-top">
                    <Cell m={m} metric={metric} />
                  </td>
                ))}
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.shopShortName} style={{ borderBottom: "1px solid var(--hairline)" }}>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <ShopName row={r} />
                </td>
                <td className="px-2 py-1.5 text-right text-xs tabular" style={{ color: "var(--text-secondary)" }}>
                  {r.requiredApplied}
                </td>
                {r.months.map((m) => (
                  <td key={m.month} className="px-2 py-1.5 align-top">
                    <Cell m={m} metric={metric} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
