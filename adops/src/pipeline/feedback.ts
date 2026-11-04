/**
 * 管理画面からの依頼（config/feedback.json）を処理する。人の判断・指示を AI の制作に戻す受け口。
 *
 * - 広告: 採用（入稿してよい）/ 却下（理由は以後の企画に渡す）/ 修正（コピーだけ・画像だけ・両方）/ 文言違いを作る（同じ画像で文言を変えた別の広告）
 * - LP: 修正（依頼を反映した下書きを作り直す）/ 公開 / 使わない
 * - Google 検索広告のテキスト: 修正（依頼を反映して作り直す）
 *
 * 処理した依頼は状態（feedbackDone）に結果を残し、二度処理しない。修正後の広告・LP も、法令チェックとレビューを通ったものだけ残す。
 */
import type { Ctx } from './context.ts';
import type { Creative, CreativeBrief, FeedbackRequest, ImageJob, Review, ReviewIssue } from '../types.ts';
import { reviseBrief } from '../agents/strategist.ts';
import { reviewBrief } from '../agents/reviewer.ts';
import { writeLp } from '../agents/lpWriter.ts';
import { writeRsa } from '../agents/searchWriter.ts';
import { approveLp, checkLpCopy, retireLp } from './lp.ts';
import { renderLp } from '../lp/html.ts';
import { newId } from '../util/id.ts';
import { logger } from '../util/log.ts';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { requiredRatios } from './produce.ts';

const log = logger('feedback');

const human = (note: string): ReviewIssue => ({ severity: 'major', field: '人からの修正依頼', problem: note, suggestion: `依頼どおりに直す: ${note}` });

type Scope = 'copy' | 'image' | 'both';

const SCOPE_NOTE: Record<Scope, string> = {
  copy: '（文言だけ直す。画像は今のものを使うので、imagePrompt・visualConcept・elements の絵に関する項目は変えない）',
  image: '（画像だけ作り直す。hook・headline・primaryText・description・overlay の文言は変えず、imagePrompt・visualConcept・elements を直す）',
  both: '（文言と画像の両方を直してよい）',
};

/** 修正の範囲の外の項目は元に戻す（AI が範囲外を書き換えても、画像と企画の記録が食い違わないように）。 */
function keepOutOfScope(orig: CreativeBrief, b: CreativeBrief, scope: Scope): CreativeBrief {
  // 動画・カルーセルのカットは、文字（text）と絵（visual）を範囲ごとに分けて戻す
  const scenes = (keep: 'text' | 'visual') =>
    orig.storyboard.length === b.storyboard.length ? b.storyboard.map((s, i) => ({ ...s, [keep]: orig.storyboard[i][keep] })) : keep === 'text' ? orig.storyboard : b.storyboard;
  if (scope === 'copy') {
    return {
      ...b,
      imagePrompt: orig.imagePrompt,
      visualConcept: orig.visualConcept,
      storyboard: scenes('visual'),
      ...(orig.elements ? { elements: { ...orig.elements, copyTone: b.elements?.copyTone ?? orig.elements.copyTone } } : {}),
    };
  }
  if (scope === 'image') {
    return {
      ...b,
      hook: orig.hook,
      headline: orig.headline,
      primaryText: orig.primaryText,
      description: orig.description,
      overlay: orig.overlay,
      cta: orig.cta,
      storyboard: scenes('text'),
      ...(orig.translationJa ? { translationJa: orig.translationJa } : {}),
      ...(b.elements && orig.elements ? { elements: { ...b.elements, copyTone: orig.elements.copyTone } } : {}),
    };
  }
  return b;
}

