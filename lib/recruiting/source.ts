import { HiringPlan, Snapshot } from "@/types/recruiting";

/**
 * 人事チームが更新しているExcelを、サーバー経由で取りに行く。
 *
 * 画面を開いたときに自動で読みに行くので、取り込みの操作をしなくても最新になる。
 * 設定されていない環境では configured:false が返るだけで、何も起きない。
 *
 * ファイルの読み取りはサーバー側で済ませ、ここへ返ってくるのは集計に使う項目だけ。
 * 氏名・連絡先・住所は元から読まず、年齢・性別も落としてある。
 */

export interface ExternalSource {
  configured: boolean;
  /** link＝共有リンクをそのまま取得、graph＝Microsoft Graph 経由 */
  via?: "link" | "graph";
  /** plan＝不足人数マスタ、applications＝応募エクスポート */
  kind?: "plan" | "applications";
  fileName?: string;
  /** Excel側の最終更新日時。これが変わっていなければ取り込み直さない。 */
  lastModified?: string | null;
  fetchedAt?: string;
  /** 不足人数マスタとして読んだ結果 */
  plan?: HiringPlan;
  /** 応募エクスポートとして読んだ結果 */
  snapshot?: Snapshot;
  count?: number;
  error?: string;
}

export async function fetchExternalSource(): Promise<ExternalSource | null> {
  try {
    const res = await fetch("/api/source", { cache: "no-store" });
    const body = (await res.json()) as ExternalSource;
    return body;
  } catch {
    // 外部ファイルが読めなくても、手元のデータで使えればよい
    return null;
  }
}
