import type { Metadata } from "next";

export const metadata: Metadata = { title: "広告自動運用 管理画面", robots: { index: false, follow: false } };

export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-slate-50 text-slate-900">{children}</div>;
}