/** 人の依頼を反映し、レビューに通るまで直す（通らなければ例外）。 */
async function reviseWithReview(ctx: Ctx, brief: CreativeBrief, rawNote: string, scope: Scope): Promise<{ brief: CreativeBrief; review: Review }> {
  const { llm, catalog, store } = ctx;
  const { maxRevisions } = catalog.policy.review;
  const note = `${rawNote}${SCOPE_NOTE[scope]}`;
  let b: CreativeBrief = keepOutOfScope(brief, { ...brief, ...(await reviseBrief(llm, brief, [human(note)], `人からの修正依頼: ${note}`, catalog)), revision: brief.revision + 1 }, scope);
  b.storyboard = b.format === 'image' ? [] : b.storyboard;
  if (!b.language) delete b.translationJa;
  for (let i = 0; i <= maxRevisions; i++) {
    const { review } = await reviewBrief(llm, { ...b, revision: Math.min(i, maxRevisions) }, catalog);
    store.state.reviews.push(review);
    if (review.verdict === 'pass') return { brief: b, review };
    if (review.verdict === 'reject' || i === maxRevisions) throw new Error(`修正版がレビューを通りませんでした: ${review.issues.filter((x) => x.severity !== 'minor').map((x) => x.problem).join(' / ') || review.summary}`);
    b = keepOutOfScope(brief, { ...b, ...(await reviseBrief(llm, b, [human(note), ...review.issues], review.summary, catalog)), revision: b.revision + 1 }, scope);
    b.storyboard = b.format === 'image' ? [] : b.storyboard;
  }
  throw new Error('修正版がレビューを通りませんでした');
}

/**
 * 文言だけ変える広告に、元の広告の画像を引き継ぐ。選んだ元画像が残っていればそれを、
 * 消えていれば（配信後に素材を整理したもの）文字なしの背景（4:5）をコピーして使う。どちらも無ければ作り直す（空）。
 * コピー先は新しい広告の素材フォルダなので、元の広告の素材が整理されても消えない。
 */
function reuseImages(ctx: Ctx, from: Creative, toId: string): ImageJob[] {
  const dir = ctx.store.assetDir(toId);
  mkdirSync(dir, { recursive: true });
  const ratios = requiredRatios(from);
  const bg = join(ctx.store.assetDir(from.id), `${from.id}_4x5.bg.jpg`);
  const out: ImageJob[] = [];
  for (const ratio of ratios) {
    const j = from.imageJobs.find((x) => x.ratio === ratio);
    const src = j?.paths?.[j.selected ?? 0];
    // 文字なしの背景は 4:5 なので 4:5 にだけ使う（他の比率に使うと切り取られて人物や余白が欠ける）。無い比率だけ作り直す
    const source = src && existsSync(src) ? src : ratio === '4:5' && existsSync(bg) ? bg : null;
    if (!source) continue;
    const dest = join(dir, `${toId}_${ratio.replace(':', 'x').replace('.', '')}_src${extname(source) || '.jpg'}`);
    if (source !== dest) copyFileSync(source, dest);
    out.push({ ratio, provider: j?.provider ?? ctx.images.name, prompt: j?.prompt ?? '', requestedAt: j?.requestedAt ?? new Date().toISOString(), paths: [dest], selected: 0 });
  }
  return out;
}

const reviewSummary = (r: Review) => ({ score: r.score, scores: r.scores, ...(r.rubricVersion ? { rubricVersion: r.rubricVersion } : {}) });

