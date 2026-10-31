/**
 * 分析と手作業の入稿のための書き出し（data/exports/）。
 * - creatives.csv: 広告ごとの要素（仮説・訴求・モチーフ・色味など）× 採点 × 配信結果。どの要素が効いたか、採点が当たっているかを見る
 * - google-rsa.csv: Google 検索広告の見出し・説明文（Google 広告エディタの列名）。API で入稿しない場合も貼り付けて使える
 * Excel で文字化けしないよう UTF-8 の BOM を付ける。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.ts';
import { ANGLE_LABELS, FORMAT_LABEL, LANGUAGE_LABEL } from '../types.ts';
import { totals } from '../optimize/stats.ts';
import { writeRsa } from '../agents/searchWriter.ts';
import { daysBetween } from '../util/id.ts';
import { logger } from '../util/log.ts';

const log = logger('export');

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const MOTIF: Record<string, string> = { real_person: '実写の人物', illustration: 'イラスト', character: 'キャラクター', scene_only: '人物なしの情景', object: '物' };
const TASTE: Record<string, string> = { bright: '明るい', calm: '落ち着いた', energetic: '活気', warm: 'あたたかい', premium: '上質', documentary: 'ドキュメンタリー風' };
const TONE: Record<string, string> = { empathy: '共感', benefit: 'メリット直球', question: '問いかけ', number: '数字', urgency: '急ぎ', story: 'ストーリー' };

/** 広告ごとの要素 × 採点 × 配信結果の表。 */
export function creativeRows(ctx: Ctx): (string | number | null)[][] {
  const { store, catalog, today } = ctx;
  const cs = store.creatives().filter((c) => c.status !== 'rejected');
  const rubricIds = catalog.rubric?.items.map((i) => i.id) ?? [...new Set(cs.flatMap((c) => Object.keys(c.review?.scores ?? {})))];
  const label = (id: string) => catalog.rubric?.items.find((i) => i.id === id)?.label ?? id;
  const head = [
    '広告ID', '作成日', '状態', '求人', 'ペルソナ', '言語', '仮説ID', '仮説', '訴求軸', '形式', 'レイアウト', '探索枠',
    'モチーフ', '人物', '場所', '色味', 'テイスト', 'コピーの型', '画像の文字', '補足の文字', '見出し',
    '採点', '採点の版', ...rubricIds.map((id) => `採点:${label(id)}`),
    '配信日数', '表示', 'クリック', 'クリック率(%)', '費用(円)', '応募', '応募率(%)', '応募単価(円)', '面接',
  ];
  const rows = cs.map((c) => {
    const b = store.state.briefs[c.briefId];
    const e = b?.elements;
    const h = c.hypothesisId ? catalog.hypotheses?.find((x) => x.id === c.hypothesisId) : undefined;
    const t = totals(c.metrics);
    const days = c.publishedAt ? daysBetween(c.publishedAt.slice(0, 10), today) + 1 : 0;
    return [
      c.id, c.createdAt.slice(0, 10), c.status, catalog.jobs.find((j) => j.id === c.jobId)?.title ?? c.jobId,
      catalog.personas.find((p) => p.id === c.personaId)?.name ?? c.personaId,
      LANGUAGE_LABEL[b?.language ?? 'ja'] ?? b?.language ?? '', c.hypothesisId ?? '', h?.title ?? '',
      ANGLE_LABELS[c.angle], FORMAT_LABEL[c.format], c.layout ?? '', c.explore ? '探索' : '活用',
      e ? MOTIF[e.motif] ?? e.motif : '', e?.person ?? '', e?.setting ?? '', e?.palette ?? '', e ? TASTE[e.taste] ?? e.taste : '', e ? TONE[e.copyTone] ?? e.copyTone : '',
      b?.overlay.main ?? '', b?.overlay.sub ?? '', b?.headline ?? '',
      c.review?.score ?? '', c.review?.rubricVersion ?? '', ...rubricIds.map((id) => c.review?.scores[id] ?? ''),
      days, t.impressions, t.clicks, t.impressions ? Number(t.ctr.toFixed(2)) : '', Math.round(t.spend), t.conversions,
      t.clicks ? Number(t.cvr.toFixed(2)) : '', t.cpa === null ? '' : Math.round(t.cpa), c.funnel?.interview ?? '',
    ];
  });
  return [head, ...rows];
}

/**
 * 稼働中の求人ごとに Google 検索広告のテキスト案を用意する（30日ごとに作り直す）。
 * 仮説の打ち出しを見出しに取り入れ、文字数と法令チェックに通ったものだけ残す。
 */
export async function ensureGoogleTexts(ctx: Ctx, maxAgeDays = 30): Promise<number> {
  const texts = (ctx.store.state.googleTexts ??= {});
  let made = 0;
  for (const job of ctx.catalog.jobs.filter((j) => j.active)) {
    const cur = texts[job.id];
    if (cur && daysBetween(cur.createdOn, ctx.today) < maxAgeDays) continue;
    const angles = (ctx.catalog.hypotheses ?? [])
      .filter((h) => h.active !== false && job.personas.includes(h.personaId) && (!h.jobIds?.length || h.jobIds.includes(job.id)))
      .map((h) => `${h.title}（${h.message}）`);
    try {
      const r = await writeRsa(ctx.llm, job, ctx.catalog, cur?.headlines ?? [], [], angles);
      texts[job.id] = { createdOn: ctx.today, ...r };
      made++;
    } catch (e) {
      log.warn(`${job.id}: 検索広告のテキスト作成に失敗: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return made;
}

/** Google 広告エディタの列名（キャンペーン・広告グループ名は入稿先に合わせて人が埋める）。 */
export function googleRows(ctx: Ctx): string[][] {
  const head = ['Campaign', 'Ad group', 'Ad type', ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`), 'Path 1', 'Path 2', 'Final URL', '求人ID', '作成日'];
  const rows: string[][] = [];
  for (const job of ctx.catalog.jobs.filter((j) => j.active)) {
    const t = ctx.store.state.googleTexts?.[job.id];
    if (!t) continue;
    const pad = (xs: string[], n: number) => Array.from({ length: n }, (_, i) => xs[i] ?? '');
    rows.push(['', '', 'Responsive search ad', ...pad(t.headlines, 15), ...pad(t.descriptions, 4), t.path1, t.path2, job.landingUrl, job.id, t.createdOn]);
  }
  return [head, ...rows];
}

export async function exportAll(ctx: Ctx, opts: { googleText?: boolean } = {}): Promise<string> {
  const dir = join(ctx.settings.dataDir, 'exports');
  mkdirSync(dir, { recursive: true });
  const cr = creativeRows(ctx);
  writeFileSync(join(dir, 'creatives.csv'), toCsv(cr));
  const made = opts.googleText === false ? 0 : await ensureGoogleTexts(ctx);
  const gr = googleRows(ctx);
  writeFileSync(join(dir, 'google-rsa.csv'), toCsv(gr));
  return `書き出し: 広告 ${cr.length - 1} 本（exports/creatives.csv）・検索広告テキスト ${gr.length - 1} 求人${made ? `（${made} 求人を新しく作成）` : ''}（exports/google-rsa.csv）`;
}
