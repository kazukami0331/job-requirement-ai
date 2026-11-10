// 顧客管理で使う選択肢（サーバー・ブラウザ両方から使う）

export const STATUSES = [
  { key: "new", label: "登録・連絡中", tone: "bg-slate-100 text-slate-700" },
  { key: "proposing", label: "連絡済・求人提案中", tone: "bg-sky-100 text-sky-700" },
  { key: "reviewing", label: "求人確認中", tone: "bg-cyan-100 text-cyan-700" },
  { key: "applied", label: "応募・書類選考中", tone: "bg-indigo-100 text-indigo-700" },
  { key: "before_interview", label: "面接前", tone: "bg-violet-100 text-violet-700" },
  { key: "awaiting_result", label: "面接結果待ち", tone: "bg-fuchsia-100 text-fuchsia-700" },
  { key: "offered", label: "内定", tone: "bg-amber-100 text-amber-800" },
  { key: "accepted", label: "内定承諾", tone: "bg-emerald-100 text-emerald-700" },
  { key: "unreachable", label: "みなし辞退（連絡不通）", tone: "bg-orange-100 text-orange-700" },
  { key: "invalid", label: "無効応募", tone: "bg-stone-200 text-stone-700" },
  { key: "closed", label: "見送り・辞退", tone: "bg-rose-100 text-rose-700" },
  { key: "excluded", label: "テスト・除外", tone: "bg-zinc-200 text-zinc-500" },
] as const;

export type StatusKey = (typeof STATUSES)[number]["key"];

/** 途中で終わったステータス（分析では件数を別に数える） */
export const ENDED = ["unreachable", "invalid", "closed"];

/** テストアカウントなど、一覧・集計・分析から外す */
export const EXCLUDED = "excluded";

/** 進捗の順番（見送り・辞退、テスト・除外は -1） */
export function statusRank(key: string | null | undefined) {
  if (ENDED.includes(key ?? "") || key === EXCLUDED) return -1;
  const i = STATUSES.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

export function statusInfo(key: string | null | undefined) {
  return STATUSES.find((s) => s.key === key) ?? STATUSES[0];
}

/** ファネル（見送り・辞退を除いた順番どおりのステータス） */
export const FUNNEL = STATUSES.filter((s) => statusRank(s.key) >= 0);

export const CALL_RESULTS = [
  { key: "connected", label: "つながった" },
  { key: "no_answer", label: "不在" },
  { key: "voicemail", label: "留守電" },
  { key: "callback", label: "折り返し待ち" },
  { key: "invalid", label: "番号不通・誤り" },
] as const;

export function callResultLabel(key: string | null | undefined) {
  return CALL_RESULTS.find((r) => r.key === key)?.label ?? key ?? "";
}

export const STAFF_COLORS = [
  "#4f46e5", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#475569",
];

/** 求人ごとの選考ステージ（提案求人・スワイプ求人・SwipeJob 応募） */
export const JOB_STAGES = [
  { key: "proposed", label: "提案済み", tone: "bg-slate-100 text-slate-700" },
  { key: "interested", label: "応募希望", tone: "bg-sky-100 text-sky-700" },
  { key: "applied", label: "応募済・書類選考中", tone: "bg-indigo-100 text-indigo-700" },
  { key: "interview", label: "面接中", tone: "bg-violet-100 text-violet-700" },
  { key: "offered", label: "内定", tone: "bg-amber-100 text-amber-800" },
  { key: "accepted", label: "内定承諾", tone: "bg-emerald-100 text-emerald-700" },
  { key: "rejected", label: "不合格・お見送り", tone: "bg-rose-100 text-rose-700" },
  { key: "declined", label: "辞退・見送り（候補者）", tone: "bg-zinc-200 text-zinc-600" },
] as const;

export function jobStageInfo(key: string | null | undefined) {
  return JOB_STAGES.find((s) => s.key === key) ?? JOB_STAGES[0];
}

export const JOB_SOURCES: Record<string, string> = {
  proposal: "提案",
  swipe: "スワイプ",
  swipe_apply: "SwipeJob 応募",
};