async function onCreative(ctx: Ctx, f: FeedbackRequest): Promise<string> {
  const { store } = ctx;
  const c = store.state.creatives[f.targetId];
  if (!c) throw new Error(`広告 ${f.targetId} が見つかりません`);
  const brief = store.state.briefs[c.briefId];
  const note = (f.note ?? '').trim();
  const notes = (store.state.humanNotes ??= []);
  switch (f.action) {
    case 'approve': {
      if (c.status !== 'produced' && c.status !== 'qa_failed') throw new Error(`採用できるのは完成した広告だけです（今の状態: ${c.status}）`);
      // 最終チェックで落ちたものでも、人が見て良いと判断したら採用できる
      if (c.status === 'qa_failed') store.setStatus(c, 'produced', `人が採用（最終チェックの指摘: ${c.statusReason ?? ''}）`);
      c.humanApproved = { at: f.at, ...(note ? { note } : {}) };
      return '採用しました（次の入稿で入ります）';
    }
    case 'reject': {
      if (c.status === 'published') throw new Error('配信中の広告はここでは止められません（緊急停止か、媒体の管理画面で止めてください）');
      if (['rejected', 'retired', 'paused'].includes(c.status)) return 'すでに使わない広告です';
      store.setStatus(c, 'rejected', `人が却下${note ? `: ${note}` : ''}`);
      if (note) notes.push({ date: ctx.today, target: `広告「${brief?.overlay.main ?? c.id}」`, kind: 'reject', note });
      return '却下しました';
    }
    case 'revise':
    case 'variant': {
      if (!brief) throw new Error('この広告の企画が見つかりません');
      if (!note) throw new Error('修正の内容を書いてください');
      if (c.status === 'rejected' || c.status === 'failed') throw new Error(`却下・失敗した広告は直せません（今の状態: ${c.status}）。新しく作るか、別の広告に依頼してください`);
      const scope: Scope = f.action === 'variant' ? 'copy' : (f.scope ?? 'copy');
      const { brief: revised, review } = await reviseWithReview(ctx, brief, note, scope);
      notes.push({ date: ctx.today, target: `広告「${brief.overlay.main}」`, kind: 'revise', note });
      // 配信中の広告は書き換えず、修正版を別の広告として作る（文言違いも同じ）
      if (f.action === 'variant' || c.status === 'published' || c.status === 'paused' || c.status === 'retired') {
        const nb: CreativeBrief = { ...revised, id: newId('br'), revision: 0, createdAt: new Date().toISOString() };
        store.state.briefs[nb.id] = nb;
        const now = new Date().toISOString();
        const nc: Creative = {
          id: newId('cr'),
          briefId: nb.id,
          jobId: c.jobId,
          personaId: c.personaId,
          angle: c.angle,
          format: c.format,
          explore: c.explore,
          ...(c.hypothesisId ? { hypothesisId: c.hypothesisId } : {}),
          ...(c.layout ? { layout: c.layout } : {}),
          variantOf: c.id,
          review: reviewSummary(review),
          status: 'planned',
          // 同じ画像を使う（文言だけ変える）。画像も変える依頼なら作り直す
          imageJobs: [],
          assets: [],
          platformRefs: {},
          metrics: [],
          createdAt: now,
          updatedAt: now,
        };
        if (scope === 'copy') nc.imageJobs = reuseImages(ctx, c, nc.id);
        store.state.creatives[nc.id] = nc;
        return `${f.action === 'variant' ? '文言違い' : '修正版'}の広告 ${nc.id} を作りました（次の制作で画像に文字を載せ直します）`;
      }
      // まだ配信していない広告はその場で直す
      store.state.briefs[brief.id] = { ...revised, id: brief.id };
      c.review = reviewSummary(review);
      c.assets = [];
      delete c.qa;
      delete c.humanApproved;
      if (scope !== 'copy') {
        await Promise.all(c.imageJobs.map((j) => ctx.images.discard?.(`${c.id}_${j.ratio.replace(':', 'x').replace('.', '')}`)));
        c.imageJobs = [];
      } else if (!c.imageJobs.every((j) => j.paths?.length && existsSync(j.paths[j.selected ?? 0]))) {
        // 元の画像が消えていたら、残っている文字なしの背景を使う（無ければ作り直す）
        c.imageJobs = reuseImages(ctx, c, c.id);
      }
      store.setStatus(c, 'planned', `人の修正依頼を反映（${scope === 'copy' ? 'コピー' : scope === 'image' ? '画像' : 'コピーと画像'}）`);
      return `修正しました（${scope === 'copy' ? '同じ画像に文字を載せ直します' : '画像を作り直します'}）`;
    }
  }
}

