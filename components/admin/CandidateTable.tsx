"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CandidateRow } from "@/lib/swipeAdmin";

type SortKey = "createdAt" | "lastSwipeAt" | "likes" | "swipes";

function jst(ts: string | null) {
  if (!ts) return "—";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

export default function CandidateTable({ rows }: { rows: CandidateRow[] }) {
  const [q, setQ] = useState("");
  const [onlySwiped, setOnlySwiped] = useState(true);
  const [sort, setSort] = useState<SortKey>("lastSwipeAt");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (onlySwiped && r.likes + r.passes === 0) return false;
      if (!needle) return true;
      return [r.name, r.email, r.phone, r.id, r.utmSource, r.lp]
        .some((v) => v?.toLowerCase().includes(needle));
    });
    const val = (r: CandidateRow): string | number => {
      switch (sort) {
        case "likes": return r.likes;
        case "swipes": return r.likes + r.passes;
        case "lastSwipeAt": return r.lastSwipeAt ?? "";
        default: return r.createdAt ?? "";
      }
    };
    return [...list].sort((a, b) => (val(a) < val(b) ? 1 : val(a) > val(b) ? -1 : 0));
  }, [rows, q, onlySwiped, sort]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="名前・メール・電話・流入元で検索"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={onlySwiped} onChange={(e) => setOnlySwiped(e.target.checked)} />
          スワイプした人だけ
        </label>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="lastSwipeAt">最終スワイプが新しい順</option>
          <option value="createdAt">登録が新しい順</option>
          <option value="likes">Like が多い順</option>
          <option value="swipes">スワイプ数が多い順</option>
        </select>
        <span className="text-sm text-slate-500">{filtered.length} 人</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">候補者</th>
              <th className="px-4 py-2 font-medium">連絡先</th>
              <th className="px-4 py-2 text-right font-medium">Like</th>
              <th className="px-4 py-2 text-right font-medium">Pass</th>
              <th className="px-4 py-2 text-right font-medium">応募</th>
              <th className="px-4 py-2 font-medium">最終スワイプ</th>
              <th className="px-4 py-2 font-medium">登録日</th>
              <th className="px-4 py-2 font-medium">流入元</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <Link href={`/admin/users/${encodeURIComponent(r.id)}`} className="font-medium text-indigo-700 hover:underline">
                    {r.name || "（名前未登録）"}
                  </Link>
                  {r.interviewCompleted && (
                    <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">面談済</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  <div className="max-w-[220px] truncate">{r.email ?? "—"}</div>
                  {r.phone && <div className="text-xs text-slate-400">{r.phone}</div>}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-emerald-600">{r.likes}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{r.passes}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-indigo-600">{r.applications || ""}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{jst(r.lastSwipeAt)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{jst(r.createdAt)}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{[r.utmSource, r.lp].filter(Boolean).join(" / ") || "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">該当する候補者がいません</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
