/**
 * 応募ページ（LP）の作成・承認・公開。
 *
 * - 稼働中の求人 × ペルソナ（× 社内の仮説）ごとに、Claude が文章を書き、法令チェックを通ったものを下書きにする
 *   （data/lp-drafts/<id>.html。レポート画面の /adops/lp-drafts/<id>.html で確認できる）
 * - 人が承認すると data/lp/<id>.html に置かれ、/lp/<id> で公開される（Vercel の app/lp ルートが状態ブランチから返す）
 * - 公開中の LP は毎回、最新の求人情報で作り直す。求人情報が変わって文章が合わなくなったら自動で公開をやめる
 * - 募集を終えた求人の LP も公開をやめる
 * 給与・勤務地などの事実は求人情報からそのまま表示し、AI には書かせない。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.ts';
import type { Hypothesis, Job, LandingPage, LpCopy, ReviewIssue } from '../types.ts';
import { checkTexts, googleWidth } from '../compliance/rules.ts';
import { writeLp } from '../agents/lpWriter.ts';
import { renderLp } from '../lp/html.ts';
import { placeholderProblems } from '../config.ts';
import { daysBetween, newId } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('lp');

/** 文章の検査（法令・社内 NG・求人に無い待遇・給与）と、長さの目安。 */
export function checkLpCopy(copy: LpCopy, job: Job, brand: Ctx['catalog']['brand']): ReviewIssue[] {
  const fields: [string, string][] = [
    ['heroTitle', copy.heroTitle],
    ['heroSub', copy.heroSub],
    ...copy.heroBadges.map((b, i) => [`heroBadges[${i}]`, b] as [string, string]),
    ['empathyTitle', copy.empathyTitle],
    ['empathyBody', copy.empathyBody],
    ...copy.points.flatMap((p, i) => [[`points[${i}].title`, p.title], [`points[${i}].body`, p.body]] as [string, string][]),
    ...copy.faq.flatMap((f, i) => [[`faq[${i}].q`, f.q], [`faq[${i}].a`, f.a]] as [string, string][]),
    ['ctaText', copy.ctaText],
    ['closing', copy.closing],
  ];
  const issues = checkTexts(fields, job, brand);
  const long = (field: string, text: string, max: number) =>
    googleWidth(text) > max * 2 ? [{ severity: 'minor' as const, field, problem: `長すぎます（全角${max}字以内の目安）`, suggestion: '短くしてください' }] : [];
  issues.push(...long('heroTitle', copy.heroTitle, 24), ...long('ctaText', copy.ctaText, 14));
  if (copy.points.length < 3) issues.push({ severity: 'major', field: 'points', problem: '選ぶ理由が3つありません', suggestion: '3つにしてください' });
  if (!copy.faq.length) issues.push({ severity: 'major', field: 'faq', problem: 'よくある質問がありません', suggestion: '3〜5個入れてください' });
  return issues;
}

const HUMAN_RETIRE = '人が公開を終了';

const serious = (issues: ReviewIssue[]) => issues.filter((i) => i.severity !== 'minor');

function lpDir(ctx: Ctx, kind: 'lp' | 'lp-drafts'): string {
  const d = join(ctx.settings.dataDir, kind);
  mkdirSync(d, { recursive: true });
  return d;
}