async function onLp(ctx: Ctx, f: FeedbackRequest): Promise<string> {
  const lp = ctx.store.state.lps?.[f.targetId];
  if (!lp) throw new Error(`LP ${f.targetId} が見つかりません`);
  if (f.action === 'approve') return approveLp(ctx, lp.id);
  if (f.action === 'reject') return retireLp(ctx, lp.id);
  const note = (f.note ?? '').trim();
  if (!note) throw new Error('修正の内容を書いてください');
  const job = ctx.catalog.jobs.find((j) => j.id === lp.jobId);
  const persona = ctx.catalog.personas.find((p) => p.id === lp.personaId);
  if (!job?.active || !persona) throw new Error('この LP の求人またはペルソナがありません');
  const h = lp.hypothesisId ? ctx.catalog.hypotheses?.find((x) => x.id === lp.hypothesisId) : undefined;
  let copy = await writeLp(ctx.llm, job, persona, ctx.catalog, h, { copy: lp.copy, issues: [human(note)] });
  let issues = checkLpCopy(copy, job, ctx.catalog.brand).filter((i) => i.severity !== 'minor');
  if (issues.length) {
    copy = await writeLp(ctx.llm, job, persona, ctx.catalog, h, { copy, issues: [human(note), ...issues] });
    issues = checkLpCopy(copy, job, ctx.catalog.brand).filter((i) => i.severity !== 'minor');
  }
  if (issues.length) throw new Error(`修正版がチェックを通りませんでした: ${issues.map((i) => i.problem).join(' / ')}`);
  (ctx.store.state.humanNotes ??= []).push({ date: ctx.today, target: `LP「${lp.copy.heroTitle}」`, kind: 'revise', note });
  const id = `${job.id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'job'}-${newId('').slice(-6)}`;
  const now = new Date().toISOString();
  ctx.store.state.lps![id] = { id, jobId: lp.jobId, personaId: lp.personaId, ...(lp.hypothesisId ? { hypothesisId: lp.hypothesisId } : {}), status: 'draft', copy, issues: [], createdAt: now, createdOn: ctx.today };
  const dir = join(ctx.settings.dataDir, 'lp-drafts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.html`), renderLp(copy, job, ctx.catalog.brand, { slug: id, draft: true }));
  // 元が下書きなら取り下げる（公開中なら、新しい下書きを公開するまでそのまま）
  if (lp.status === 'draft') retireLp(ctx, lp.id, `修正版 ${id} に置き換え`);
  return `修正した下書き ${id} を作りました${lp.status === 'live' ? '（公開中の LP は、新しい下書きを公開するまでそのまま）' : ''}`;
}

async function onGoogle(ctx: Ctx, f: FeedbackRequest): Promise<string> {
  if (f.action !== 'revise') throw new Error('Google 検索広告のテキストは「修正」だけできます');
  const job = ctx.catalog.jobs.find((j) => j.id === f.targetId);
  if (!job) throw new Error(`求人 ${f.targetId} が見つかりません`);
  const note = (f.note ?? '').trim();
  if (!note) throw new Error('修正の内容を書いてください');
  const cur = ctx.store.state.googleTexts?.[job.id];
  const angles = (ctx.catalog.hypotheses ?? [])
    .filter((h) => h.active !== false && job.personas.includes(h.personaId) && (!h.jobIds?.length || h.jobIds.includes(job.id)))
    .map((h) => `${h.title}（${h.message}）`);
  const r = await writeRsa(ctx.llm, job, ctx.catalog, [], [], angles, cur ? { headlines: cur.headlines, descriptions: cur.descriptions, note } : { headlines: [], descriptions: [], note });
  (ctx.store.state.googleTexts ??= {})[job.id] = { createdOn: ctx.today, ...r };
  (ctx.store.state.humanNotes ??= []).push({ date: ctx.today, target: `検索広告（${job.title}）`, kind: 'revise', note });
  return `作り直しました（見出し ${r.headlines.length} 本・説明文 ${r.descriptions.length} 本${r.dropped.length ? `、チェックで ${r.dropped.length} 本を除外` : ''}）`;
}

/** まだ処理していない依頼を古い順に処理する。 */
export async function applyFeedback(ctx: Ctx): Promise<string> {
  const done = (ctx.store.state.feedbackDone ??= {});
  const todo = (ctx.catalog.feedback ?? []).filter((f) => f?.id && !done[f.id]).sort((a, b) => a.at.localeCompare(b.at));
  if (!todo.length) return '';
  let ok = 0;
  let ng = 0;
  for (const f of todo) {
    try {
      const result = f.target === 'creative' ? await onCreative(ctx, f) : f.target === 'lp' ? await onLp(ctx, f) : f.target === 'google' ? await onGoogle(ctx, f) : (() => { throw new Error('対象が不明です'); })();
      done[f.id] = { at: new Date().toISOString(), ok: true, result };
      ok++;
    } catch (e) {
      done[f.id] = { at: new Date().toISOString(), ok: false, result: (e as Error).message.slice(0, 300) };
      ng++;
      log.warn(`依頼 ${f.id} を処理できませんでした: ${(e as Error).message}`);
    }
    ctx.store.save();
  }
  // 処理済みの記録は、依頼ファイルから消えて90日たったら捨てる
  const live = new Set((ctx.catalog.feedback ?? []).map((f) => f.id));
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  for (const [id, d] of Object.entries(done)) if (!live.has(id) && d.at < cutoff) delete done[id];
  // 人の指摘は直近のものだけ残す（企画に渡すのは最新12件）
  if ((ctx.store.state.humanNotes?.length ?? 0) > 100) ctx.store.state.humanNotes = ctx.store.state.humanNotes!.slice(-100);
  return `管理画面からの依頼 ${ok} 件を処理${ng ? `（${ng} 件は処理できず。理由は管理画面に表示）` : ''}`;
}
