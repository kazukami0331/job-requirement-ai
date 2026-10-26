/**
 * レビューエージェント。機械チェック（compliance/rules.ts）の結果を前提として渡し、
 * 広告としての強さと、機械では拾えない誤解・不適切表現を見る。
 * 最終判定（pass / revise / reject）は AI の点数をもとにコードで確定させる。
 */
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import { ANGLE_LABELS, FORMAT_LABEL, type CreativeBrief, type Review, type ReviewIssue } from '../types.ts';
import { checkBrief, formatYen, hasBlocker } from '../compliance/rules.ts';
import { ReviewOutputSchema } from './schemas.ts';

export const REVIEWER_SYSTEM = `あなたは求人広告の審査とクリエイティブディレクションを兼ねるシニアレビュアーです。
ブルーカラー職の求職者向け SNS 広告を、次の観点で厳しく採点し、制作者が直せる具体的な指摘を返します。

# 採点（各0〜20点）
- hook: スマホのフィードでスクロールを止められるか。最初の1秒で「自分ごと」になるか
- clarity: 何の仕事で、どこで、いくらで、どんな人向けか、3秒で分かるか
- personaFit: 指定ペルソナの動機・不安に正面から応えているか
- credibility: 誇張がなく、求人情報と完全に一致しているか（ない待遇・上限超えの金額は blocker）
- visualFit: 画像構想とコピーが一致し、安全装備・清潔な現場など信頼できる絵になるか

# 指摘のルール
- blocker: 法令（年齢・性別制限、虚偽表示）・媒体ポリシー違反・求人情報との不一致。これがあると入稿しない
- major: 成果を大きく落とす問題（フックが弱い、条件が伝わらない、ペルソナとずれる）
- minor: 細かな改善
- 機械チェックで既に出ている指摘は繰り返さなくてよい。機械では拾えない問題（文脈上の誤解、言外の差別的ニュアンス、
  ステレオタイプ、現場の安全描写の問題、媒体で不承認になりやすい表現）を重点的に見る
- suggestion には書き換え案そのものを書く（「改善してください」ではなく「『寮費0円で今月から働ける』に」）`;

export interface ReviewResult {
  review: Review;
  issues: ReviewIssue[];
}

export function decideVerdict(score: number, issues: ReviewIssue[], passScore: number, revision: number, maxRevisions: number): Review['verdict'] {
  if (hasBlocker(issues)) return revision >= maxRevisions ? 'reject' : 'revise';
  if (score >= passScore && !issues.some((i) => i.severity === 'major')) return 'pass';
  if (revision >= maxRevisions) return score >= passScore ? 'pass' : 'reject';
  return 'revise';
}

export async function reviewBrief(llm: Llm, brief: CreativeBrief, catalog: Catalog): Promise<ReviewResult> {
  const job = catalog.jobs.find((j) => j.id === brief.jobId)!;
  const persona = catalog.personas.find((p) => p.id === brief.personaId)!;
  const ruleIssues = checkBrief(brief, job, catalog.brand);
  const { passScore, maxRevisions } = catalog.policy.review;

  const s = job.salary;
  const ai = await llm.structured({
    agent: 'reviewer',
    tier: 'fast',
    system: REVIEWER_SYSTEM,
    prompt: `# 求人情報
- 職種: ${job.title}（${job.location} / ${job.employmentType}）
- 給与: ${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}
- 待遇: ${job.perks.join(' / ')}
- 休日: ${job.holidays ?? '記載なし'} / 勤務時間: ${job.hours ?? '記載なし'}
- 応募条件: ${job.requirements ?? '記載なし'}

# ペルソナ
${persona.name}: ${persona.summary}
動機: ${persona.motivations.join(' / ')} / 不安: ${persona.pains.join(' / ')}

# 企画（訴求軸: ${ANGLE_LABELS[brief.angle]} / 形式: ${FORMAT_LABEL[brief.format]} / 改訂 ${brief.revision} 回目）
${JSON.stringify(
  {
    hypothesis: brief.hypothesis,
    hook: brief.hook,
    headline: brief.headline,
    primaryText: brief.primaryText,
    description: brief.description,
    cta: brief.cta,
    overlay: brief.overlay,
    storyboard: brief.storyboard,
    visualConcept: brief.visualConcept,
    imagePrompt: brief.imagePrompt,
  },
  null,
  2,
)}

# 機械チェックの結果
${ruleIssues.length ? ruleIssues.map((i) => `- [${i.severity}] ${i.field}: ${i.problem}`).join('\n') : '- 指摘なし'}`,
    schema: ReviewOutputSchema,
  });

  const clamp = (n: number) => Math.max(0, Math.min(20, Math.round(n)));
  const scores = Object.fromEntries(Object.entries(ai.scores).map(([k, v]) => [k, clamp(v)]));
  const score = Object.values(scores).reduce((a, b) => a + b, 0);
  const issues = [...ruleIssues, ...ai.issues];
  const verdict = decideVerdict(score, issues, passScore, brief.revision, maxRevisions);

  return {
    issues,
    review: {
      briefId: brief.id,
      revision: brief.revision,
      reviewer: 'ai',
      score,
      scores,
      verdict,
      issues,
      summary: ai.summary,
      createdAt: new Date().toISOString(),
    },
  };
}
