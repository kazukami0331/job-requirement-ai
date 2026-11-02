/** 管理画面から LP の下書きを見る（ログイン済みのときだけ。状態ブランチの lp-drafts/<id>.html を返す）。 */
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/adops/auth";
import { readFile, stateBranch } from "@/lib/adops/github";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!verifyToken((await cookies()).get("adops_admin")?.value)) return new Response("ログインが必要です", { status: 401 });
  const { id } = await params;
  if (!/^[a-z0-9-]{3,80}$/.test(id)) return new Response("not found", { status: 404 });
  const f = await readFile(`lp-drafts/${id}.html`, stateBranch()).catch(() => null);
  if (!f) return new Response("下書きが見つかりません（公開済み・取り下げ済みの可能性があります）", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  // 管理画面と同じオリジンで開くので、下書きの中身は別オリジン扱い（sandbox）にして管理画面に触れないようにする
  return new Response(f.text, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "content-security-policy": "sandbox allow-scripts" },
  });
}
