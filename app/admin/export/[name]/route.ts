/** 書き出した CSV をダウンロードする（ログイン済みのときだけ。状態ブランチの exports/<name>.csv）。 */
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/adops/auth";
import { readFile, stateBranch } from "@/lib/adops/github";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!verifyToken((await cookies()).get("adops_admin")?.value)) return new Response("ログインが必要です", { status: 401 });
  const { name } = await params;
  if (!/^(creatives|google-rsa)\.csv$/.test(name)) return new Response("not found", { status: 404 });
  const f = await readFile(`exports/${name}`, stateBranch()).catch(() => null);
  if (!f) return new Response("まだ書き出されていません（次の定期実行のあとに作られます）", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(f.text, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}
