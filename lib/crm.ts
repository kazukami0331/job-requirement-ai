import "server-only";
import {
  enc,
  scopeStartUtc,
  selectAll,
  type AdminUser,
} from "@/lib/swipeAdmin";
import { FUNNEL, statusRank } from "@/lib/crmConstants";
import type { Staff } from "@/lib/auth";

export type CrmCandidate = {
  user_id: string;
  status: string;
  assignee_id: string | null;
  updated_at: string;
};

export type Activity = {
  id: string;
  user_id: string;
  staff_id: string | null;
  type: "call" | "memo";
  result: string | null;
  note: string | null;
  occurred_at: string;
  created_at: string;
};

export type StatusChange = {
  id: string;
  user_id: string;
  from_status: string | null;
  to_status: string;
  staff_id: string | null;
  changed_at: string;
};

/** crm_ テーブルがまだ作られていない（SQL 未実行） */
export class CrmNotReadyError extends Error {
  constructor() {
    super(
      "顧客管理用のテーブルがまだありません。リポジトリの supabase/crm.sql を Supabase の SQL Editor で実行してください。",
    );
  }
}

export function isMissingTable(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return /crm_/.test(m) && /(404|PGRST205|42P01|does not exist|Could not find the table)/.test(m);
}

/** crm_ テーブルの読み取り。テーブルがなければ CrmNotReadyError */
export async function crmSelect<T>(table: string, query: string): Promise<T[]> {
  try {
    return await selectAll<T>(table, query);
  } catch (e) {
    if (isMissingTable(e)) throw new CrmNotReadyError();
    throw e;
  }
}

export function toMs(ts: string | null | undefined) {
  if (!ts) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  return new Date(iso).getTime();
}

export type CandidateCrmSummary = {
  status: string;
  assigneeId: string | null;
  calls: number;
  lastContactAt: string | null;
};

/** 一覧用：候補者ごとのステータス・担当・架電回数・最終連絡 */
export async function crmSummaries(): Promise<Map<string, CandidateCrmSummary>> {
  const [cands, acts] = await Promise.all([
    crmSelect<CrmCandidate>("crm_candidates", "select=user_id,status,assignee_id,updated_at"),
    crmSelect<Pick<Activity, "user_id" | "type" | "occurred_at">>(
      "crm_activities",
      "select=user_id,type,occurred_at",
    ),
  ]);
  const map = new Map<string, CandidateCrmSummary>();
  const get = (id: string) => {
    let v = map.get(id);
    if (!v) {
      v = { status: "new", assigneeId: null, calls: 0, lastContactAt: null };
      map.set(id, v);
    }
    return v;
  };
  for (const c of cands) {
    const v = get(c.user_id);
    v.status = c.status;
    v.assigneeId = c.assignee_id;
  }
  for (const a of acts) {
    const v = get(a.user_id);
    if (a.type === "call") v.calls++;
    if (!v.lastContactAt || toMs(a.occurred_at) > toMs(v.lastContactAt)) v.lastContactAt = a.occurred_at;
  }
  return map;
}

export async function crmForUser(userId: string) {
  const [cands, activities, history] = await Promise.all([
    crmSelect<CrmCandidate>(
      "crm_candidates",
      `select=user_id,status,assignee_id,updated_at&user_id=eq.${enc(userId)}`,
    ),
    crmSelect<Activity>("crm_activities", `select=*&user_id=eq.${enc(userId)}&order=occurred_at.desc`),
    crmSelect<StatusChange>(
      "crm_status_history",
      `select=*&user_id=eq.${enc(userId)}&order=changed_at.desc`,
    ),
  ]);
  return { candidate: cands[0] ?? null, activities, history };
}

// ───────────────────────── 分析 ─────────────────────────

function median(xs: number[]) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const HOUR = 60 * 60 * 1000;

function jstHour(ms: number) {
  return new Date(ms + 9 * HOUR).getUTCHours();
}

export const HOUR_BANDS = [
  { label: "〜9時", from: 0, to: 9 },
  { label: "9〜12時", from: 9, to: 12 },
  { label: "12〜14時", from: 12, to: 14 },
  { label: "14〜17時", from: 14, to: 17 },
  { label: "17〜19時", from: 17, to: 19 },
  { label: "19〜21時", from: 19, to: 21 },
  { label: "21時〜", from: 21, to: 24 },
];

export type StaffStats = {
  staffId: string | null;
  candidates: number;
  calls: number;
  connected: number;
  firstCallLeadHoursMedian: number | null;
  applied: number;
  offered: number;
  accepted: number;
};

