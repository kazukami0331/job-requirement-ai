import { FunnelStage } from "@/types/recruiting";

/** ジョブオプの選考ステータスマスタ */
export const STATUS_MASTER: Record<string, string> = {
  "1": "未対応",
  "2": "面接予約待ち",
  "3": "面接待ち",
  "4": "面接結果待ち",
  "5": "採用",
  "6": "不採用（面接前）",
  "7": "不採用（面接後）",
  "500": "面接希望回答待ち",
  "501": "面接日確定待ち",
};

/** 選考ステータスID → ファネル段階 */
const STATUS_TO_STAGE: Record<string, FunnelStage> = {
  "1": "untouched",
  "2": "scheduling",
  "500": "scheduling",
  "501": "scheduling",
  "3": "interviewScheduled",
  "4": "interviewed",
  "5": "hired",
  "6": "rejectedBefore",
  "7": "rejectedAfter",
};

export function stageOf(statusId: string): FunnelStage {
  return STATUS_TO_STAGE[statusId] ?? "untouched";
}

export interface StageDef {
  key: FunnelStage;
  label: string;
  /** 選考中（プールとして積み上がる）段階か */
  active: boolean;
  /**
   * 段階の色。選考中の4段階は「順序のあるカテゴリ」なので単一色相の
   * オーディナルランプ（青の明→暗）、着地の3段階は結果を表すので
   * ステータス色を当てている。実際の値はglobals.cssでライト/ダーク両方を定義。
   */
  color: string;
}

/** 表示順に並べたファネル段階 */
export const STAGES: StageDef[] = [
  { key: "untouched", label: "未対応", active: true, color: "var(--stage-untouched)" },
  { key: "scheduling", label: "面接調整中", active: true, color: "var(--stage-scheduling)" },
  { key: "interviewScheduled", label: "面接待ち", active: true, color: "var(--stage-interview-scheduled)" },
  { key: "interviewed", label: "面接結果待ち", active: true, color: "var(--stage-interviewed)" },
  { key: "hired", label: "採用", active: false, color: "var(--status-good)" },
  { key: "rejectedBefore", label: "不採用・辞退（面接前）", active: false, color: "var(--status-serious)" },
  { key: "rejectedAfter", label: "不採用・辞退（面接後）", active: false, color: "var(--status-critical)" },
];

export const STAGE_LABEL: Record<FunnelStage, string> = {
  applied: "応募",
  untouched: "未対応",
  scheduling: "面接調整中",
  interviewScheduled: "面接待ち",
  interviewed: "面接結果待ち",
  hired: "採用",
  rejectedBefore: "不採用・辞退（面接前）",
  rejectedAfter: "不採用・辞退（面接後）",
};

/** 「選考中プール」に含まれる段階 */
export const ACTIVE_STAGES: FunnelStage[] = STAGES.filter((s) => s.active).map((s) => s.key);

/**
 * 通過ファネル。ある段階に到達した＝それ以降の段階も通過している、
 * という累積の考え方で到達数を数えるための順序定義。
 */
export const FUNNEL_STEPS: { key: string; label: string; reached: (stage: FunnelStage) => boolean }[] = [
  { key: "applied", label: "応募", reached: () => true },
  {
    key: "scheduled",
    label: "面接設定",
    // 面接日が確定した、もしくはその先に進んだもの（面接前の不採用・辞退は含めない）
    reached: (s) =>
      s === "interviewScheduled" || s === "interviewed" || s === "hired" || s === "rejectedAfter",
  },
  {
    key: "interviewed",
    label: "面接実施",
    reached: (s) => s === "interviewed" || s === "hired" || s === "rejectedAfter",
  },
  { key: "hired", label: "採用", reached: (s) => s === "hired" },
];
