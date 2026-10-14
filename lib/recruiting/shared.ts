import { Backup } from "./storage";

/**
 * 公開データ（サーバーに1つだけ置いてある共有データ）とのやりとり。
 *
 * 取り込み自体はこれまで通りブラウザの中で完結させ、
 * 「公開データを更新」を押したときだけサーバーへ送る。
 * 画面を開いた人は全員、起動時にここから最新を取りに行くので、
 * URLを渡した先にも同じ数字が出る。
 */

export interface SharedState {
  /** サーバー側に保存先（Vercel Blob）が設定されているか */
  configured: boolean;
  publishedAt: string | null;
  data: Backup | null;
}

export async function fetchShared(): Promise<SharedState | null> {
  try {
    const res = await fetch("/api/shared", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SharedState;
  } catch {
    // 公開データが読めなくても、手元のデータで使えればよい
    return null;
  }
}

export interface PublishResult {
  publishedAt: string;
  snapshots: number;
  applications: number;
}

export async function publishShared(backup: Backup, key: string): Promise<PublishResult> {
  const res = await fetch("/api/shared", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-share-key": key },
    body: JSON.stringify(backup),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `公開に失敗しました（${res.status}）`);
  return body as PublishResult;
}