/** 公開 URL（ADOPS_LP_BASE_URL、無ければレポートの URL と同じドメインの /lp/）。 */
export function lpUrl(id: string): string {
  const base = (process.env.ADOPS_LP_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (base) return `${base}/${id}`;
  const report = (process.env.ADOPS_REPORT_URL ?? '').trim();
  try {
    if (report) return `${new URL(report).origin}/lp/${id}`;
  } catch {
    /* 不正な URL は相対パスにする */
  }
  return `/lp/${id}`;
}

/** 下書きの確認用 URL（レポート画面と同じ認証で見られる）。 */
export function lpPreviewUrl(id: string): string {
  const report = (process.env.ADOPS_REPORT_URL ?? '').trim().replace(/\/$/, '');
  return report ? `${report}/lp-drafts/${id}.html` : `data/lp-drafts/${id}.html`;
}

/** 作るべき LP（求人 × 日本語のペルソナ × 社内の仮説。仮説の無いペルソナは1本）。 */
export function lpTargets(ctx: Ctx): { job: Job; personaId: string; hypothesis?: Hypothesis }[] {
  const out: { job: Job; personaId: string; hypothesis?: Hypothesis }[] = [];
  for (const job of ctx.catalog.jobs.filter((j) => j.active)) {
    for (const personaId of job.personas) {
      const persona = ctx.catalog.personas.find((p) => p.id === personaId);
      // 外国語の LP はまだ作らない（訳の確認の仕組みを LP にも用意してから）
      if (!persona || (persona.language && persona.language !== 'ja')) continue;
      const hyps = (ctx.catalog.hypotheses ?? []).filter((h) => h.active !== false && h.personaId === personaId && (!h.jobIds?.length || h.jobIds.includes(job.id)));
      if (hyps.length) for (const hypothesis of hyps) out.push({ job, personaId, hypothesis });
      else out.push({ job, personaId });
    }
  }
  return out;
}

/** 求人の募集終了・文章と求人情報の食い違いで、公開中の LP を止める。公開中のものは最新の求人情報で作り直す。 */
export function refreshLps(ctx: Ctx): string[] {
  const notes: string[] = [];
  for (const lp of Object.values(ctx.store.state.lps ?? {})) {
    if (lp.status !== 'live' && lp.status !== 'draft') continue;
    const job = ctx.catalog.jobs.find((j) => j.id === lp.jobId);
    const reason = !job || !job.active ? '求人の募集が終了したため' : serious(checkLpCopy(lp.copy, job, ctx.catalog.brand)).length ? '求人情報が変わり、文章と合わなくなったため（作り直します）' : '';
    const dir = lpDir(ctx, lp.status === 'live' ? 'lp' : 'lp-drafts');
    const file = join(dir, `${lp.id}.html`);
    if (reason) {
      rmSync(file, { force: true });
      lp.status = 'retired';
      lp.statusReason = reason;
      lp.retiredAt = new Date().toISOString();
      notes.push(`LP ${lp.id} を${reason.startsWith('求人の') ? '公開終了' : '取り下げ'}: ${reason}`);
      continue;
    }
    writeFileSync(file, renderLp(lp.copy, job!, ctx.catalog.brand, { slug: lp.id, draft: lp.status === 'draft' }));
  }
  return notes;
}

/** 足りない LP の下書きを作る（1回の実行で policy.lp.perCycle 本まで）。 */
export async function createLps(ctx: Ctx): Promise<string> {
  const conf = ctx.catalog.policy.lp;
  if (!conf?.enabled) return '';
  const lps = (ctx.store.state.lps ??= {});
  const notes = refreshLps(ctx);
  const key = (jobId: string, personaId: string, hypothesisId?: string) => `${jobId}|${personaId}|${hypothesisId ?? ''}`;
  const have = new Set(
    Object.values(lps)
      // 公開中・下書きがあるものは作らない。却下から7日（同じ失敗を繰り返さない）、人が公開を終了してから30日は作り直さない
      .filter(
        (l) =>
          l.status === 'live' ||
          l.status === 'draft' ||
          (l.status === 'rejected' && daysBetween(l.createdOn, ctx.today) < 7) ||
          (l.status === 'retired' && l.statusReason === HUMAN_RETIRE && daysBetween((l.retiredAt ?? l.createdAt).slice(0, 10), ctx.today) < 30),
      )
      .map((l) => key(l.jobId, l.personaId, l.hypothesisId)),
  );
  const todo = lpTargets(ctx).filter((t) => !have.has(key(t.job.id, t.personaId, t.hypothesis?.id))).slice(0, conf.perCycle ?? 2);
  let drafted = 0;
  for (const t of todo) {
    const persona = ctx.catalog.personas.find((p) => p.id === t.personaId)!;
    try {
      let copy = await writeLp(ctx.llm, t.job, persona, ctx.catalog, t.hypothesis);
      let issues = checkLpCopy(copy, t.job, ctx.catalog.brand);
      // 問題があれば1回だけ直させる
      if (serious(issues).length) {
        copy = await writeLp(ctx.llm, t.job, persona, ctx.catalog, t.hypothesis, { copy, issues: serious(issues) });
        issues = checkLpCopy(copy, t.job, ctx.catalog.brand);
      }
      const id = `${t.job.id}-${newId('').replace(/^_/, '').slice(-6)}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const now = new Date().toISOString();
      const lp: LandingPage = { id, jobId: t.job.id, personaId: t.personaId, ...(t.hypothesis ? { hypothesisId: t.hypothesis.id } : {}), status: 'draft', copy, issues, createdAt: now, createdOn: ctx.today };
      if (serious(issues).length) {
        lp.status = 'rejected';
        lp.statusReason = serious(issues).map((i) => i.problem).join(' / ');
        notes.push(`LP 却下（${t.job.id}・${persona.name}）: ${lp.statusReason}`);
      } else {
        writeFileSync(join(lpDir(ctx, 'lp-drafts'), `${id}.html`), renderLp(copy, t.job, ctx.catalog.brand, { slug: id, draft: true }));
        drafted++;
      }
      lps[id] = lp;
    } catch (e) {
      log.warn(`${t.job.id}/${t.personaId}: LP の作成に失敗: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (drafted) notes.unshift(`LP の下書き ${drafted} 本`);
  return notes.join(' / ');
}

/** 下書きを承認して公開する。 */
export function approveLp(ctx: Ctx, id: string): string {
  const lp = ctx.store.state.lps?.[id];
  if (!lp) throw new Error(`LP ${id} がありません`);
  if (lp.status !== 'draft') throw new Error(`LP ${id} は下書きではありません（${lp.status}）`);
  const job = ctx.catalog.jobs.find((j) => j.id === lp.jobId);
  if (!job?.active) throw new Error(`LP ${id} の求人 ${lp.jobId} は募集していません`);
  // サンプル設定（社名未記入・example.com など）のままでは公開しない
  const placeholders = placeholderProblems(ctx.catalog);
  if (placeholders.length) throw new Error(`サンプル設定のままなので公開しません: ${placeholders.join(' / ')}`);
  const issues = serious(checkLpCopy(lp.copy, job, ctx.catalog.brand));
  if (issues.length) throw new Error(`LP ${id} は今の求人情報と合いません: ${issues.map((i) => i.problem).join(' / ')}`);
  writeFileSync(join(lpDir(ctx, 'lp'), `${id}.html`), renderLp(lp.copy, job, ctx.catalog.brand, { slug: id }));
  rmSync(join(lpDir(ctx, 'lp-drafts'), `${id}.html`), { force: true });
  lp.status = 'live';
  lp.approvedAt = new Date().toISOString();
  return `LP ${id} を公開しました: ${lpUrl(id)}`;
}

/** 公開をやめる（下書きなら取り下げ）。 */
export function retireLp(ctx: Ctx, id: string, reason = HUMAN_RETIRE): string {
  const lp = ctx.store.state.lps?.[id];
  if (!lp) throw new Error(`LP ${id} がありません`);
  for (const kind of ['lp', 'lp-drafts'] as const) {
    const f = join(ctx.settings.dataDir, kind, `${id}.html`);
    if (existsSync(f)) rmSync(f);
  }
  lp.status = 'retired';
  lp.statusReason = reason;
  lp.retiredAt = new Date().toISOString();
  return `LP ${id} の公開を終了しました`;
}
