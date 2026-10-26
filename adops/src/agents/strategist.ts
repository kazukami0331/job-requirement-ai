/**
 * 企画エージェント（ストラテジスト兼コピーライター兼アートディレクター）。
 * 「何を試すか」（求人×ペルソナ×訴求軸×形式）はコード側の配分ロジックが決め、
 * このエージェントは「どう表現するか」だけを担う。
 */
import type { Llm } from '../llm/llm.ts';
import type { Catalog } from '../config.ts';
import { ANGLE_LABELS, type Angle, type CreativeBrief, type Format, type Job, type Persona, type ReviewIssue } from '../types.ts';
import { formatYen } from '../compliance/rules.ts';
import { BriefDraftSchema, PlanOutputSchema, type BriefDraft } from './schemas.ts';

export interface Slot {
  slot: number;
  jobId: string;
  personaId: string;
  angle: Angle;
  format: Format;
  explore: boolean;
}

export interface PlanningContext {
  /** 分析エージェントがまとめた直近の学び */
  learnings: string[];
  /** 成果の良かった広告のコピー（再現の参考） */
  winners: { angle: Angle; headline: string; overlayMain: string; ctr: number; cpa: number | null }[];
  /** 成果の悪かった広告（避ける参考） */
  losers: { angle: Angle; headline: string; overlayMain: string; ctr: number }[];
  /** 既に配信中のメインコピー（重複を避ける） */
  activeHooks: string[];
}

export const STRATEGIST_SYSTEM = `あなたはブルーカラー（製造・物流・建設・ドライバー・警備・設備など）専門の人材紹介会社で、
SNS広告（Meta: Instagram/Facebook、Google: YouTube/ディスプレイ/デマンドジェネレーション）の企画とコピーを担当するプロです。

# 目的
求職者の応募を最小単価で最大化する。インプレッションを取るだけでなく、「自分ごと」と感じて応募まで進む広告を作る。

# 原則
- 見る人はスマホを縦スクロール中。最初の1秒（フック）で「自分の話だ」と思わせる。
- 抽象語（やりがい・アットホーム）より具体（寮費0円・月給30万円〜・土日休み・手積みなし）。
- 数字・待遇は**求人情報に書かれている事実だけ**を使う。書かれていない待遇・金額は絶対に作らない。
- 給与は求人情報と同じ単位（月給なら月給）で、上限を超えない。月収例を使うなら条件も書く。
- 年齢・性別を限定/優遇する表現、成果保証（必ず稼げる）、根拠のない最上級（No.1・業界最高）は禁止。
- 閲覧者の経済状況などを断定・示唆しない（「借金ある人へ」「お金に困ってる？」は Meta で不承認）。
- 働く人を見下さない。「誰でもできる」「底辺」等は使わない。仕事への敬意を込める。
- 画像に載せる文字（overlay）は短く。main は全角16字以内、sub は28字以内、badges は10字以内を最大3つ。
- 画像生成プロンプト（imagePrompt）は英語で、文字を一切含まない情景にする（文字は後で合成する）。
  実在しそうな日本の職場・日本人の働き手、ヘルメット等の安全装備を正しく着用、清潔で明るい現場。
  必ず "no text, no letters, no logos" を含め、--ar などのパラメータは付けない。
- 動画（format=video）は 9:16 縦型で 8〜20 秒。storyboard は「フック → 条件・ベネフィット → 不安解消 → 行動喚起」の流れで3〜5カット。
  各カットの text は画面に出す字幕（全角16字以内）、visual はそのカットの絵（英語可）。画像広告は storyboard を空配列にする。
- 探索枠（explore=true）は、過去の勝ちパターンにとらわれず新しい切り口を大胆に試す。
  活用枠（explore=false）は、過去の学びと勝ちコピーの要素を活かして勝率を上げる。
- 既に配信中のコピーと同じフックは作らない。`;

