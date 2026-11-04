/** 管理画面で広告の画像を表示する（ログイン済みのときだけ。状態ブランチの assets/<広告ID>/<ファイル>）。 */
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/adops/auth";
import { stateBranch } from "@/lib/adops/github";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!verifyToken((await cookies()).get("adops_admin")?.value)) return new Response("ログインが必要です", { status: 401 });
  const { path } = await params;
  const rel = path.join("/");
  if (!/^[\w.-]+\/[\w.-]+\.(jpg|jpeg|png)$/.test(rel) || rel.includes("..")) return new Response("not found", { status: 404 });
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) return new Response("not configured", { status: 500 });
  const res = await fetch(`${(process.env.ADOPS_GITHUB_API || "https://api.github.com").replace(/\/$/, "")}/repos/${repo}/contents/assets/${rel}?ref=${encodeURIComponent(stateBranch())}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (!res.ok) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(await res.arrayBuffer()), { headers: { "content-type": rel.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "private, max-age=300" } });
}

