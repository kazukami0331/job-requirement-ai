import { ConfigError } from "@/lib/swipeAdmin";

export function ActionBadge({ action }: { action: string }) {
  if (action === "like")
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        ♥ Like
      </span>
    );
  if (action === "pass")
    return (
      <span className="inline-flex items-center rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
        ✕ Pass
      </span>
    );
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
      {action}
    </span>
  );
}

export function AppliedBadge({ status }: { status: string | null }) {
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
      応募{status ? `：${status}` : ""}
    </span>
  );
}

export function Chips({ items }: { items: unknown[] | null | undefined }) {
  const list = (items ?? []).filter((v) => v !== null && v !== "").map(String);
  if (list.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((t, i) => (
        <span key={i} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
          {t}
        </span>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const isConfig = error instanceof ConfigError;
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-semibold">{isConfig ? "設定が必要です" : "データを取得できませんでした"}</p>
      <p className="mt-1 whitespace-pre-wrap break-all">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  );
}
