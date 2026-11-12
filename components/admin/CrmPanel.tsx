import { addActivity, deleteActivity, updateCandidate } from "@/app/admin/actions";
import type { Staff } from "@/lib/auth";
import type { Activity, CrmCandidate, StatusChange } from "@/lib/crm";
import { CALL_RESULTS, callResultLabel, STATUSES, statusInfo } from "@/lib/crmConstants";
import { formatJst } from "@/lib/swipeAdmin";
import { randomUUID } from "node:crypto";
import SubmitButton from "@/components/admin/SubmitButton";
import { Avatar, btnCls, btnSubCls, inputCls, Notice, StaffChip, StatusBadge } from "@/components/admin/bits";

/** 今の日本時間を datetime-local の形で */
function nowJstLocal() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16);
}

type TimelineItem =
  | { kind: "activity"; at: string; a: Activity }
  | { kind: "status"; at: string; h: StatusChange };

export default function CrmPanel({
  userId,
  candidate,
  activities,
  history,
  staff,
  me,
  saved,
  error,
}: {
  userId: string;
  candidate: CrmCandidate | null;
  activities: Activity[];
  history: StatusChange[];
  staff: Staff[];
  me: Staff;
  saved?: string;
  error?: string;
}) {
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const status = candidate?.status ?? "new";
  const st = statusInfo(status);
  const calls = activities.filter((a) => a.type === "call");
  const connected = calls.filter((a) => a.result === "connected").length;

  const timeline: TimelineItem[] = [
    ...activities.map((a) => ({ kind: "activity" as const, at: a.occurred_at, a })),
    ...history.map((h) => ({ kind: "status" as const, at: h.changed_at, h })),
  ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <h2 className="font-semibold">対応状況</h2>
        <StatusBadge label={st.label} tone={st.tone} />
        <StaffChip staff={candidate?.assignee_id ? staffById.get(candidate.assignee_id) : null} />
        <span className="ml-auto text-sm text-slate-500">
          架電 {calls.length} 回 ・ つながった {connected} 回
        </span>
      </div>

      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div className="space-y-6">

          {/* ステータス・担当 */}
          <form action={updateCandidate} className="space-y-3">
            <input type="hidden" name="userId" value={userId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-600">ステータス</span>
                <select name="status" defaultValue={status} className={inputCls}>
                  {STATUSES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-600">担当</span>
                <select name="assignee" defaultValue={candidate?.assignee_id ?? ""} className={inputCls}>
                  <option value="">未割当</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.id === me.id ? "（自分）" : ""}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton className={btnSubCls}>ステータス・担当を保存</SubmitButton>
              {saved === "status" && <span className="text-sm font-semibold text-emerald-700">✓ 保存しました</span>}
            </div>
          </form>

          {/* 架電・メモ */}
          <form action={addActivity} className="space-y-3 rounded-lg bg-slate-50 p-4">
            <input type="hidden" name="userId" value={userId} />
            {/* 同じ送信が 2 回届いても 1 件だけ記録されるよう、表示ごとに ID を振る */}
            <input type="hidden" name="activityId" value={randomUUID()} />
            <div className="text-sm font-semibold">📞 架電・メモを記録</div>
            {(saved === "call" || saved === "memo") && (
              <Notice kind="ok">✓ {saved === "call" ? "架電" : "メモ"}を記録しました（右の履歴に追加されています）</Notice>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-600">日時</span>
              <input type="datetime-local" name="occurredAt" defaultValue={nowJstLocal()} className={inputCls} />
            </label>
            <div>
              <span className="mb-1 block text-xs font-semibold text-slate-600">架電の結果</span>
              <div className="flex flex-wrap gap-2">
                {CALL_RESULTS.map((r) => (
                  <label key={r.key} className="cursor-pointer">
                    <input type="radio" name="result" value={r.key} className="peer sr-only" />
                    <span className="block rounded-full border border-slate-300 bg-white px-3 py-1 text-sm peer-checked:border-slate-900 peer-checked:bg-slate-900 peer-checked:text-white">
                      {r.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-600">メモ</span>
              <textarea name="note" rows={3} className={inputCls} placeholder="話した内容、次のアクションなど" />
            </label>
            <div className="flex flex-wrap gap-2">
              <SubmitButton name="type" value="call" className={btnCls} pendingText="記録中…">架電を記録</SubmitButton>
              <SubmitButton name="type" value="memo" className={btnSubCls} pendingText="記録中…">メモだけ残す</SubmitButton>
            </div>
            <p className="text-xs text-slate-400">担当が未割当のときは、記録した人が担当になります。</p>
          </form>
        </div>

        {/* 履歴 */}
        <div>
          <div className="mb-2 text-sm font-semibold">履歴</div>
          {timeline.length === 0 ? (
            <p className="text-sm text-slate-400">まだ記録がありません</p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((t) => {
                const who = staffById.get((t.kind === "activity" ? t.a.staff_id : t.h.staff_id) ?? "");
                return (
                  <li key={t.kind + (t.kind === "activity" ? t.a.id : t.h.id)} className="flex gap-3">
                    <Avatar name={who?.name ?? "?"} color={who?.color} size={28} />
                    <div className="min-w-0 flex-1 rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-semibold text-slate-700">{who?.name ?? "（削除されたメンバー）"}</span>
                        <span>{formatJst(t.at)}</span>
                        {t.kind === "activity" && t.a.type === "call" && (
                          <span
                            className={`rounded-full px-2 py-0.5 font-semibold ${
                              t.a.result === "connected" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            📞 {callResultLabel(t.a.result)}
                          </span>
                        )}
                        {t.kind === "activity" && t.a.type === "memo" && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">メモ</span>
                        )}
                        {t.kind === "activity" && (me.role === "owner" || t.a.staff_id === me.id) && (
                          <form action={deleteActivity} className="ml-auto">
                            <input type="hidden" name="id" value={t.a.id} />
                            <input type="hidden" name="userId" value={userId} />
                            <button className="text-slate-400 hover:text-rose-600">削除</button>
                          </form>
                        )}
                      </div>
                      {t.kind === "activity" && t.a.note && (
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">{t.a.note}</p>
                      )}
                      {t.kind === "status" && (
                        <p className="mt-1.5 text-sm text-slate-700">
                          ステータスを「{statusInfo(t.h.from_status).label}」→「{statusInfo(t.h.to_status).label}」に変更
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
