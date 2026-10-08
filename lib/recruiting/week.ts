/** 週次集計のための週ユーティリティ（週の開始は月曜） */

export interface Week {
  /** 2026-W38 形式のキー（ソート可能） */
  key: string;
  /** 週の月曜 YYYY-MM-DD */
  start: string;
  /** 週の日曜 YYYY-MM-DD */
  end: string;
  /** 表示用ラベル 例: 9/14週 */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function toDateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** その日を含む週の月曜を返す */
export function weekStart(date: Date): Date {
  const d = toDateOnly(date);
  // getDay(): 0=日, 1=月 ... 月曜起点にするため日曜を7扱いにする
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1));
  return d;
}

/** ISO週番号 */
function isoWeekNumber(date: Date): { year: number; week: number } {
  const d = toDateOnly(date);
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  // ISO週は木曜日が属する年に紐づく
  d.setDate(d.getDate() + 4 - dow);
  const year = d.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { year, week };
}

export function weekOf(date: Date): Week {
  const start = weekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const { year, week } = isoWeekNumber(start);
  return {
    key: `${year}-W${pad(week)}`,
    start: fmtDate(start),
    end: fmtDate(end),
    label: `${start.getMonth() + 1}/${start.getDate()}週`,
  };
}

export function weekOfIso(iso: string): Week {
  return weekOf(new Date(iso));
}

/** from〜to の間の週を、データが無い週も含めて連続で列挙する */
export function weekRange(fromIso: string, toIso: string): Week[] {
  const out: Week[] = [];
  const cursor = weekStart(new Date(fromIso));
  const last = weekStart(new Date(toIso));
  // 週が飛ばないよう、上限を付けて安全にループする（約4年分）
  for (let i = 0; i < 220 && cursor <= last; i++) {
    out.push(weekOf(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}
