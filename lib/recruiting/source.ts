/**
 * 人事チームが更新しているExcelを、サーバー経由で取りに行く。
 *
 * 画面を開いたときに自動で読みに行くので、取り込みの操作をしなくても最新になる。
 * 設定されていない環境では configured:false が返るだけで、何も起きない。
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
  base64?: string;
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

export function toArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
