"use client";

import { ReactNode, useState } from "react";
import { GoalRates, GoalWindow, MonthGoal, MonthlyGoals, ShopGoalRow, appliesPerHire } from "@/lib/recruiting/goal";
import { ratioLabel } from "@/lib/recruiting/format";
import { UrgentName } from "./tables";
import { normalizeShopKey } from "@/lib/recruiting/shops";

/** 表に出す指標。目標も実績も同じ形で持っているので切り替えるだけで済む。 */
export type GoalMetric = "applied" | "interview" | "hire";

/** 「すべて」は3指標を1マスに縦に並べる。単体は棒つきで1指標だけを見る。 */
export type GoalView = GoalMetric | "all";

export const GOAL_METRICS: { key: GoalMetric; label: string; short: string; hint: string }[] = [
  { key: "applied", label: "応募", short: "応募", hint: "その月に受け付けた応募" },
  { key: "interview", label: "面接設定", short: "面接", hint: "その月に応募した人のうち、面接日が確定した数" },
  { key: "hire", label: "採用", short: "採用", hint: "その月に応募した人のうち、採用まで進んだ数" },
];

const GOAL_VIEWS: { key: GoalView; label: string; hint: string }[] = [
  { key: "all", label: "すべて", hint: "応募・面接設定・採用を1マスにまとめて出す" },
  ...GOAL_METRICS.map((m) => ({ key: m.key as GoalView, label: m.label, hint: m.hint })),
];

/**
 * 月の目標と実績。
 *
 * 採用だけは「充足に効いた人数」を実績にする。目標3名の校舎で5名採れても、
 * はみ出た2名は他の校舎の不足を埋めないので、進捗には乗せない。
 * 消すと実際に採った人数が見えなくなるので、はみ出たぶんは over として別に返す。
 */
function pick(m: MonthGoal, metric: GoalMetric): { target: number; actual: number; over: number } {
  if (metric === "interview") return { target: m.targetInterview, actual: m.interviewActual, over: 0 };
  if (metric === "hire")
    return {
      target: m.targetHire,
      actual: m.hireFilledActual,
      over: m.hireActual - m.hireFilledActual,
    };
  return { target: m.targetApplied, actual: m.appliedActual, over: 0 };
}

