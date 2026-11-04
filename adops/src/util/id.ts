import { randomBytes } from 'node:crypto';

/** 人が読んで並べられる ID（接頭辞 + 日本時間の日付 + 乱数）。 */
export function newId(prefix: string, now = new Date()): string {
  return `${prefix}_${jstDate(now).replaceAll('-', '')}_${randomBytes(3).toString('hex')}`;
}

/** 日本時間の YYYY-MM-DD。実行環境のタイムゾーンに依存させない。 */
export function jstDate(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD に日数を足す。 */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 2つの YYYY-MM-DD の差（日数）。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
