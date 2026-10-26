/**
 * ドメインの型。状態ファイル（data/state.json）にもこの形のまま保存する。
 */

export type Platform = 'meta' | 'google';
export type Format = 'image' | 'video';
export type Ratio = '1:1' | '4:5' | '9:16' | '1.91:1';

/** 訴求軸。分析・改善はこの単位で勝ち負けを学習する。 */
export const ANGLES = [
  'pay', // 給与・高収入・日払い
  'housing', // 寮・社宅・生活費
  'beginner', // 未経験・学歴不問・研修
  'stability', // 正社員・長く働ける・賞与
  'quick_cash', // 短期集中で稼ぐ・入社祝い金
  'lifestyle', // 休日・残業少・家族時間
  'team', // 職場の雰囲気・仲間
  'skill', // 資格取得支援・手に職
  'pride', // 仕事の誇り・社会インフラを支える
  'speed', // 即日面接・最短入社・Web完結
] as const;
export type Angle = (typeof ANGLES)[number];

export const ANGLE_LABELS: Record<Angle, string> = {
  pay: '給与・収入',
  housing: '寮・住まい',
  beginner: '未経験歓迎',
  stability: '安定・正社員',
  quick_cash: '短期で稼ぐ',
  lifestyle: '休日・働き方',
  team: '職場の雰囲気',
  skill: '資格・手に職',
  pride: '仕事の誇り',
  speed: 'スピード選考',
};

export interface Salary {
  type: '月給' | '日給' | '時給' | '年収';
  min: number;
  max?: number;
  /** 例: 「残業代別途」「月収例 32万円（残業20h含む）」 */
  note?: string;
}

/** 集客したい求人（または求人群）。config/jobs.json で管理する。 */
export interface Job {
  id: string;
  active: boolean;
  title: string;
  category: string;
  location: string;
  employmentType: string;
  salary: Salary;
  perks: string[];
  hours?: string;
  holidays?: string;
  requirements?: string;
  /** 対象ペルソナ ID */
  personas: string[];
  landingUrl: string;
  /** 1日に作る新規クリエイティブの上限（求人ごと） */
  dailyCreativeQuota?: number;
  /** 媒体ごとの入稿先。キャンペーン・広告セットは人が作り、AIは広告（素材）を回す。 */
  placements: {
    meta?: { adsetIds: string[] };
    google?: { assetGroupIds?: string[]; adGroupIds?: string[]; searchAdGroupIds?: string[] };
  };
}

export interface Persona {
  id: string;
  name: string;
  summary: string;
  motivations: string[];
  pains: string[];
  /** よく見る媒体・時間帯など */
  media: string[];
  /** 響く言葉・NGな言葉 */
  vocabulary?: { use?: string[]; avoid?: string[] };
}

export interface Brand {
  name: string;
  tone: string;
  colors: { primary: string; accent: string; text: string; background: string };
  /** 画像に必ず入れる表記（例: 許可番号） */
  mandatoryText?: string;
  logoPath?: string;
  /** 社内ルールとして追加で避ける表現 */
  bannedPhrases: string[];
  /** 生成画像のスタイル指定（Midjourney に毎回付ける） */
  visualStyle: string;
}

export interface Policy {
  /** draft: 停止状態で入稿して人が ON にする / auto: 審査を通れば配信開始まで自動 */
  autonomy: 'draft' | 'auto';
  /** 1サイクルで新しく企画する本数（全求人合計） */
  briefsPerCycle: number;
  /** 動画を作る割合（0〜1） */
  videoShare: number;
  /** 新しい訴求軸を試す割合（探索率） */
  exploreShare: number;
  review: { passScore: number; maxRevisions: number };
  /** Instagram のオーガニック投稿（広告素材の転用） */
  organic?: {
    enabled: boolean;
    /** 1日の投稿数の上限 */
    postsPerDay: number;
    /** 毎回付けるハッシュタグ */
    baseHashtags: string[];
    /** 広告で成果が出た素材を優先して投稿する（CTR の下限 %） */
    minAdCtrForRepost: number;
  };
  /** 画像1枚あたりの Midjourney 生成候補の中から選ぶ枚数 */
  imageCandidates: number;
  guardrails: {
    /** 停止判定に使う最低インプレッション数 */
    minImpressions: number;
    /** CTR がこの値（%）を下回り、かつ中央値の何割未満なら停止 */
    ctrFloorPct: number;
    ctrRelativeFloor: number;
    /** 目標応募単価（円）。超えたら停止候補 */
    targetCpa: number;
    /** 応募ゼロのまま目標CPAの何倍使ったら停止するか */
    zeroConversionSpendMultiple: number;
    /** 勝ちクリエイティブを伸ばすときの広告セット日予算の増加率と上限（円） */
    budgetStepPct: number;
    maxDailyBudget: number;
    /** 1広告セットあたりの同時配信数の上限（入れ過ぎると学習が分散する） */
    maxActivePerAdset: number;
    /** 疲弊判定: 配信開始からこの日数を超え、直近CTRが初期の何割まで落ちたら入れ替え */
    fatigueDays: number;
    fatigueCtrRatio: number;
  };
}

