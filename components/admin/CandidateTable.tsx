"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CandidateRow } from "@/lib/swipeAdmin";
import { STATUSES, statusInfo } from "@/lib/crmConstants";
import { StaffChip, StatusBadge } from "@/components/admin/bits";

type Row = CandidateRow & {
  status: string;
  assigneeId: string | null;
  calls: number;
  lastContactAt: string | null;
};
type StaffLite = { id: string; name: string; color: string };
type SortKey = "createdAt" | "lastSwipeAt" | "lastContactAt" | "likes";

function jst(ts: string | null) {
  if (!ts) return "—";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

const ms = (ts: string | null) => {
  if (!ts) return 0;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  return new Date(iso).getTime() || 0;
};

export default function CandidateTable({ rows, staff, meId }: { rows: Row[]; staff: StaffLite[]; meId: string }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (assignee === "me" && r.assigneeId !== meId) return false;
      if (assignee === "none" && r.assigneeId) return false;
      if (!["all", "me", "none"].includes(assignee) && r.assigneeId !== assignee) return false;
      if (!needle) return true;
      return [r.name, r.email, r.phone, r.id, r.utmSource, r.lp].some((v) => v?.toLowerCase().includes(needle));
    });
    const val = (r: Row) =>
      sort === "likes" ? r.likes : ms(sort === "createdAt" ? r.createdAt : sort === "lastSwipeAt" ? r.lastSwipeAt : r.lastContactAt);
    return [...list].sort((a, b) => val(b) - val(a));
  }, [rows, q, status, assignee, sort, meId]);

  const countBy = (key: string) => rows.filter((r) => r.status === key).length;
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm";

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="名前・メール・電話で検索"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
          <option value="all">ステータス：すべて</option>
          {STATUSES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}（{countBy(s.key)}）</option>
          ))}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={sel}>
          <option value="all">担当：全員</option>
          <option value="me">自分の担当</option>
          <option value="none">未割当</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={sel}>
          <option value="createdAt">登録が新しい順</option>
          <option value="lastContactAt">最終連絡が新しい順</option>
          <option value="lastSwipeAt">最終スワイプが新しい順</option>
          <option value="likes">Like が多い順</option>
        </select>
        <span className="text-sm text-slate-500">{filtered.length} 人</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">候補者</th>
              <th className="px-4 py-2 font-medium">ステータス</th>
              <th className="px-4 py-2 font-medium">担当</th>
              <th className="px-4 py-2 text-right font-medium">架電</th>
              <th className="px-4 py-2 font-medium">最終連絡</th>
              <th className="px-4 py-2 text-right font-medium">Like</th>
              <th className="px-4 py-2 text-right font-medium">Pass</th>
              <th className="px-4 py-2 text-right font-medium">応募</th>
              <th className="px-4 py-2 font-medium">登録日</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => {
              const st = statusInfo(r.status);
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/users/${encodeURIComponent(r.id)}`} className="font-medium text-indigo-700 hover:underline">
                      {r.name || "（名前未登録）"}
                    </Link>
                    <div className="max-w-[220px] truncate text-xs text-slate-400">{r.phone ?? r.email ?? ""}</div>
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge label={st.label} tone={st.tone} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap"><StaffChip staff={r.assigneeId ? staffById.get(r.assigneeId) : null} /></td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${r.calls ? "text-slate-700" : "text-rose-500"}`}>{r.calls}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{jst(r.lastContactAt)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-emerald-600">{r.likes}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{r.passes}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-indigo-600">{r.applications || ""}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{jst(r.createdAt)}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-400">該当する候補者がいません</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
