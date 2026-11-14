import { HrSheet, INTERVIEW_OUTCOME_LABEL, InterviewOutcome, outcomeOf } from "./hrsheet";
import { normalizeShopKey } from "./shops";
import { Week, fmtDate, weekOf, weekRange } from "./week";

/**
 * 週ごとの面接数・内定数・合格率（2026-11-12 指示）。
 *
 * 応募が増えても面接に進まなければ採用は増えないし、面接しても通らなければ同じ。
 * どこで止まっているかを週単位で見るための表。
 *
 * 数え方
 * - 面接数 … 採用管理表の**面接日（R列）がその週**の行。面接日が空の行は数えない。
 * - 内定・見送り・辞退・検討中 … その面接の結果（outcomeOf）。
 *   結果がまだ書かれていない・「採用候補」「相談」で止まっているものは**検討中・不明**。
 * - 合格率 … 内定 ÷（内定＋見送り）。
 *   辞退は本人の都合、検討中はまだ結果が出ていないので、どちらも分母に入れない。
 *   分母に入れると、判定が出ていない週の合格率が実態より低く見える。
 */

export interface InterviewWeekRow {
  week: Week;
  interviews: number;
  byOutcome: Record<InterviewOutcome, number>;
  /** 内定 ÷（内定＋見送り）。まだ判定が1件も出ていない週は null。 */
  rate: number | null;
  /** 面接数を分母にした率。検討中が多い週の見え方を比べるために持つ。 */
  rateOfAll: number | null;
}

export interface InterviewStats {
  rows: InterviewWeekRow[];
  total: Omit<InterviewWeekRow, "week">;
  /** 面接日が入っていない行（まだ面接していない・未記入） */
  noDate: number;
  /** 期間や対象校舎の条件で外した行 */
  excluded: number;
  /** 今日より先の面接日（これから面接する予定） */
  upcoming: number;
}

export const OUTCOMES: InterviewOutcome[] = ["hired", "rejected", "declined", "pending"];
export const OUTCOME_LABEL = INTERVIEW_OUTCOME_LABEL;

/** 表と凡例で同じ色を使う */
export const OUTCOME_COLOR: Record<InterviewOutcome, string> = {
  hired: "var(--status-good)",
  rejected: "var(--text-secondary)",
  declined: "var(--status-warning)",
  pending: "var(--status-serious)",
};

const zero = (): Record<InterviewOutcome, number> => ({ hired: 0, rejected: 0, declined: 0, pending: 0 });

const rateOf = (hired: number, rejected: number) => (hired + rejected > 0 ? hired / (hired + rejected) : null);

export interface InterviewOptions {
  /** 面接日がこの日以降の行だけ数える */
  from?: string | null;
  /** 対象の校舎（normalizeShopKey 済みのキーで判定） */
  include?: (key: string) => boolean;
  /** 今日。テストのために差し替えられるようにしておく */
  today?: Date;
}

export function interviewWeeks(sheet: HrSheet | null, options: InterviewOptions = {}): InterviewStats | null {
  if (!sheet || sheet.rows.length === 0) return null;

  const today = fmtDate(options.today ?? new Date());
  const byWeek = new Map<string, InterviewWeekRow>();
  const total: Omit<InterviewWeekRow, "week"> = {
    interviews: 0,
    byOutcome: zero(),
    rate: null,
    rateOfAll: null,
  };
  let noDate = 0;
  let excluded = 0;
  let upcoming = 0;

  for (const row of sheet.rows) {
    if (options.include && !options.include(normalizeShopKey(row.shopShortName))) {
      excluded++;
      continue;
    }
    const on = row.interviewDate;
    if (!on) {
      noDate++;
      continue;
    }
    if (options.from && on < options.from) {
      excluded++;
      continue;
    }
    if (on > today) upcoming++;

    const week = weekOf(new Date(`${on}T00:00:00`));
    const r =
      byWeek.get(week.key) ??
      ({ week, interviews: 0, byOutcome: zero(), rate: null, rateOfAll: null } as InterviewWeekRow);
    const outcome = outcomeOf(row);
    r.interviews++;
    r.byOutcome[outcome]++;
    byWeek.set(week.key, r);

    total.interviews++;
    total.byOutcome[outcome]++;
  }

  // 条件で全部外れたときは、空の表と「外した行数」を返す。
  // null にすると「採用管理表が無い」と区別が付かず、画面の案内を出し分けられない。
  if (byWeek.size === 0) return { rows: [], total, noDate, excluded, upcoming };

  // 面接が0件の週も行として出す。抜けていると「その週は面接していない」ことが分からない。
  const keys = [...byWeek.values()].map((r) => r.week.start).sort();
  const rows = weekRange(`${keys[0]}T00:00:00`, `${keys[keys.length - 1]}T00:00:00`).map((week) => {
    const r = byWeek.get(week.key) ?? { week, interviews: 0, byOutcome: zero(), rate: null, rateOfAll: null };
    r.rate = rateOf(r.byOutcome.hired, r.byOutcome.rejected);
    r.rateOfAll = r.interviews > 0 ? r.byOutcome.hired / r.interviews : null;
    return r;
  });

  total.rate = rateOf(total.byOutcome.hired, total.byOutcome.rejected);
  total.rateOfAll = total.interviews > 0 ? total.byOutcome.hired / total.interviews : null;

  return { rows, total, noDate, excluded, upcoming };
}
