/**
 * adops が作り、人が承認した応募ページ（LP）を公開する（https://<Vercel のドメイン>/lp/<id>）。
 *
 * 承認された LP の HTML は GitHub の adops-state ブランチの lp/<id>.html にあるので、GitHub API から取って返す。
 * 下書き（lp-drafts/）は返さない（下書きはレポート画面 /adops/lp-drafts/<id>.html で認証つきで確認する）。
 * 広告から多くの人が来るので、CDN に5分キャッシュさせる（承認・取り下げの反映は最大5分遅れる）。
 *
 * 必要な環境変数（Vercel。レポート画面と共用）:
 *   ADOPS_GITHUB_TOKEN   リポジトリの contents:read 権限を持つトークン
 *   ADOPS_GITHUB_REPO    owner/repo
 *   ADOPS_STATE_BRANCH   既定 adops-state
 */
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9-]{3,80}$/.test(id)) return new Response("not found", { status: 404 });
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) return new Response("not configured", { status: 500 });
  const branch = process.env.ADOPS_STATE_BRANCH || "adops-state";
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/lp/${id}.html?ref=${encodeURIComponent(branch)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (res.status === 404) {
    return new Response("<!doctype html><meta charset=utf-8><title>募集は終了しました</title><p style=\"font-family:sans-serif;padding:24px\">このページの募集は終了しました。</p>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=60" },
    });
  }
  if (!res.ok) return new Response("一時的に表示できません", { status: 502 });
  return new Response(await res.text(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