export async function computeAnalytics(staff: Staff[]) {
  const [users, cands, acts, history, apps] = await Promise.all([
    selectAll<Pick<AdminUser, "id" | "createdAt">>(
      "users",
      `select=id,createdAt&createdAt=gte.${enc(scopeStartUtc())}`,
    ),
    crmSelect<CrmCandidate>("crm_candidates", "select=user_id,status,assignee_id,updated_at"),
    crmSelect<Activity>("crm_activities", "select=user_id,staff_id,type,result,occurred_at"),
    crmSelect<StatusChange>("crm_status_history", "select=user_id,to_status,changed_at"),
    selectAll<{ userId: string }>("job_applications", "select=userId").catch(() => []),
  ]);

  const regAt = new Map(users.map((u) => [u.id, toMs(u.createdAt)]));
  const inScope = (id: string) => regAt.has(id);
  const candBy = new Map(cands.map((c) => [c.user_id, c]));

  // 候補者ごとの架電の流れ
  const callsBy = new Map<string, Activity[]>();
  for (const a of acts) {
    if (a.type !== "call" || !inScope(a.user_id)) continue;
    const list = callsBy.get(a.user_id) ?? [];
    list.push(a);
    callsBy.set(a.user_id, list);
  }
  for (const list of callsBy.values()) list.sort((a, b) => toMs(a.occurred_at) - toMs(b.occurred_at));

  // 各ステータスに最初に到達した時刻
  const reachedAt = new Map<string, Map<number, number>>(); // userId -> rank -> ms
  for (const h of history) {
    if (!inScope(h.user_id)) continue;
    const r = statusRank(h.to_status);
    if (r < 0) continue;
    const m = reachedAt.get(h.user_id) ?? new Map<number, number>();
    const t = toMs(h.changed_at);
    for (let k = 0; k <= r; k++) if (!m.has(k) || t < m.get(k)!) m.set(k, t);
    reachedAt.set(h.user_id, m);
  }
  const maxRank = (id: string) => {
    const current = statusRank(candBy.get(id)?.status ?? "new");
    const hist = Math.max(-1, ...(reachedAt.get(id)?.keys() ?? []));
    return Math.max(current, hist, 0);
  };

  // 全体 KPI
  const ids = [...regAt.keys()];
  const firstCallLead: number[] = [];
  const callsUntilConnect: number[] = [];
  let calledPeople = 0;
  let connectedPeople = 0;
  let totalCalls = 0;
  let totalConnected = 0;
  for (const id of ids) {
    const list = callsBy.get(id) ?? [];
    totalCalls += list.length;
    totalConnected += list.filter((a) => a.result === "connected").length;
    if (list.length) {
      calledPeople++;
      const lead = (toMs(list[0].occurred_at) - regAt.get(id)!) / HOUR;
      if (lead >= 0) firstCallLead.push(lead);
      const idx = list.findIndex((a) => a.result === "connected");
      if (idx >= 0) {
        connectedPeople++;
        callsUntilConnect.push(idx + 1);
      }
    }
  }

  const swipeApplied = new Set(apps.map((a) => a.userId).filter(inScope));

  // ファネル（各段階に到達した人数と、登録からの日数の中央値）
  const funnel = FUNNEL.map((s, rank) => {
    const reached = ids.filter((id) => maxRank(id) >= rank);
    const days: number[] = [];
    for (const id of reached) {
      const t = reachedAt.get(id)?.get(rank);
      if (t !== undefined && rank > 0) days.push((t - regAt.get(id)!) / (24 * HOUR));
    }
    return { key: s.key, label: s.label, count: reached.length, leadDaysMedian: median(days) };
  });
  const closed = ids.filter((id) => candBy.get(id)?.status === "closed").length;

  // 時間帯別の接続率
  const bands = HOUR_BANDS.map((b) => ({ ...b, calls: 0, connected: 0 }));
  for (const list of callsBy.values()) {
    for (const a of list) {
      const h = jstHour(toMs(a.occurred_at));
      const band = bands.find((b) => h >= b.from && h < b.to);
      if (!band) continue;
      band.calls++;
      if (a.result === "connected") band.connected++;
    }
  }

  // 担当者別
  const appliedRank = statusRank("applied");
  const offeredRank = statusRank("offered");
  const acceptedRank = statusRank("accepted");
  const staffIds: (string | null)[] = [...staff.map((s) => s.id), null];
  const perStaff: StaffStats[] = staffIds.map((sid) => {
    const mine = ids.filter((id) => (candBy.get(id)?.assignee_id ?? null) === sid);
    const myCalls = [...callsBy.values()].flat().filter((a) => (a.staff_id ?? null) === sid);
    const leads: number[] = [];
    for (const id of mine) {
      const first = callsBy.get(id)?.[0];
      if (first) {
        const lead = (toMs(first.occurred_at) - regAt.get(id)!) / HOUR;
        if (lead >= 0) leads.push(lead);
      }
    }
    return {
      staffId: sid,
      candidates: mine.length,
      calls: myCalls.length,
      connected: myCalls.filter((a) => a.result === "connected").length,
      firstCallLeadHoursMedian: median(leads),
      applied: mine.filter((id) => maxRank(id) >= appliedRank).length,
      offered: mine.filter((id) => maxRank(id) >= offeredRank).length,
      accepted: mine.filter((id) => maxRank(id) >= acceptedRank).length,
    };
  });

  return {
    registered: ids.length,
    calledPeople,
    connectedPeople,
    totalCalls,
    totalConnected,
    firstCallLeadHoursMedian: median(firstCallLead),
    callsUntilConnectAvg: callsUntilConnect.length
      ? callsUntilConnect.reduce((a, b) => a + b, 0) / callsUntilConnect.length
      : null,
    swipeApplied: swipeApplied.size,
    funnel,
    closed,
    bands,
    perStaff: perStaff.filter((p) => p.staffId !== null || p.candidates > 0 || p.calls > 0),
  };
}
