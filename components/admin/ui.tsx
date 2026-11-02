/** 管理画面の共通部品（サーバーコンポーネント）。 */
import Link from "next/link";
import type { ReactNode } from "react";

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-slate-900">{children}</h1>
      {sub ? <p className="mt-1 text-sm text-slate-600">{sub}</p> : null}
    </div>
  );
}

export function Card({ children, title, actions }: { children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-lg font-semibold text-slate-900">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 保存結果などのお知らせ（URL の ?ok= / ?error= を表示する） */
export function Notice({ ok, error }: { ok?: string; error?: string }) {
  if (error)
    return (
      <div role="alert" className="mb-6 whitespace-pre-line rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {error}
      </div>
    );
  if (ok) return <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{ok}</div>;
  return null;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100";

export function Button({ children, variant = "primary", name, value }: { children: ReactNode; variant?: "primary" | "secondary" | "danger"; name?: string; value?: string }) {
  const cls =
    variant === "danger"
      ? "bg-red-600 text-white hover:bg-red-700"
      : variant === "secondary"
        ? "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
        : "bg-blue-700 text-white hover:bg-blue-800";
  return (
    <button type="submit" name={name} value={value} className={`rounded-lg px-4 py-2 text-sm font-semibold ${cls}`}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
      {children}
    </Link>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const cls = { slate: "bg-slate-100 text-slate-700", green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-800", blue: "bg-blue-100 text-blue-800" }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

/** 検索パラメータ（Next 16 は Promise）から ok / error を取り出す。 */
export async function notices(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<{ ok?: string; error?: string }> {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { ok: one(sp.ok), error: one(sp.error) };
}