/** 目標を超えて採れたぶん。進捗には乗らないが、採った事実は消さない。 */
function Over({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span style={{ color: "var(--text-muted)" }} title="目標を超えて採れたぶん。他の校舎の不足は埋まらないので、進捗には含めていません">
      {" "}
      +{n}
    </span>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** 目標を置いていない月。0 と書くと「未達」に見えるので、対象外だと分かる形にする。 */
const fmtTarget = (n: number) => (n > 0 ? fmt(n) : "—");

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

function Bar({ ratio, color, height = 6 }: { ratio: number; color: string; height?: number }) {
  return (
    <span
      className="flex w-full items-center"
      style={{ height, background: "var(--gridline)", borderRadius: 2 }}
    >
      <span
        style={{
          height,
          width: `${ratio * 100}%`,
          background: color,
          borderRadius: 2,
          minWidth: ratio > 0 ? 2 : 0,
        }}
      />
    </span>
  );
}

const Dash = () => (
  <div className="text-xs" style={{ color: "var(--text-muted)" }} title="この月は目標の対象外です">
    —
  </div>
);

/**
 * 実績/目標を1マスに収めたもの。棒は目標を100%とした埋まり具合。
 *
 * 3指標をまとめて出すときは棒を細くする。太いままだと1マスに3本入って
 * 行が間延びし、校舎を縦に見比べられなくなるため。
 */
function Cell({ m, view, showLabels = true }: { m: MonthGoal; view: GoalView; showLabels?: boolean }) {
  const elapsed = m.current ? m.elapsed : 0;

  if (view === "all") {
    // 期間の対象外（目標も実績も無い）だけをハイフンにする。
    // 実績列は0件でも0と出す。応募が来なかったことも読みたい数字なので、消してはいけない。
    if (!m.actualOnly && GOAL_METRICS.every((g) => pick(m, g.key).target <= 0 && pick(m, g.key).actual === 0)) {
      // 行の高さは他の月と揃える。ここだけ詰まると、左の月とラベルの位置がずれる。
      return (
        <div className="space-y-1">
          {GOAL_METRICS.map((g) => (
            <div key={g.key}>
              <div className="flex items-baseline justify-between gap-1.5 text-[11px] whitespace-nowrap">
                <span style={{ color: "var(--text-muted)" }}>{showLabels ? g.short : ""}</span>
                <span style={{ color: "var(--text-muted)" }}>—</span>
              </div>
              <Bar ratio={0} color="transparent" height={3} />
            </div>
          ))}
        </div>
      );
    }
    if (m.actualOnly) {
      // 按分期間より前の月。目標が無いので実績だけを出す。
      // 棒が無いぶん行が詰まって、隣の月と高さがずれるので、同じ高さの空きを入れる。
      return (
        <div className="space-y-1">
          {GOAL_METRICS.map((g) => (
            <div key={g.key}>
              <div className="flex items-baseline justify-between gap-1.5 text-[11px] whitespace-nowrap">
                <span style={{ color: "var(--text-muted)" }}>{showLabels ? g.short : ""}</span>
                <span className="tabular" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {fmt(pick(m, g.key).actual)}
                  <Over n={pick(m, g.key).over} />
                </span>
              </div>
              <Bar ratio={0} color="transparent" height={3} />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-1">
        {GOAL_METRICS.map((g) => {
          const { target, actual, over } = pick(m, g.key);
          const color = tone(actual, target, elapsed);
          return (
            <div key={g.key}>
              <div className="flex items-baseline justify-between gap-1.5 text-[11px] whitespace-nowrap">
                {/* 行の高さは揃うので、見出しは左端の月だけに出す。全部の月に出すと
                    25校舎ぶんでラベルが100個並んで、肝心の数字が埋もれる。 */}
                <span style={{ color: "var(--text-muted)" }}>{showLabels ? g.short : ""}</span>
                <span className="tabular">
                  <span style={{ color, fontWeight: 600 }}>{fmt(actual)}</span>
                  <Over n={over} />
                  <span style={{ color: "var(--text-muted)" }}> / {fmtTarget(target)}</span>
                </span>
              </div>
              <Bar ratio={target > 0 ? Math.min(actual / target, 1) : 0} color={color} height={3} />
            </div>
          );
        })}
      </div>
    );
  }

  const { target, actual, over } = pick(m, view);
  if (!m.actualOnly && target <= 0 && actual === 0 && over === 0) return <Dash />;
  if (m.actualOnly) {
    return (
      <div className="text-xs tabular whitespace-nowrap" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
        {fmt(actual)}
        <Over n={over} />
      </div>
    );
  }
  const color = tone(actual, target, elapsed);

  return (
    <div className="space-y-1">
      <div className="text-xs tabular whitespace-nowrap">
        <span style={{ color, fontWeight: 600 }}>{fmt(actual)}</span>
        <Over n={over} />
        <span style={{ color: "var(--text-muted)" }}> / {fmtTarget(target)}</span>
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
    <>
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
              {m.actualOnly ? "実績のみ" : m.current ? `途中・${Math.round(m.elapsed * 100)}%経過` : m.month.replace("-", "/")}
            </span>
          </div>
          <dl className="space-y-1.5">
            {GOAL_METRICS.map((metric) => {
              const { target, actual, over } = pick(m, metric.key);
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
                    <span style={{ color: m.actualOnly ? "var(--text-primary)" : color, fontWeight: 600 }}>
                      {fmt(actual)}
                    </span>
                    <Over n={over} />
                    {!m.actualOnly && <span style={{ color: "var(--text-muted)" }}> / {fmtTarget(target)}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </li>
      ))}
      </ul>
    </>
  );
}

/**
 * 採用の充足ぐあい。「採用3名（済2・残1）」だと3名が目標なのか採れた数なのか読めないという
 * 指摘があったので、どの数字が何なのかを毎回名前で書く。
 */
/**
 * 採用の進み具合。「採用済み / 目標（残り）」の並びにしている。
 * 目標・採用済み・残りを別々に書くと、2名なのか1名充足して残り2名なのかが読み取れないため。
 */
/**
 * 採用の進み具合。「採用 / 目標（率） 残りN名」。
 *
 * 目標3名のところに4名採れたら 4/3（133%）残り0名 と出す。
 * 超過したぶんは他の校舎の不足を埋めないので、残りは0で止める。
 */
function HireCount({ row, short = [] }: { row: ShopGoalRow; short?: string[] }) {
  const rate = row.hireTarget > 0 ? ratioLabel(row.alreadyHired, row.hireTarget) : null;
  return (
    <span style={{ color: "var(--text-muted)" }}>
      {/* 人数が足りていても、埋まっていないコースがあれば緑にしない */}
      <span
        style={{
          color:
            row.alreadyHired === 0
              ? "var(--text-muted)"
              : short.length > 0
                ? "var(--status-warning)"
                : "var(--status-good)",
          fontWeight: 600,
        }}
      >
        {row.alreadyHired}
      </span>
      {" / "}
      {row.hireTarget}名{rate && `（${rate}）`} 残り
      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{row.remainingTarget}</span>名
    </span>
  );
}

/**
 * 月次目標の前提を、短い箇条書きで出す。
 *
 * 文章で続けて書くと読まれないので、「数字 ＝ 中身」の形で1行ずつ並べる。
 */
export function GoalFacts({ goals, rates }: { goals: MonthlyGoals; rates: GoalRates }) {
  const t = goals.total;
  if (!t) return null;

  const perHire = appliesPerHire(rates);
  const over = t.alreadyHired - t.filledHired;
  const spread = t.months.reduce((a, m) => a + m.targetHire, 0);
  const win = t.months.filter((m) => !m.actualOnly);
  const first = win[0]?.label ?? "";
  const last = win[win.length - 1]?.label ?? "";
  const day = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "");

  const facts: [string, string, string][] = [
    [
      "採用",
      `${t.alreadyHired}名`,
      `${day(t.hiredFrom)}〜${day(t.hiredTo)}に決まった採用。上のKPI・週次グラフの緑と同じ`,
    ],
    [
      "充足",
      `${t.filledHired}名`,
      over > 0 ? `採用${t.alreadyHired}名のうち${over}名は目標超過。他校舎の不足は埋めないので充足に入れない` : "採用がそのまま目標の充足になっている",
    ],
    ["残り", `${t.remainingTarget}名`, `採用目標${t.hireTarget}名 − 充足${t.filledHired}名`],
    [
      `${first}〜${last}の目標`,
      `${spread}名`,
      `${first}の時点で残っていた人数。期間中に採れても動かさない`,
    ],
    [
      "必要応募",
      `${t.requiredApplied}件`,
      perHire === null
        ? ""
        : `${spread}名 × ${perHire.toFixed(1)}件（1名採るのに必要な応募）。校舎ごとに端数を切り上げ`,
    ],
  ];

  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
      {facts.map(([label, value, note]) => (
        <div key={label} className="flex flex-wrap items-baseline gap-x-1.5">
          <dt style={{ color: "var(--text-secondary)" }}>{label}</dt>
          <dd className="font-semibold tabular" style={{ color: "var(--text-primary)" }}>
            {value}
          </dd>
          {note && (
            <dd className="w-full text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
              {note}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

function ShopName({ row, short = [] }: { row: ShopGoalRow; short?: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 text-xs" title={row.deadlineNote}>
      <UrgentName name={row.shopShortName} urgent={row.urgent} />
      <ShortCourses names={short} />
      <HireCount row={row} short={short} />
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
  const pct = ratioLabel;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RateInput label="応募→面接" value={rates.applyToInterview} onChange={(v) => onRates({ ...rates, applyToInterview: v })} />
        <RateInput label="面接→採用" value={rates.interviewToHire} onChange={(v) => onRates({ ...rates, interviewToHire: v })} />
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          1名採用に必要な応募
          <strong className="tabular" style={{ color: "var(--text-primary)" }}>
            {" "}
            {perHire === null ? "—" : perHire.toFixed(1)}{" "}
          </strong>
          件
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

      {/* 色が読めていないと緊急校舎が1つも出ない。黙って消えるより、その場で気づけるようにする。 */}
      {goals.rows.length > 0 && goals.rows.every((r) => !r.urgent) && (
        <p className="text-[11px]" style={{ color: "var(--status-serious)" }}>
          緊急（オレンジ塗り）の校舎が1つも読み取れていません。不足人数マスタをCSVで取り込むとセルの色が落ちるので、
          xlsxのまま取り込み直してください。
        </p>
      )}

      {observed && (
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          実績の歩留まり：応募→面接 {pct(observed.interview, observed.applied)}／面接→採用{" "}
          {pct(observed.hire, observed.interview)}（応募{observed.applied}・面接{observed.interview}・採用
          {observed.hire}）。選考中の応募も分母に入るため、低めに出ます。
        </p>
      )}
    </div>
  );
}

export function MetricSwitch({ value, onChange }: { value: GoalView; onChange: (m: GoalView) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {GOAL_VIEWS.map((m) => {
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

/**
 * 表に入っていない応募の件数。
 *
 * 不足人数マスタに無い校舎の応募は行が無いので合計にも入らない。
 * 数字だけ見ると応募が実際より少なく見えるので、差を明示する。
 */
export function Coverage({ goals }: { goals: MonthlyGoals }) {
  const { inTable, all, missing } = goals.coverage;
  const gap = all - inTable;
  if (all === 0 || gap <= 0) return null;

  // 校舎名を出す。名前の書き方が違うだけで落ちている校舎を見つけられるようにするため。
  const top = missing.slice(0, 8);
  const rest = missing.length - top.length;

  return (
    <p className="text-[11px] leading-relaxed" style={{ color: "var(--status-serious)" }}>
      この期間の応募 {all}件のうち、表に出ているのは {inTable}件です。残る {gap}
      件は不足人数マスタに採用目標が無いため、どの行にも入っていません（合計にも含まれません）。
      {top.length > 0 && (
        <>
          {" "}内訳: {top.map((m) => `${m.shopShortName} ${m.count}件`).join(" / ")}
          {rest > 0 ? ` ほか${rest}校舎` : ""}。
          マスタに載っているはずの校舎がここに出ていたら、名前の書き方がマスタと違っています。
        </>
      )}
    </p>
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
type SortKey = "default" | "shop" | "hired" | "fill" | "remaining" | "required" | `m${number}`;

/** 並び替え。見出しを押すたびに 降順 → 昇順 → 既定 と戻る。 */
function useSort() {
  const [key, setKey] = useState<SortKey>("default");
  const [asc, setAsc] = useState(false);
  const toggle = (k: SortKey) => {
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

function sortRows(rows: ShopGoalRow[], key: SortKey, asc: boolean, metric: GoalMetric): ShopGoalRow[] {
  if (key === "default") return rows;
  const num = (r: ShopGoalRow): number | string => {
    if (key === "shop") return r.shopShortName;
    if (key === "hired") return r.alreadyHired;
    if (key === "fill") return r.fillRate ?? -1;
    if (key === "remaining") return r.remainingTarget;
    if (key === "required") return r.requiredApplied;
    const i = Number(key.slice(1));
    const m = r.months[i];
    if (!m) return 0;
    return metric === "applied" ? m.appliedActual : metric === "interview" ? m.interviewActual : m.hireActual;
  };
  return [...rows].sort((a, b) => {
    const x = num(a);
    const y = num(b);
    const d = typeof x === "string" ? String(x).localeCompare(String(y), "ja") : (x as number) - (y as number);
    return asc ? d : -d;
  });
}

/** 並び替えできる見出し。押せることが分かるよう、効いている列には矢印を出す。 */
function SortTh({
  children,
  sortKey,
  state,
  align = "right",
  width,
}: {
  children: ReactNode;
  sortKey: SortKey;
  state: ReturnType<typeof useSort>;
  align?: "left" | "right";
  width?: string;
}) {
  const on = state.key === sortKey;
  return (
    <th
      scope="col"
      className={`px-2 py-1.5 text-[11px] font-medium whitespace-nowrap ${align === "right" ? "text-right" : "text-left"}`}
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

/** 月のセル。表として読めるよう、実績 / 目標 の1行だけにする。 */
function MonthCell({ m, metric }: { m: MonthGoal; metric: GoalMetric }) {
  const { target, actual, over } = pick(m, metric);
  if (!m.actualOnly && target <= 0 && actual === 0 && over === 0) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  const color = tone(actual, target, m.current ? m.elapsed : 0);
  return (
    <span className="tabular whitespace-nowrap">
      <span style={{ color: m.actualOnly ? "var(--text-primary)" : color, fontWeight: 600 }}>{fmt(actual)}</span>
      <Over n={over} />
      {!m.actualOnly && <span style={{ color: "var(--text-muted)" }}> / {fmtTarget(target)}</span>}
    </span>
  );
}

/**
 * 人数では目標に届いている校舎だけ、埋まっていないコース名を返す。
 *
 * まだ足りていない校舎（1 / 3 など）は数字を見れば分かるので出さない。
 * 紛らわしいのは「3 / 3 100%」なのにCADが空、という校舎だけ。
 */
function misleading(row: ShopGoalRow, shortCourses?: Map<string, string[]>): string[] {
  if (row.hireTarget <= 0 || row.alreadyHired < row.hireTarget) return [];
  return shortCourses?.get(normalizeShopKey(row.shopShortName)) ?? [];
}

/**
 * 「人数は足りているが、埋まっていないコースがある」校舎に出す印。
 *
 * この表の採用数はジョブオプ、コースの充足は採用管理表（Excel）から取っている。
 * 校舎の人数だけ見ていると、ITを2名採った校舎がCADゼロのまま100%に見えるため、
 * 足りていないコース名をそのまま出す。
 */
function ShortCourses({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span
      className="ml-1 rounded px-1 py-0.5 text-[10px] whitespace-nowrap"
      title={`採用管理表では ${names.join("・")} がまだ埋まっていません`}
      style={{
        color: "var(--status-warning)",
        background: "color-mix(in srgb, var(--status-warning) 14%, transparent)",
      }}
    >
      {names.join("・")}未
    </span>
  );
}

export function MonthlyGoalTable({
  goals,
  view,
  shortCourses,
}: {
  goals: MonthlyGoals;
  view: GoalView;
  /** 校舎キー（normalizeShopKey 済み）→ 埋まっていないコース名。採用管理表を取り込んでいるときだけ渡す。 */
  shortCourses?: Map<string, string[]>;
}) {
  const { months, rows, total } = goals;
  const sort = useSort();
  // 「すべて」のときは、月の列に何を出すか決められないので採用を基準に並べる
  const metric: GoalMetric = view === "all" ? "hire" : view;
  const sorted = sortRows(rows, sort.key, sort.asc, metric);
  const shown: GoalMetric[] = view === "all" ? GOAL_METRICS.map((g) => g.key) : [view];

  if (rows.length === 0) return null;

  const head = (m: (typeof months)[number]) => (
    <>
      {m.label}
      {m.actualOnly ? (
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>（実績）</span>
      ) : (
        m.current && (
          <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>（途中 {Math.round(m.elapsed * 100)}%）</span>
        )
      )}
    </>
  );

  /** 1校舎ぶんの行。「すべて」のときは指標ごとに3行に分け、校舎名などは縦につなげる。 */
  const shopRows = (r: ShopGoalRow, bold: boolean) => {
    const short = bold ? [] : misleading(r, shortCourses);
    return shown.map((key, i) => (
      <tr
        key={`${r.shopShortName}|${key}`}
        style={{ borderBottom: i === shown.length - 1 ? "1px solid var(--hairline)" : undefined }}
      >
        {i === 0 && (
          <>
            <td className="px-2 py-1 whitespace-nowrap" rowSpan={shown.length}>
              {bold ? (
                <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                  合計
                </span>
              ) : (
                <span className="text-xs" title={r.deadlineNote}>
                  <UrgentName name={r.shopShortName} urgent={r.urgent} />
                  <ShortCourses names={short} />
                </span>
              )}
            </td>
            <td className="px-2 py-1 text-right text-xs tabular" rowSpan={shown.length}>
              {/* 人数が足りていても、埋まっていないコースがあれば緑にしない */}
              <span
                style={{
                  color:
                    r.alreadyHired === 0
                      ? "var(--text-muted)"
                      : short.length > 0
                        ? "var(--status-warning)"
                        : "var(--status-good)",
                  fontWeight: 600,
                }}
              >
                {r.alreadyHired}
              </span>
              <span style={{ color: "var(--text-muted)" }}> / {r.hireTarget}</span>
            </td>
            <td
              className="px-2 py-1 text-right text-xs tabular"
              rowSpan={shown.length}
              // 100% と出ていてもコースが埋まっていないことがあるので、色をそろえる
              style={{ color: short.length > 0 ? "var(--status-warning)" : "var(--text-secondary)" }}
            >
              {r.fillRate === null ? "—" : ratioLabel(r.filledHired, r.hireTarget)}
            </td>
            <td
              className="px-2 py-1 text-right text-xs tabular font-semibold"
              rowSpan={shown.length}
              style={{ color: "var(--text-primary)" }}
            >
              {r.remainingTarget}
            </td>
            <td
              className="px-2 py-1 text-right text-xs tabular"
              rowSpan={shown.length}
              style={{ color: "var(--text-secondary)" }}
            >
              {r.requiredApplied}
            </td>
          </>
        )}
        {shown.length > 1 && (
          <td className="px-2 py-1 text-[11px] whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
            {GOAL_METRICS.find((g) => g.key === key)?.short}
          </td>
        )}
        {r.months.map((m) => (
          <td key={m.month} className="px-2 py-1 text-right text-xs">
            <MonthCell m={m} metric={key} />
          </td>
        ))}
      </tr>
    ));
  };

  return (
    <>
      {/* スマホ：校舎ごとのカード */}
      <ul className="space-y-2 sm:hidden">
        {[...(total ? [total] : []), ...sorted].map((r) => (
          <li
            key={r.shopShortName}
            className="overflow-hidden rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--gridline)", background: "var(--background)" }}
          >
            <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 font-semibold">
              <ShopName row={r} short={misleading(r, shortCourses)} />
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
                    <Cell m={m} view={view} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {/* 画面が広いとき：校舎 × 月の表。見出しを押すと並び替わる。 */}
      <div className="-mx-1 hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
              <SortTh sortKey="shop" state={sort} align="left">
                校舎
              </SortTh>
              <SortTh sortKey="hired" state={sort}>
                採用 / 目標
              </SortTh>
              <SortTh sortKey="fill" state={sort}>
                充足率
              </SortTh>
              <SortTh sortKey="remaining" state={sort}>
                残り
              </SortTh>
              <SortTh sortKey="required" state={sort}>
                必要応募
              </SortTh>
              {shown.length > 1 && <Th>指標</Th>}
              {months.map((m, i) => (
                <SortTh key={m.month} sortKey={`m${i}` as SortKey} state={sort}>
                  {head(m)}
                </SortTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {total && shopRows(total, true)}
            {sorted.map((r) => shopRows(r, false))}
          </tbody>
        </table>
      </div>
    </>
  );
}
