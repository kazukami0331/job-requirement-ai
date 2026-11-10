// サーバー・ブラウザどちらからでも使える小さな部品

export function Avatar({
  name,
  color,
  size = 24,
}: {
  name: string | null | undefined;
  color: string | null | undefined;
  size?: number;
}) {
  const label = (name ?? "?").trim();
  const initial = label ? Array.from(label)[0] : "?";
  return (
    <span
      title={label}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: color ?? "#94a3b8", fontSize: Math.round(size * 0.48) }}
    >
      {initial}
    </span>
  );
}

/** アイコン＋名前 */
export function StaffChip({ staff }: { staff: { name: string; color: string } | null | undefined }) {
  if (!staff) return <span className="text-xs text-slate-400">未割当</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
      <Avatar name={staff.name} color={staff.color} size={22} />
      {staff.name}
    </span>
  );
}

export function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"
      }`}
    >
      {children}
    </div>
  );
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500";
export const btnCls =
  "inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700";
export const btnSubCls =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
