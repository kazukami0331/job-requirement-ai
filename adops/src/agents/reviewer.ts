/**
 * レビューエージェント。機械チェック（compliance/rules.ts）の結果を前提として渡し、
 * 広告としての強さと、機械では拾えない誤解・不適切表現を見る。
 * 最終判定（pass / revise / reject）は AI の点数をもとにコードで確定させる。
 */
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import { ANGLE_LABELS, FORMAT_LABEL, type CreativeBrief, type Review, type ReviewIssue, type Rubric, type RubricItem } from '../types.ts';
import { checkBrief, formatYen, hasBlocker } from '../compliance/rules.ts';
import { ReviewOutputSchema, RubricReviewSchema } from './schemas.ts';

const REVIEWER_INTRO = `あなたは求人広告の審査とクリエイティブディレクションを兼ねるシニアレビュアーです。
ブルーカラー職の求職者向け SNS 広告を、次の観点で厳しく採点し、制作者が直せる具体的な指摘を返します。`;

const REVIEWER_RULES = `# 指摘のルール
- blocker: 法令（年齢・性別制限、虚偽表示）・媒体ポリシー違反・求人情報との不一致。これがあると入稿しない
- major: 成果を大きく落とす問題（フックが弱い、条件が伝わらない、ペルソナとずれる）
- minor: 細かな改善
- 機械チェックで既に出ている指摘は繰り返さなくてよい。機械では拾えない問題（文脈上の誤解、言外の差別的ニュアンス、
  ステレオタイプ、現場の安全描写の問題、媒体で不承認になりやすい表現）を重点的に見る
- suggestion には書き換え案そのものを書く（「改善してください」ではなく「『寮費0円で今月から働ける』に」）
- 外国語の広告（language あり）は、原文と日本語訳（translationJa）が同じ意味かを必ず確かめる。訳にない約束・金額・条件が
  原文にある、または原文が誇張・差別的なら blocker。国籍・在留資格で応募者を限定・排除する表現も blocker。
  原文の自然さ・分かりやすさ（やさしい言い回しか）も採点に含める`;

export const REVIEWER_SYSTEM = `${REVIEWER_INTRO}

# 採点（各0〜20点）
- hook: スマホのフィードでスクロールを止められるか。最初の1秒で「自分ごと」になるか
- clarity: 何の仕事で、どこで、いくらで、どんな人向けか、3秒で分かるか
- personaFit: 指定ペルソナの動機・不安に正面から応えているか
- credibility: 誇張がなく、求人情報と完全に一致しているか（ない待遇・上限超えの金額は blocker）
- visualFit: 画像構想とコピーが一致し、安全装備・清潔な現場など信頼できる絵になるか

${REVIEWER_RULES}`;

/** その企画に当てはまる採点項目（仮説の項目は仮説に沿った企画だけ）。 */
export function rubricItemsFor(rubric: Rubric, brief: CreativeBrief): RubricItem[] {
  return rubric.items.filter((it) => it.appliesWhen !== 'hypothesis' || Boolean(brief.hypothesisId));
}

/** 自社の採点基準のシステムプロンプト。 */
export function rubricSystem(items: RubricItem[]): string {
  const lines = items.map((it) => {
    const levels = it.levels ? Object.entries(it.levels).map(([k, v]) => `    ${k}点: ${v}`).join('\n') : '';
    return `- [${it.id}] ${it.label}${(it.weight ?? 1) !== 1 ? `（重み ${it.weight}）` : ''}: ${it.description}${levels ? `\n${levels}` : ''}`;
  });
  return `${REVIEWER_INTRO}

# 採点（自社の基準。各項目 1〜5 点。項目 ID をそのまま返す）
${lines.join('\n')}

${REVIEWER_RULES}`;
}