function describeJob(job: Job): string {
  const s = job.salary;
  return [
    `- 求人ID: ${job.id}`,
    `- 職種: ${job.title}（${job.category}）`,
    `- 勤務地: ${job.location}`,
    `- 雇用形態: ${job.employmentType}`,
    `- 給与: ${s.type} ${formatYen(s.min)}${s.max ? `〜${formatYen(s.max)}` : '〜'}${s.note ? `（${s.note}）` : ''}`,
    `- 待遇: ${job.perks.join(' / ')}`,
    job.hours ? `- 勤務時間: ${job.hours}` : '',
    job.holidays ? `- 休日: ${job.holidays}` : '',
    job.requirements ? `- 応募条件: ${job.requirements}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function describePersona(p: Persona): string {
  return [
    `- ペルソナID: ${p.id}（${p.name}）`,
    `- 概要: ${p.summary}`,
    `- 動機: ${p.motivations.join(' / ')}`,
    `- 不安: ${p.pains.join(' / ')}`,
    `- よく見る媒体: ${p.media.join(' / ')}`,
    p.vocabulary?.use?.length ? `- 響く言葉: ${p.vocabulary.use.join(' / ')}` : '',
    p.vocabulary?.avoid?.length ? `- 避ける言葉: ${p.vocabulary.avoid.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildPlanPrompt(slots: Slot[], catalog: Catalog, ctx: PlanningContext): string {
  const jobs = new Map(catalog.jobs.map((j) => [j.id, j]));
  const personas = new Map(catalog.personas.map((p) => [p.id, p]));
  const usedJobs = [...new Set(slots.map((s) => s.jobId))];
  const usedPersonas = [...new Set(slots.map((s) => s.personaId))];
  const b = catalog.brand;

  return `# ブランド
- 名称: ${b.name}
- トーン: ${b.tone}
${b.bannedPhrases.length ? `- 社内NG表現: ${b.bannedPhrases.join(' / ')}` : ''}
- 画像の共通スタイル（imagePrompt に反映）: ${b.visualStyle}

# 求人情報（ここに書かれた事実以外の待遇・数字は使わない）
${usedJobs.map((id) => describeJob(jobs.get(id)!)).join('\n\n')}

# ペルソナ
${usedPersonas.map((id) => describePersona(personas.get(id)!)).join('\n\n')}

# これまでの学び（分析エージェントより）
${ctx.learnings.length ? ctx.learnings.map((l) => `- ${l}`).join('\n') : '- まだデータがありません。基本に忠実に。'}

# 成果が良かった広告
${ctx.winners.length ? ctx.winners.map((w) => `- [${ANGLE_LABELS[w.angle]}] 「${w.overlayMain}」/ ${w.headline}（CTR ${w.ctr.toFixed(2)}%${w.cpa ? `, 応募単価 ${Math.round(w.cpa)}円` : ''}）`).join('\n') : '- なし'}

# 成果が悪かった広告（同じ方向は避ける）
${ctx.losers.length ? ctx.losers.map((w) => `- [${ANGLE_LABELS[w.angle]}] 「${w.overlayMain}」/ ${w.headline}（CTR ${w.ctr.toFixed(2)}%）`).join('\n') : '- なし'}

# 配信中のフック（重複させない）
${ctx.activeHooks.length ? ctx.activeHooks.map((h) => `- ${h}`).join('\n') : '- なし'}

# 依頼する枠
次の枠それぞれについて広告を1本ずつ企画してください。slot 番号をそのまま返してください。
${slots
  .map(
    (s) =>
      `- slot ${s.slot}: 求人=${s.jobId} / ペルソナ=${s.personaId} / 訴求軸=${ANGLE_LABELS[s.angle]}(${s.angle}) / 形式=${s.format === 'video' ? '動画(9:16)' : '画像'} / ${s.explore ? '探索枠' : '活用枠'}`,
  )
  .join('\n')}`;
}

export async function planBriefs(llm: Llm, slots: Slot[], catalog: Catalog, ctx: PlanningContext): Promise<(BriefDraft & { slot: number })[]> {
  if (slots.length === 0) return [];
  const out = await llm.structured({
    agent: 'strategist.plan',
    system: STRATEGIST_SYSTEM,
    prompt: buildPlanPrompt(slots, catalog, ctx),
    schema: PlanOutputSchema,
  });
  // 依頼していない枠・重複は捨てる
  const wanted = new Set(slots.map((s) => s.slot));
  const seen = new Set<number>();
  return out.briefs.filter((b) => wanted.has(b.slot) && !seen.has(b.slot) && seen.add(b.slot));
}

export async function reviseBrief(llm: Llm, brief: CreativeBrief, issues: ReviewIssue[], reviewSummary: string, catalog: Catalog): Promise<BriefDraft> {
  const job = catalog.jobs.find((j) => j.id === brief.jobId)!;
  const persona = catalog.personas.find((p) => p.id === brief.personaId)!;
  const { id, cycleId, jobId, personaId, angle, format, explore, revision, createdAt, ...draft } = brief;
  return llm.structured({
    agent: 'strategist.revise',
    system: STRATEGIST_SYSTEM,
    prompt: `次の広告企画がレビューで差し戻されました。指摘をすべて解消した改訂版を返してください。
訴求軸（${ANGLE_LABELS[angle]}）と形式（${format === 'video' ? '動画' : '画像'}）は変えないでください。良い部分は残してください。

# 求人情報
${describeJob(job)}

# ペルソナ
${describePersona(persona)}

# 現在の企画（JSON）
${JSON.stringify(draft, null, 2)}

# レビュー総評
${reviewSummary}

# 指摘
${issues.map((i) => `- [${i.severity}] ${i.field}: ${i.problem} → ${i.suggestion}`).join('\n')}`,
    schema: BriefDraftSchema,
  });
}
