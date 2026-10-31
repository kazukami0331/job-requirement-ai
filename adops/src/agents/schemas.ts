import { z } from 'zod';
import { ANGLES } from '../types.ts';

export const BriefDraftSchema = z.object({
  hypothesis: z.string().describe('この広告で検証する仮説（誰の何に刺さるか）'),
  hook: z.string().describe('最初の1秒で止める一言'),
  headline: z.string().describe('広告の見出し（全角20字以内推奨）'),
  primaryText: z.string().describe('広告本文（冒頭125字で要点が伝わるように）'),
  description: z.string().describe('リンク説明（全角30字以内）'),
  cta: z.enum(['APPLY_NOW', 'LEARN_MORE', 'SIGN_UP', 'CONTACT_US']),
  overlay: z.object({
    main: z.string().describe('画像に大きく載せる文字（全角16字以内）'),
    sub: z.string().describe('補足の文字（全角28字以内）'),
    badges: z.array(z.string()).describe('バッジ（各10字以内、最大3つ）'),
  }),
  storyboard: z
    .array(z.object({ seconds: z.number(), text: z.string(), visual: z.string() }))
    .describe('動画のカット構成、またはカルーセルのカード（3〜5枚）。画像広告なら空配列'),
  visualConcept: z.string().describe('どんな写真か（日本語で人向けに説明）'),
  imagePrompt: z.string().describe('Midjourney 用の英語プロンプト。文字を含めない情景描写。"no text" を含める。パラメータ(--ar 等)は付けない'),
  translationJa: z
    .object({
      hook: z.string(),
      headline: z.string(),
      primaryText: z.string(),
      description: z.string(),
      main: z.string(),
      sub: z.string(),
      badges: z.array(z.string()),
      storyboard: z.array(z.string()).describe('storyboard の各 text の訳（同じ順・同じ数）'),
    })
    .optional()
    .describe('外国語で書いた場合の、各項目の正確な日本語訳（意訳や誇張をしない）。日本語の広告なら全項目を空文字・空配列に'),
});
export type BriefDraft = z.infer<typeof BriefDraftSchema>;

export const PlanOutputSchema = z.object({
  briefs: z.array(
    BriefDraftSchema.extend({
      slot: z.number().describe('依頼された枠番号'),
    }),
  ),
});

export const ReviewOutputSchema = z.object({
  scores: z.object({
    hook: z.number().describe('0-20 スクロールを止める力'),
    clarity: z.number().describe('0-20 何の仕事でどんな条件か一瞬で分かるか'),
    personaFit: z.number().describe('0-20 ペルソナの動機・不安に合っているか'),
    credibility: z.number().describe('0-20 誇張がなく信頼できるか・求人情報と一致するか'),
    visualFit: z.number().describe('0-20 画像の構想がコピーと合い、安全で清潔な現場として描けるか'),
  }),
  issues: z.array(
    z.object({
      severity: z.enum(['blocker', 'major', 'minor']),
      field: z.string(),
      problem: z.string(),
      suggestion: z.string(),
    }),
  ),
  summary: z.string().describe('制作者へのフィードバック（2〜3文）'),
});

/** 自社の採点基準（rubric.json）で採点するときの出力。項目は設定で変わるので id 付きの配列で受ける */
export const RubricReviewSchema = z.object({
  rubric: z.array(
    z.object({
      id: z.string().describe('採点基準の項目 ID'),
      score: z.number().describe('1-5'),
      reason: z.string().describe('その点数の理由（1文）'),
    }),
  ),
  issues: ReviewOutputSchema.shape.issues,
  summary: z.string().describe('制作者へのフィードバック（2〜3文）'),
});

export const ImageJudgeSchema = z.object({
  candidates: z.array(
    z.object({
      index: z.number(),
      score: z.number().describe('0-100'),
      defects: z.array(z.string()).describe('崩れた手足・文字化け・安全装備なし・不自然さなど'),
    }),
  ),
  selectedIndex: z.number().describe('最も良い候補の index。全て使えない場合は -1'),
  reason: z.string(),
});

export const FinalQaSchema = z.object({
  pass: z.boolean(),
  score: z.number().describe('0-100'),
  problems: z.array(z.string()),
  note: z.string(),
});

export const InsightSchema = z.object({
  summary: z.string().describe('今週の結果の要約（3〜5文、数字を入れる）'),
  learnings: z.array(z.string()).describe('次の企画にそのまま使える学び（「〜は効く」「〜は効かない」）'),
  nextActions: z.array(z.string()).describe('次に試すこと'),
  angleRanking: z.array(z.object({ angle: z.enum(ANGLES), note: z.string() })),
});
