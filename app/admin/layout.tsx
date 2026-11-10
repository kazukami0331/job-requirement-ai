import Link from "next/link";
import type { Metadata } from "next";
import { getCurrentStaff } from "@/lib/auth";
import { Avatar } from "@/components/admin/bits";
import { logout } from "@/app/admin/actions";

export const metadata: Metadata = {
  title: "SwipeJob 顧客管理",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentStaff().catch(() => null);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/admin" className="font-bold tracking-tight">
            SwipeJob <span className="font-normal text-slate-400">顧客管理</span>
          </Link>
          {me && (
            <>
              <nav className="flex gap-4 text-sm text-slate-600">
                <Link href="/admin" className="hover:text-slate-900">候補者</Link>
                <Link href="/admin/analytics" className="hover:text-slate-900">分析</Link>
                <Link href="/admin/staff" className="hover:text-slate-900">メンバー</Link>
              </nav>
              <div className="ml-auto flex items-center gap-3">
                <Link href="/admin/staff" className="flex items-center gap-2 text-sm text-slate-700">
                  <Avatar name={me.name} color={me.color} size={26} />
                  <span className="hidden sm:inline">{me.name}</span>
                </Link>
                <form action={logout}>
                  <button className="text-xs text-slate-500 hover:text-slate-900">ログアウト</button>
                </form>
              </div>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
