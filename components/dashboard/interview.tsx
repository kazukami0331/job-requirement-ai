"use client";

import { InterviewOutcome } from "@/lib/recruiting/hrsheet";
import { InterviewStats, OUTCOMES, OUTCOME_COLOR, OUTCOME_LABEL } from "@/lib/recruiting/interview";

/**
 * 週ごとの面接数・内定数・合格率。
 *
 * 応募が増えても面接に進まなければ採用は増えない。どこで止まっているかを週で見る表。
 * **まだ結果が出ていない面接（検討中・不明）を内定にも見送りにも混ぜない**のが要点で、
 * 混ぜると直近の週の合格率が実態より良く／悪く見える。
 */

const cell = "px-2 py-1 text-xs tabular whitespace-nowrap";
const WEEK_W = "5.5rem";
const NUM_W = "4rem";
const RATE_W = "7rem";

const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

function Bar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <span className="flex w-full items-center" style={{ height: 5, background: "var(--gridline)", borderRadius: 2 }}>
      <span style={{ height: 5, width: `${ratio * 100}%`, background: color, borderRadius: 2, minWidth: ratio > 0 ? 2 : 0 }} />
    </span>
  );
}

export function InterviewWeeklyTable({ stats }: { stats: InterviewStats }) {
  if (stats.rows.length === 0) return null;

  // 直近の週を下に置く（応募の週次推移と同じ向き）
  const rows = stats.rows;

  const Num = ({ n, outcome }: { n: number; outcome?: InterviewOutcome }) => (
    <span style={{ color: n > 0 ? (outcome ? OUTCOME_COLOR[outcome] : "var(--text-primary)") : "var(--text-muted)" }}>
      {n || "–"}
    </span>
  );

  const Rate = ({ rate, rateOfAll, interviews }: { rate: number | null; rateOfAll: number | null; interviews: number }) => (
    <span
      className="flex items-center gap-1.5"
      title={
        rate === null
          ? "まだ内定・見送りのどちらも出ていない週です"
          : `内定 ÷（内定＋見送り）＝${pct(rate)} ／ 面接数を分母にすると ${pct(rateOfAll)}（面接${interviews}件）`
      }
    >
      <span className="w-8 shrink-0 text-right" style={{ color: rate === null ? "var(--text-muted)" : "var(--text-primary)" }}>
        {pct(rate)}
      </span>
      <span className="min-w-0 flex-1">
        <Bar ratio={rate ?? 0} color="var(--status-good)" />
      </span>
    </span>
  );

  const body = (r: { interviews: number; byOutcome: Record<InterviewOutcome, number>; rate: number | null; rateOfAll: number | null }) => (
    <>
      <td className={`${cell} text-center font-semibold`}>
        <Num n={r.interviews} />
      </td>
      {OUTCOMES.map((o) => (
        <td key={o} className={`${cell} text-center`}>
          <Num n={r.byOutcome[o]} outcome={o} />
        </td>
      ))}
      <td className={`${cell}`}>
        <Rate rate={r.rate} rateOfAll={r.rateOfAll} interviews={r.interviews} />
      </td>
    </>
  );

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: WEEK_W }} />
          <col style={{ width: NUM_W }} />
          {OUTCOMES.map((o) => (
            <col key={o} style={{ width: NUM_W }} />
          ))}
          <col style={{ width: RATE_W }} />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <th className="px-2 pb-1 pt-1.5 text-left text-[11px] font-semibold" style={{ color: "var(--text-secondary)" }}>
              面接の週
            </th>
            <th className="px-2 pb-1 pt-1.5 text-center text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
              面接
            </th>
            {OUTCOMES.map((o) => (
              <th
                key={o}
                className="px-2 pb-1 pt-1.5 text-center text-[11px] font-semibold whitespace-nowrap"
                style={{ color: OUTCOME_COLOR[o] }}
              >
                {OUTCOME_LABEL[o]}
              </th>
            ))}
            <th className="px-2 pb-1 pt-1.5 text-left text-[11px] font-semibold" style={{ color: "var(--text-secondary)" }}>
              合格率
            </th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
              合計
            </td>
            {body(stats.total)}
          </tr>
          {rows.map((r) => (
            <tr key={r.week.key} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={cell} style={{ color: "var(--text-primary)" }} title={`${r.week.start} 〜 ${r.week.end}`}>
                {r.week.label}
              </td>
              {body(r)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
