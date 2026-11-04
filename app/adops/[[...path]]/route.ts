/**
 * adops の運用レポートを表示する（https://<Vercel のドメイン>/adops）。
 *
 * レポート（report.html）と画像は GitHub の adops-state ブランチにあるので、GitHub API から取って返す。
 * Basic 認証で保護する。
 *
 * 必要な環境変数（Vercel）:
 *   ADOPS_REPORT_PASSWORD   閲覧パスワード（必須。ユーザー名は ADOPS_REPORT_USER、既定 adops）
 *   ADOPS_GITHUB_TOKEN      リポジトリの contents:read 権限を持つトークン（fine-grained 推奨）
 *   ADOPS_GITHUB_REPO       owner/repo（例: kazukami0331/job-requirement-ai）
 *   ADOPS_STATE_BRANCH      既定 adops-state
 */
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorized(req: Request): boolean {
  const password = process.env.ADOPS_REPORT_PASSWORD;
  if (!password) return false;
  const user = process.env.ADOPS_REPORT_USER || "adops";
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  const [u, ...rest] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return safeEqual(u, user) && safeEqual(rest.join(":"), password);
}

export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  if (!authorized(req)) {
    return new Response("認証が必要です", { status: 401, headers: { "www-authenticate": 'Basic realm="adops", charset="UTF-8"' } });
  }
  const { path = [] } = await params;
  const rel = path.length ? path.join("/") : "report.html";
  // 状態ブランチの中の、レポートと素材だけを返す（state.json などは返さない）
  if (rel.includes("..") || !(rel === "report.html" || /^assets\/[\w.-]+\/[\w.-]+\.(jpg|jpeg|png|mp4|svg)$/.test(rel) || /^exports\/[\w-]+\.csv$/.test(rel) || /^lp-drafts\/[a-z0-9-]+\.html$/.test(rel))) {
    return new Response("not found", { status: 404 });
  }
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) return new Response("ADOPS_GITHUB_REPO / ADOPS_GITHUB_TOKEN が未設定です", { status: 500 });
  const branch = process.env.ADOPS_STATE_BRANCH || "adops-state";
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${rel}?ref=${encodeURIComponent(branch)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (!res.ok) return new Response(res.status === 404 ? "まだレポートがありません" : `GitHub ${res.status}`, { status: res.status === 404 ? 404 : 502 });
  const ext = rel.split(".").pop() ?? "";
  // report.html の中の画像は相対パス（assets/...）なので、/adops/ 配下で解決されるよう base を入れる
  if (rel === "report.html") {
    const html = (await res.text()).replace("<head>", '<head><base href="/adops/">');
    return new Response(html, { headers: { "content-type": TYPES.html, "cache-control": "no-store" } });
  }
  // LP の下書きはそのまま返す（承認前の確認用。公開は /lp/<id>）
  if (rel.startsWith("lp-drafts/")) {
    return new Response(await res.text(), { headers: { "content-type": TYPES.html, "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }
  if (ext === "csv") {
    return new Response(Buffer.from(await res.arrayBuffer()), { headers: { "content-type": TYPES.csv, "content-disposition": `attachment; filename="${rel.split("/").pop()}"`, "cache-control": "no-store" } });
  }
  const type = TYPES[ext] ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  // 動画は Range（部分取得）に応える。iPhone の Safari は 206 応答が無いと再生できない。
  // 1回の応答は最大 1MB にして、サーバーレス関数の応答サイズ上限にもかからないようにする
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range) {
    const CHUNK = 1024 * 1024;
    let start = range[1] ? Number(range[1]) : Math.max(0, buf.length - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : buf.length - 1;
    if (!range[1] && !range[2]) start = 0;
    end = Math.min(end, start + CHUNK - 1, buf.length - 1);
    if (start >= buf.length || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${buf.length}` } });
    }
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${buf.length}`,
        "content-length": String(end - start + 1),
        "cache-control": "private, max-age=300",
      },
    });
  }
  return new Response(buf, {
    headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(buf.length), "cache-control": "private, max-age=300" },
  });
}
