/**
 * 選考結果（応募 → 面接 → 内定 → 入社）の取り込み。
 *
 * 広告のリンクには utm_content=<企画ID> を付けているので、応募管理（ATS）やスプレッドシートに
 * その値を残しておけば、どの広告から何人が入社したかを突き合わせられる。
 * 「応募単価」ではなく「入社につながる広告」を学習させるための仕組み。
 *
 * 入力: CSV（ヘッダ行あり）。列名は次のいずれか（大文字小文字・前後空白は無視）
 *   utm_content | 企画ID       … 広告の企画ID（br_...）
 *   stage | ステータス | 選考段階 … 応募 / 面接 / 内定 / 入社（英語 applied / interview / offer / hired も可）
 *   date | 日付（任意）
 * 1行 = 1人の到達段階。同じ人が複数行あっても、最も進んだ段階だけ数えたい場合は candidate_id | 応募者ID 列を入れる。
 *
 * Google スプレッドシートなら「ウェブに公開 → CSV」の URL を ADOPS_OUTCOMES_CSV_URL に設定する。
 */
import { readFileSync, existsSync } from 'node:fs';
import type { Ctx } from './context.ts';
import { request } from '../util/http.ts';
import { logger } from '../util/log.ts';

const log = logger('outcomes');

export type Stage = 'applied' | 'interview' | 'offer' | 'hired';
const STAGE_ORDER: Stage[] = ['applied', 'interview', 'offer', 'hired'];
const STAGE_ALIASES: Record<string, Stage> = {
  応募: 'applied',
  applied: 'applied',
  application: 'applied',
  面接: 'interview',
  面接設定: 'interview',
  面接済: 'interview',
  interview: 'interview',
  内定: 'offer',
  offer: 'offer',
  入社: 'hired',
  入社済: 'hired',
  採用: 'hired',
  hired: 'hired',
};

export interface Funnel {
  applied: number;
  interview: number;
  offer: number;
  hired: number;
  updatedAt: string;
}

/** 引用符・カンマ入りのセルに対応した最小限の CSV パーサ。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** CSV を企画IDごとのファネルに集計する。後の段階に進んだ人は前の段階にも数える（入社者は応募者でもある）。 */
export function aggregateOutcomes(csv: string): { byBrief: Map<string, Omit<Funnel, 'updatedAt'>>; skipped: number } {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return { byBrief: new Map(), skipped: 0 };
  const h = header.map((x) => x.trim().toLowerCase());
  const col = (...names: string[]) => h.findIndex((x) => names.includes(x));
  const iBrief = col('utm_content', '企画id');
  const iStage = col('stage', 'ステータス', '選考段階');
  const iCand = col('candidate_id', '応募者id');
  if (iBrief < 0 || iStage < 0) throw new Error('選考結果 CSV に utm_content（企画ID）と stage（選考段階）の列が必要です');

  // 応募者ごとに最も進んだ段階だけを使う（ID 列が無ければ行ごと）
  const best = new Map<string, { brief: string; stage: Stage }>();
  let skipped = 0;
  rows.forEach((r, idx) => {
    const brief = (r[iBrief] ?? '').trim();
    const stage = STAGE_ALIASES[(r[iStage] ?? '').trim().toLowerCase()] ?? STAGE_ALIASES[(r[iStage] ?? '').trim()];
    if (!brief.startsWith('br_') || !stage) {
      skipped++;
      return;
    }
    const key = iCand >= 0 && r[iCand]?.trim() ? `${brief}|${r[iCand].trim()}` : `row${idx}`;
    const prev = best.get(key);
    if (!prev || STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(prev.stage)) best.set(key, { brief, stage });
  });

  const byBrief = new Map<string, Omit<Funnel, 'updatedAt'>>();
  for (const { brief, stage } of best.values()) {
    const f = byBrief.get(brief) ?? { applied: 0, interview: 0, offer: 0, hired: 0 };
    for (const s of STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1)) f[s]++;
    byBrief.set(brief, f);
  }
  return { byBrief, skipped };
}

export async function importOutcomes(ctx: Ctx): Promise<string> {
  const src = (process.env.ADOPS_OUTCOMES_CSV_URL ?? '').trim();
  if (!src) return '選考結果の取り込み先が未設定（ADOPS_OUTCOMES_CSV_URL）';
  const text = src.startsWith('http') ? await (await request(src)).text() : existsSync(src) ? readFileSync(src, 'utf8') : '';
  if (!text) return `選考結果 CSV を読めませんでした: ${src}`;
  const { byBrief, skipped } = aggregateOutcomes(text);
  let matched = 0;
  const now = new Date().toISOString();
  for (const c of ctx.store.creatives()) {
    const f = byBrief.get(c.briefId);
    if (!f) continue;
    c.funnel = { ...f, updatedAt: now };
    matched++;
  }
  const hires = [...byBrief.values()].reduce((a, f) => a + f.hired, 0);
  const note = `選考結果 ${byBrief.size} 企画分（入社 ${hires} 人）を ${matched} 本に反映${skipped ? ` / 読み飛ばし ${skipped} 行` : ''}`;
  log.info(note);
  return note;
}
