"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { quickUpdateCandidate } from "@/app/admin/actions";
import type { CandidateRow } from "@/lib/swipeAdmin";
import { EXCLUDED, selectableStatuses, STATUSES, statusInfo } from "@/lib/crmConstants";
import { Avatar } from "@/components/admin/bits";

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
  const router = useRouter();
  const [, startTransition] = useTransition();
  // 保存中・保存直後の値（画面の再読み込みが終わるまで表示に使う）
  const [edits, setEdits] = useState<Record<string, { status?: string; assigneeId?: string | null }>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // サーバーから最新の一覧が届いたら、手元の仮表示は捨てる
  useEffect(() => setEdits({}), [rows]);

  const withEdits = useMemo(
    () => rows.map((r) => ({ ...r, ...(edits[r.id] ?? {}) }) as Row),
    [rows, edits],
  );

  function save(userId: string, patch: { status?: string; assignee?: string }) {
    setEdits((e) => ({
      ...e,
      [userId]: {
        ...e[userId],
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.assignee !== undefined ? { assigneeId: patch.assignee || null } : {}),
      },
    }));
    setErrorMsg(null);
    startTransition(async () => {
      const res = await quickUpdateCandidate(userId, patch);
      if (!res.ok) {
        setErrorMsg(res.error ?? "保存に失敗しました");
        setEdits((e) => {
          const next = { ...e };
          delete next[userId];
          return next;
        });
      }
      router.refresh();
    });
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = withEdits.filter((r) => {
      // 「すべて」ではテスト・除外の人を出さない（ステータスで選べば見られる）
      if (status === "all" ? r.status === EXCLUDED : r.status !== status) return false;
      if (assignee === "me" && r.assigneeId !== meId) return false;
      if (assignee === "none" && r.assigneeId) return false;
      if (!["all", "me", "none"].includes(assignee) && r.assigneeId !== assignee) return false;
      if (!needle) return true;
      return [r.name, r.email, r.phone, r.id, r.utmSource, r.lp].some((v) => v?.toLowerCase().includes(needle));
    });
    const val = (r: Row) =>
      sort === "likes" ? r.likes : ms(sort === "createdAt" ? r.createdAt : sort === "lastSwipeAt" ? r.lastSwipeAt : r.lastContactAt);
    return [...list].sort((a, b) => val(b) - val(a));
  }, [withEdits, q, status, assignee, sort, meId]);


  const statusSelect = (r: Row) => (
    <select
      aria-label="ステータス"
      value={r.status}
      onChange={(e) => save(r.id, { status: e.target.value })}
      className={`max-w-full cursor-pointer rounded-full border-0 py-1 pl-2.5 pr-7 text-xs font-semibold ${statusInfo(r.status).tone}`}
    >
      {selectableStatuses(r.status).map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
  const assigneeSelect = (r: Row) => (
    <div className="flex items-center gap-1.5">
      {r.assigneeId && staffById.get(r.assigneeId) ? (
        <Avatar name={staffById.get(r.assigneeId)!.name} color={staffById.get(r.assigneeId)!.color} size={22} />
      ) : (
        <span className="inline-block h-[22px] w-[22px] rounded-full border border-dashed border-slate-300" />
      )}
      <select
        aria-label="担当"
        value={r.assigneeId ?? ""}
        onChange={(e) => save(r.id, { assignee: e.target.value })}
        className={`cursor-pointer rounded-md border border-transparent bg-transparent py-1 pr-6 text-sm hover:border-slate-300 ${r.assigneeId ? "text-slate-700" : "text-slate-400"}`}
      >
        <option value="">未割当</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.id === meId ? "（自分）" : ""}</option>
        ))}
      </select>
    </div>
  );

  const countBy = (key: string) => withEdits.filter((r) => r.status === key).length;
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm";

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="名前・メール・電話で検索"
          className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 sm:w-auto sm:flex-1"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
          <option value="all">ステータス：すべて（除外以外）</option>
          {STATUSES.filter((s) => !("legacy" in s) || countBy(s.key) > 0).map((s) => (
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
      {errorMsg && <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{errorMsg}</div>}

      {/* スマホ：カード表示 */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {filtered.map((r) => (
          <li key={r.id} className="space-y-2 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/admin/users/${encodeURIComponent(r.id)}`} className="text-base font-semibold text-indigo-700">
                  {r.name || "（名前未登録）"}
                </Link>
                <div className="text-sm">
                  {r.phone ? (
                    <a href={`tel:${r.phone}`} className="tabular-nums text-slate-600">📞 {r.phone}</a>
                  ) : (
                    <span className="text-slate-400">電話番号なし</span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-slate-400">登録 {jst(r.createdAt)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {statusSelect(r)}
              {assigneeSelect(r)}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span className={r.calls ? "" : "text-rose-500"}>架電 {r.calls}</span>
              <span>最終連絡 {jst(r.lastContactAt)}</span>
              <span className="text-emerald-600">Like {r.likes}</span>
              <span>Pass {r.passes}</span>
              {r.applications ? <span className="text-indigo-600">応募 {r.applications}</span> : null}
            </div>
          </li>
        ))}
        {filtered.length === 0 && <li className="px-4 py-10 text-center text-slate-400">該当する候補者がいません</li>}
      </ul>

      {/* PC：表 */}
      <div className="hidden overflow-x-auto md:block">
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
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/users/${encodeURIComponent(r.id)}`} className="font-medium text-indigo-700 hover:underline">
                      {r.name || "（名前未登録）"}
                    </Link>
                    <div className="text-xs">
                      {r.phone ? (
                        <a href={`tel:${r.phone}`} className="tabular-nums text-slate-600 hover:underline">{r.phone}</a>
                      ) : (
                        <span className="text-slate-400">電話番号なし</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {statusSelect(r)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {assigneeSelect(r)}
                  </td>
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
