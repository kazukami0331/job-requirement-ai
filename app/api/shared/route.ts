import { get, put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import type { Backup } from "@/lib/recruiting/storage";

/**
 * みんなで同じ数字を見るための「公開データ」。
 *
 * ダッシュボードの保存先はブラウザのIndexedDBなので、取り込んだ本人以外には何も見えない。
 * URLを渡した先でも同じ数字が出るように、取り込んだ内容をVercel Blobに1ファイルだけ置き、
 * 画面を開いた全員がそれを読む形にしている。
 *
 * 書き込みは DASHBOARD_WRITE_KEY を知っている人だけ。読み取りは誰でもできる
 * （URL自体が社外に渡る前提なので、個人情報は元から取り込んでいない）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "dashboard/shared.json";
/** Vercelのリクエスト上限（4.5MB）に対する余裕を見た上限 */
const MAX_BYTES = 4_000_000;

type Published = Backup & { publishedAt: string };

function miss(name: string) {
  return NextResponse.json(
    { error: `共有保存が未設定です（${name} が入っていません）` },
    { status: 503 }
  );
}

/** 公開データを読む。未設定・未公開でもエラーにはせず、空で返す。 */
export async function GET() {
  const headers = { "cache-control": "no-store" };

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ configured: false, publishedAt: null, data: null }, { headers });
  }

  try {
    // useCache:false を付けないとCDNに載った古い内容が返ることがある
    const blob = await get(PATH, { access: "public", useCache: false });
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      return NextResponse.json({ configured: true, publishedAt: null, data: null }, { headers });
    }

    const data = JSON.parse(await new Response(blob.stream).text()) as Published;
    return NextResponse.json(
      { configured: true, publishedAt: data.publishedAt ?? null, data },
      { headers }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `公開データの読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500, headers }
    );
  }
}

/** 手元のデータを公開データとして上書きする */
export async function PUT(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return miss("BLOB_READ_WRITE_TOKEN");

  const key = process.env.DASHBOARD_WRITE_KEY;
  if (!key) return miss("DASHBOARD_WRITE_KEY");
  if (req.headers.get("x-share-key") !== key) {
    return NextResponse.json({ error: "公開用パスワードが違います" }, { status: 401 });
  }

  const text = await req.text();
  if (text.length > MAX_BYTES) {
    return NextResponse.json(
      { error: "データが大きすぎます。古いスナップショットを削除してから公開してください。" },
      { status: 413 }
    );
  }

  let backup: Backup;
  try {
    backup = JSON.parse(text) as Backup;
  } catch {
    return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 });
  }
  if (backup?.version !== 1 || !Array.isArray(backup.snapshots)) {
    return NextResponse.json({ error: "対応していないバックアップ形式です" }, { status: 400 });
  }

  const publishedAt = new Date().toISOString();

  try {
    await put(PATH, JSON.stringify({ ...backup, publishedAt }), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      // 読み取り側は useCache:false で取るが、念のため短くしておく
      cacheControlMaxAge: 60,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `公開に失敗しました: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  const applications = backup.snapshots.reduce((a, s) => a + s.applications.length, 0);
  return NextResponse.json({ publishedAt, snapshots: backup.snapshots.length, applications });
}
