/** 管理画面で扱う adops の設定（adops/config/*.json）の型。adops/src/types.ts の必要な部分だけ。 */
export const ANGLES = ["pay", "housing", "beginner", "stability", "quick_cash", "lifestyle", "team", "skill", "pride", "speed"] as const;
export type Angle = (typeof ANGLES)[number];
export const ANGLE_LABELS: Record<Angle, string> = {
  pay: "給与・収入",
  housing: "寮・住まい",
  beginner: "未経験歓迎",
  stability: "安定・正社員",
  quick_cash: "短期で稼ぐ",
  lifestyle: "休日・働き方",
  team: "職場の雰囲気",
  skill: "資格・手に職",
  pride: "仕事の誇り",
  speed: "スピード選考",
};
export const SALARY_TYPES = ["月給", "日給", "時給", "年収"] as const;

export interface Job {
  id: string;
  active: boolean;
  title: string;
  category: string;
  location: string;
  employmentType: string;
  salary: { type: (typeof SALARY_TYPES)[number]; min: number; max?: number; note?: string };
  perks: string[];
  hours?: string;
  holidays?: string;
  requirements?: string;
  personas: string[];
  landingUrl: string;
  applyUrl?: string;
  dailyCreativeQuota?: number;
  targetCpa?: number;
  monthlyApplicationTarget?: number;
  placements: Record<string, unknown>;
  placementsByPersona?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Persona {
  id: string;
  name: string;
  summary: string;
  motivations: string[];
  pains: string[];
  media: string[];
  vocabulary?: { use?: string[]; avoid?: string[] };
  language?: string;
  [k: string]: unknown;
}

export interface Hypothesis {
  id: string;
  personaId: string;
  jobIds?: string[];
  angle: Angle;
  title: string;
  message: string;
  avoid?: string[];
  active?: boolean;
}

export interface RubricItem {
  id: string;
  label: string;
  description: string;
  levels?: Record<string, string>;
  weight?: number;
  appliesWhen?: "hypothesis";
}
export interface Rubric {
  version: string;
  items: RubricItem[];
}

export interface Brand {
  name: string;
  tone: string;
  mandatoryText?: string;
  bannedPhrases: string[];
  [k: string]: unknown;
}

export interface Policy {
  autonomy: "draft" | "auto";
  briefsPerCycle: number;
  exploreShare: number;
  review: { passScore: number; maxRevisions: number };
  guardrails: { targetCpa: number; maxDailyBudget: number; [k: string]: unknown };
  lp?: { enabled: boolean; perCycle?: number };
  [k: string]: unknown;
}

/** 状態ファイル（adops-state ブランチの state.json）のうち、管理画面で表示する部分。 */
export interface StateView {
  halted?: { at: string; reason: string };
  creatives?: Record<string, { status: string; jobId: string; metrics?: { date: string; impressions: number; clicks: number; spend: number; conversions: number }[] }>;
  cycles?: { startedAt: string; steps: { name: string; ok: boolean; note?: string }[]; llmCostUsd?: number }[];
  lps?: Record<
    string,
    { id: string; jobId: string; personaId: string; hypothesisId?: string; status: "draft" | "live" | "retired" | "rejected"; statusReason?: string; createdAt: string; approvedAt?: string; copy: { heroTitle: string; heroSub: string } }
  >;
}
