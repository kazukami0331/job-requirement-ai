import { NextResponse } from "next/server";

/**
 * 人事チームが更新しているExcelを、サーバー側から直接読みに行く。
 *
 * 画面を開くたびにここを叩くので、ファイルが更新されていればそのまま反映される。
 * 取り込みの操作は要らない。
 *
 * 取り方は2つ。どちらか設定されていれば動く。
 *
 * 1. 共有リンクをそのまま取りに行く（EXCEL_SOURCE_URL）
 *    SharePoint / OneDrive で「リンクを知っている全員」の共有リンクを作れるならこれが一番早い。
 *    Microsoft側の登録作業は要らない。
 *
 * 2. Microsoft Graph（MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET）
 *    社内ポリシーで匿名リンクが作れないとき。Entra ID にアプリを登録し、
 *    Files.Read.All（または Sites.Read.All）の管理者同意が要る。
 *    EXCEL_SOURCE_URL に普通の共有リンク（社内向けで可）を入れておけば、
 *    Graph の /shares から中身を取る。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 取り込んだファイルを何として扱うか。plan＝不足人数マスタ、applications＝応募エクスポート。 */
type SourceKind = "plan" | "applications";

const TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}が${TIMEOUT_MS / 1000}秒以内に終わりませんでした`)), TIMEOUT_MS)
    ),
  ]);
}

/** 共有リンクを Graph の /shares で使える形に直す */
function shareId(url: string): string {
  const b64 = Buffer.from(url, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${b64}`;
}

async function graphToken(): Promise<string> {
  const tenant = process.env.MS_TENANT_ID!;
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    client_secret: process.env.MS_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await withTimeout(
    fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    }),
    "Microsoftの認証"
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Microsoftの認証に失敗しました: ${json.error_description ?? res.status}`);
  return json.access_token as string;
}

async function fetchViaGraph(url: string): Promise<{ bytes: ArrayBuffer; name: string; modified: string | null }> {
  const token = await graphToken();
  const auth = { Authorization: `Bearer ${token}` };
  const base = `https://graph.microsoft.com/v1.0/shares/${shareId(url)}/driveItem`;

  const metaRes = await withTimeout(fetch(base, { headers: auth, cache: "no-store" }), "ファイル情報の取得");
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    throw new Error(`ファイルを開けませんでした（${metaRes.status}）: ${meta?.error?.message ?? ""}`);
  }

  const fileRes = await withTimeout(
    fetch(`${base}/content`, { headers: auth, cache: "no-store" }),
    "ファイルの取得"
  );
  if (!fileRes.ok) throw new Error(`ファイルの取得に失敗しました（${fileRes.status}）`);

  return {
    bytes: await fileRes.arrayBuffer(),
    name: meta?.name ?? "excel.xlsx",
    modified: meta?.lastModifiedDateTime ?? null,
  };
}

async function fetchDirect(url: string): Promise<{ bytes: ArrayBuffer; name: string; modified: string | null }> {
  // SharePoint の共有リンクは、download=1 を付けると中身がそのまま返る
  const target = /sharepoint\.com|1drv\.ms|onedrive\.live\.com/.test(url)
    ? `${url}${url.includes("?") ? "&" : "?"}download=1`
    : url;

  const res = await withTimeout(fetch(target, { cache: "no-store", redirect: "follow" }), "ファイルの取得");
  if (!res.ok) throw new Error(`ファイルの取得に失敗しました（${res.status}）。共有リンクの権限を確認してください`);

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) {
    throw new Error(
      "ファイルではなくログイン画面が返りました。共有リンクが社内限定になっています。Microsoft Graph の設定を使ってください"
    );
  }

  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
  return {
    bytes: await res.arrayBuffer(),
    name: name ? decodeURIComponent(name) : "excel.xlsx",
    modified: res.headers.get("last-modified"),
  };
}

export async function GET() {
  const url = process.env.EXCEL_SOURCE_URL;
  const kind = (process.env.EXCEL_SOURCE_KIND as SourceKind) ?? "plan";
  const headers = { "cache-control": "no-store" };

  if (!url) {
    return NextResponse.json({ configured: false }, { headers });
  }

  const useGraph = Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

  try {
    const file = useGraph ? await fetchViaGraph(url) : await fetchDirect(url);
    return NextResponse.json(
      {
        configured: true,
        via: useGraph ? "graph" : "link",
        kind,
        fileName: file.name,
        lastModified: file.modified,
        fetchedAt: new Date().toISOString(),
        base64: Buffer.from(file.bytes).toString("base64"),
      },
      { headers }
    );
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // fetch の素のエラーは「fetch failed」としか出ないので、何を見ればいいかを添える
    const message = /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(raw)
      ? `ファイルに接続できませんでした（${raw}）。EXCEL_SOURCE_URL のリンクが正しいか確認してください`
      : raw;
    return NextResponse.json({ configured: true, error: message }, { status: 502, headers });
  }
}