export interface CreativeBrief {
  id: string;
  cycleId: string;
  jobId: string;
  personaId: string;
  angle: Angle;
  format: Format;
  /** 探索枠（新しい訴求軸の試行）かどうか */
  explore: boolean;
  hypothesis: string;
  hook: string;
  headline: string;
  primaryText: string;
  description: string;
  cta: 'APPLY_NOW' | 'LEARN_MORE' | 'SIGN_UP' | 'CONTACT_US';
  overlay: { main: string; sub: string; badges: string[] };
  /** 動画の場合のシーン構成（各カットの表示テキスト） */
  storyboard: { seconds: number; text: string; visual: string }[];
  visualConcept: string;
  /** Midjourney 用プロンプト（パラメータは付けない。比率等はシステム側で付与） */
  imagePrompt: string;
  revision: number;
  createdAt: string;
}

export interface ReviewIssue {
  severity: 'blocker' | 'major' | 'minor';
  field: string;
  problem: string;
  suggestion: string;
}

export interface Review {
  briefId: string;
  revision: number;
  reviewer: 'rules' | 'ai';
  score: number;
  scores: Record<string, number>;
  verdict: 'pass' | 'revise' | 'reject';
  issues: ReviewIssue[];
  summary: string;
  createdAt: string;
}

export type CreativeStatus =
  | 'planned'
  | 'rejected'
  | 'awaiting_images' // 手渡しモードで人の Midjourney 生成待ち
  | 'produced'
  | 'qa_failed'
  | 'published'
  | 'paused'
  | 'retired'
  | 'failed';

export interface Asset {
  ratio: Ratio;
  kind: Format;
  path: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface ImageJob {
  ratio: Ratio;
  provider: string;
  jobId?: string;
  prompt: string;
  requestedAt: string;
  /** 生成済みの候補画像 */
  paths?: string[];
  /** 画像審査で選ばれた候補 */
  selected?: number;
  /** 生成待ちの状況（手渡しモードでは画像の置き場所） */
  note?: string;
  /** Midjourney Video などで作った動画クリップ */
  clip?: string | null;
}

export interface DailyMetric {
  date: string;
  platform: Platform;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  /** 動画の3秒再生・ThruPlay 等 */
  videoViews?: number;
}

export interface Creative {
  id: string;
  briefId: string;
  jobId: string;
  personaId: string;
  angle: Angle;
  format: Format;
  explore: boolean;
  status: CreativeStatus;
  statusReason?: string;
  /** 比率ごとの画像生成依頼（画像広告は 4:5 と 9:16、動画は 9:16 の背景を作る） */
  imageJobs: ImageJob[];
  assets: Asset[];
  qa?: { score: number; notes: string; selectedIndex: number };
  /** 媒体側で実際に配信中か（collect で同期。下書き入稿で人がまだ ON にしていなければ false） */
  live?: boolean;
  platformRefs: {
    meta?: { adIds: string[]; creativeIds: string[]; status?: string; previewUrl?: string };
    google?: { assetResourceNames: string[]; linkedTo: string[]; youtubeVideoId?: string; status?: string };
  };
  metrics: DailyMetric[];
  createdAt: string;
  publishedAt?: string;
  updatedAt: string;
  organic?: OrganicPost;
  /** Instagram 投稿に失敗した回数（一定回数で候補から外す） */
  organicFailures?: number;
  /** 一部の媒体だけ入稿に失敗したとき、再試行する媒体と回数 */
  pendingPlatforms?: Platform[];
  publishRetries?: number;
  /** 選考結果（ATS / スプレッドシートから取り込み）。広告経由の応募者がどこまで進んだか */
  funnel?: { applied: number; interview: number; offer: number; hired: number; updatedAt: string };
}

export interface OrganicPost {
  kind: 'feed' | 'reels';
  mediaId: string;
  permalink: string;
  postedAt: string;
  caption: string;
  insights: { date: string; reach: number; views: number; likes: number; comments: number; saved: number; shares: number }[];
}

export interface Insight {
  date: string;
  summary: string;
  learnings: string[];
  nextActions: string[];
  angleRanking: { angle: Angle; note: string }[];
}

export interface Decision {
  date: string;
  creativeId?: string;
  adsetId?: string;
  action: 'pause' | 'activate' | 'scale_budget' | 'retire' | 'keep';
  reason: string;
  applied: boolean;
  detail?: Record<string, unknown>;
}

export interface CycleRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  dryRun: boolean;
  steps: { name: string; ok: boolean; note: string; ms: number }[];
  llmCostUsd: number;
}

export interface LlmUsage {
  date: string;
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Google 検索広告（レスポンシブ検索広告）。画像素材と別に管理する */
export interface SearchAd {
  id: string;
  jobId: string;
  adGroupId: string;
  resourceName?: string;
  headlines: string[];
  descriptions: string[];
  path1?: string;
  path2?: string;
  status: 'draft' | 'live' | 'paused' | 'failed';
  statusReason?: string;
  metrics: DailyMetric[];
  createdAt: string;
  /** 作成した日（日本時間の YYYY-MM-DD） */
  createdOn: string;
}

export interface State {
  version: 1;
  searchAds?: Record<string, SearchAd>;
  /** 緊急停止中（解除するまで企画・制作・入稿・投稿をしない） */
  halted?: { at: string; reason: string };
  /** 週次の戦略メモ */
  memos?: { date: string; headline: string; findings: string[]; decisions: { topic: string; recommendation: string; why: string }[]; experiments: string[] }[];
  briefs: Record<string, CreativeBrief>;
  reviews: Review[];
  creatives: Record<string, Creative>;
  insights: Insight[];
  decisions: Decision[];
  cycles: CycleRecord[];
  llmUsage: LlmUsage[];
}
