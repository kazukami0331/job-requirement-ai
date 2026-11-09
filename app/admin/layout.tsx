import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SwipeJob 候補者ダッシュボード",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/admin" className="font-bold tracking-tight">
            SwipeJob <span className="text-slate-400 font-normal">管理</span>
          </Link>
          <nav className="text-sm text-slate-600">
            <Link href="/admin" className="hover:text-slate-900">候補者一覧</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