/** 項目ごとの点数（1〜5）を重みつきで 100 点満点にする。返ってこなかった項目は 1 点として扱う（甘く通さない）。 */
export function rubricScore(items: RubricItem[], scores: Record<string, number>): number {
  const total = items.reduce((a, it) => a + (it.weight ?? 1) * 5, 0);
  const got = items.reduce((a, it) => a + (it.weight ?? 1) * (scores[it.id] ?? 1), 0);
  return total ? Math.round((got / total) * 100) : 0;
}

export interface ReviewResult {
  review: Review;
  issues: ReviewIssue[];
}

export function decideVerdict(
  score: number,
  issues: ReviewIssue[],
  passScore: number,
  revision: number,
  maxRevisions: number,
  ruleIssues: ReviewIssue[] = [],
): Review['verdict'] {
  if (hasBlocker(issues)) return revision >= maxRevisions ? 'reject' : 'revise';
  if (score >= passScore && !issues.some((i) => i.severity === 'major')) return 'pass';
  // 機械チェックの major（根拠のない No.1・NG表現・給与の単位違いなど）は、最後まで直らなければ出さない
  if (revision >= maxRevisions) return score >= passScore && !ruleIssues.some((i) => i.severity === 'major') ? 'pass' : 'reject';
  return 'revise';
}

export async function reviewBrief(llm: Llm, brief: CreativeBrief, catalog: Catalog): Promise<ReviewResult> {
  const job = catalog.jobs.find((j) => j.id === brief.jobId)!;
  const persona = catalog.personas.find((p) => p.id === brief.personaId)!;
  const ruleIssues = checkBrief(brief, job, catalog.brand);
  const { passScore, maxRevisions } = catalog.policy.review;

  const s = job.salary;
  const prompt = `# 求人情報
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
    ...(brief.language ? { language: brief.language, translationJa: brief.translationJa } : {}),
  },
  null,
  2,
)}
${(() => {
  const h = brief.hypothesisId ? catalog.hypotheses?.find((x) => x.id === brief.hypothesisId) : undefined;
  return h ? `\n# 社内で決めた検証仮説（この打ち出しに忠実かも見る）\n${h.title}: ${h.message}\n` : '';
})()}
# 機械チェックの結果
${ruleIssues.length ? ruleIssues.map((i) => `- [${i.severity}] ${i.field}: ${i.problem}`).join('\n') : '- 指摘なし'}`;
  const rubric = catalog.rubric;
  if (rubric) {
    const items = rubricItemsFor(rubric, brief);
    const out = await llm.structured({ agent: 'reviewer.rubric', tier: 'fast', system: rubricSystem(items), prompt, schema: RubricReviewSchema });
    const scores: Record<string, number> = {};
    const notes: Record<string, string> = {};
    for (const r of out.rubric) {
      if (!items.some((it) => it.id === r.id)) continue;
      scores[r.id] = Math.max(1, Math.min(5, Math.round(r.score)));
      notes[r.id] = r.reason;
    }
    const score = rubricScore(items, scores);
    const issues = [...ruleIssues, ...out.issues];
    const verdict = decideVerdict(score, issues, passScore, brief.revision, maxRevisions, ruleIssues);
    return {
      issues,
      review: { briefId: brief.id, revision: brief.revision, reviewer: 'ai', score, scores, verdict, issues, summary: out.summary, createdAt: new Date().toISOString(), rubricVersion: rubric.version, rubricNotes: notes },
    };
  }
  const ai = await llm.structured({
    agent: 'reviewer',
    tier: 'fast',
    system: REVIEWER_SYSTEM,
    prompt,
    schema: ReviewOutputSchema,
  });

  const clamp = (n: number) => Math.max(0, Math.min(20, Math.round(n)));
  const scores = Object.fromEntries(Object.entries(ai.scores).map(([k, v]) => [k, clamp(v)]));
  const score = Object.values(scores).reduce((a, b) => a + b, 0);
  const issues = [...ruleIssues, ...ai.issues];
  const verdict = decideVerdict(score, issues, passScore, brief.revision, maxRevisions, ruleIssues);

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
