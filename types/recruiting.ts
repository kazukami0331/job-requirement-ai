// 採用モニタリング用のドメイン型
// ジョブオプ（採用管理）の応募エクスポートを正規化したものを扱う

/** 選考ステータス（ジョブオプのマスタ準拠） */
export type SelectionStatusId =
  | "1" // 未対応
  | "2" // 面接予約待ち
  | "3" // 面接待ち
  | "4" // 面接結果待ち
  | "5" // 採用
  | "6" // 不採用（面接前）
  | "7" // 不採用（面接後）
  | "500" // 面接希望回答待ち
  | "501"; // 面接日確定待ち

/** ダッシュボード上のファネル段階（選考ステータスを束ねたもの） */
export type FunnelStage =
  | "applied" // 応募（全件の入口）
  | "untouched" // 未対応
  | "scheduling" // 面接調整中
  | "interviewScheduled" // 面接待ち（日程確定済み）
  | "interviewed" // 面接結果待ち
  | "hired" // 採用
  | "rejectedBefore" // 不採用・辞退（面接前）
  | "rejectedAfter"; // 不採用・辞退（面接後）

/** 1件の応募 */
export interface Application {
  /** 応募ID（一意キー） */
  applicationId: string;
  /** 応募受付日時 ISO8601 */
  receivedAt: string;
  /** 応募受付日 YYYY-MM-DD */
  receivedDate: string;
  shopId: string;
  /** 店舗名（例: Winスクール 北千住校） */
  shopName: string;
  /** 店舗名から「Winスクール 」等のブランド接頭辞を除いた短縮名 */
  shopShortName: string;
  /** 雇用形態名（業務委託 / 正社員 / アルバイト...） */
  employmentType: string;
  employmentTypeCode: string;
  statusId: string;
  statusName: string;
  /** 選考ステータス最終更新日時 ISO8601 */
  statusUpdatedAt: string | null;
  /** 面接開始日時 ISO8601 */
  interviewStartAt: string | null;
  /** 不採用理由 */
  rejectReason: string | null;
  /** 媒体名（例: ジョブオプ採用管理（Indeed PLUS）） */
  media: string;
  /** 応募経路名（WEB / 電話 / その他） */
  route: string;
  /** 表示用職種名 */
  jobTitle: string;
  age: number | null;
  gender: string | null;
}

/** 週次スナップショット（アップロード1回分） */
export interface Snapshot {
  /** スナップショットID */
  id: string;
  /** 取得日時（=アップロードしたファイルの基準日） ISO8601 */
  takenAt: string;
  /** 元ファイル名 */
  sourceFileName: string;
  applications: Application[];
}

/** スナップショットを串刺しにした結果の1応募 */
export interface MergedApplication extends Application {
  /** この応募が初めて観測されたスナップショットの取得日時 */
  firstSeenAt: string;
  /** ステータスの変遷（スナップショット間の差分） */
  statusHistory: { observedAt: string; statusId: string; statusName: string }[];
}

/** 採用計画（不足人数マスタ）の1行 = 校舎 × 講座区分 */
export interface PlanRow {
  id: string;
  /** フェーズ区分（例: 今期 / FY28上期） */
  phase: string;
  /** 校舎名 */
  shopShortName: string;
  /** 講座区分 IT / D/W / C */
  category: PlanCategory;
  /** 指標グループA（3列） */
  groupA: [number, number, number];
  /** 指標グループB（3列） */
  groupB: [number, number, number];
  /** 指標グループC（3列）＝不足人数 */
  groupC: [number, number, number];
  /** 校舎単位の不足人数（IT行にのみ入る想定） */
  shortage: number | null;
  /** 充足期限 */
  deadline: string;
  /** フラグ（○ など） */
  flag: string;
  /** 備考 */
  note: string;
}

export type PlanCategory = "IT" | "D/W" | "C";

/**
 * 不足人数マスタの見出しラベル。
 * 元CSVは文字化けで日本語見出しが失われていたため、アプリ側で編集できるようにしている。
 */
export interface PlanLabels {
  groupA: string;
  groupB: string;
  groupC: string;
  /** 各グループ共通の3サブ列の見出し */
  sub: [string, string, string];
  shortage: string;
  deadline: string;
  flag: string;
}

export const DEFAULT_PLAN_LABELS: PlanLabels = {
  groupA: "グループA",
  groupB: "グループB",
  groupC: "不足人数",
  sub: ["区分1", "区分2", "区分3"],
  shortage: "校舎計 不足人数",
  deadline: "充足期限",
  flag: "フラグ",
};

/** 採用計画全体 */
export interface HiringPlan {
  labels: PlanLabels;
  rows: PlanRow[];
  updatedAt: string;
}
