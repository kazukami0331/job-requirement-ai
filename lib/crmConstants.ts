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
  { key: "closed", label: "見送り・辞退", tone: "bg-rose-100 text-rose-700" },
] as const;

export type StatusKey = (typeof STATUSES)[number]["key"];

/** 進捗の順番（見送り・辞退は -1） */
export function statusRank(key: string | null | undefined) {
  if (key === "closed") return -1;
  const i = STATUSES.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

export function statusInfo(key: string | null | undefined) {
  return STATUSES.find((s) => s.key === key) ?? STATUSES[0];
}

/** ファネル（見送り・辞退を除いた順番どおりのステータス） */
export const FUNNEL = STATUSES.filter((s) => s.key !== "closed");

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
