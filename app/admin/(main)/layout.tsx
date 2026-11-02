import Link from "next/link";
import { logout, requireAdmin } from "@/lib/adops/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const NAV = [
  ["/admin", "ホーム"],
  ["/admin/jobs", "求人"],
  ["/admin/personas", "ペルソナ"],
  ["/admin/hypotheses", "仮説"],
  ["/admin/rubric", "採点基準"],
  ["/admin/lp", "応募ページ（LP）"],
  ["/admin/settings", "基本設定"],
] as const;

async function doLogout() {
  "use server";
  await logout();
  redirect("/admin/login");
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <Link href="/admin" className="mr-2 font-bold text-blue-800">
            広告自動運用
          </Link>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {NAV.slice(1).map(([href, label]) => (
              <Link key={href} href={href} className="text-slate-700 hover:text-blue-700">
                {label}
              </Link>
            ))}
            <a href="/adops" className="text-slate-700 hover:text-blue-700">
              レポート
            </a>
          </nav>
          <form action={doLogout} className="ml-auto">
            <button className="text-sm text-slate-500 hover:text-slate-800">ログアウト</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </>
  );
}
