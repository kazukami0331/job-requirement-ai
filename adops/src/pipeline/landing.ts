/**
 * 応募ページ（landingUrl）の死活監視。リンク切れ・募集終了のページに広告費を払い続けないよう、
 * 1日数回ページを取りに行き、壊れていたら Slack に知らせて、その求人の新規入稿を止める。
 *
 * 配信中の広告は自動では止めない（一時的な障害や、Actions からのアクセスだけ弾かれている誤検知がありうるため）。
 * 401 / 403 / 429 やタイムアウトは「判定不能」として扱い、入稿は止めない。
 */
import type { Ctx } from './context.ts';
import { placeholderProblems } from '../config.ts';
import { notifySlack } from '../notify/slack.ts';
import { logger } from '../util/log.ts';

const log = logger('landing');

export interface PageResult {
  /** HTTP ステータス。接続できなかったときは 0 */
  status: number;
  body: string;
  /** 接続できなかった理由（DNS 解決できない等） */
  error?: string;
  /** タイムアウト等、判定できない失敗 */
  transient?: boolean;
}

export type CheckPage = (url: string) => Promise<PageResult>;

export interface LandingHealth {
  /** true: 正常 / false: 壊れている（入稿を止める）/ null: 判定不能 */
  ok: boolean | null;
  status: number;
  note: string;
  checkedAt: string;
  /** 壊れた状態が始まった日時 */
  since?: string;
  /** 一時的かもしれない異常（接続不可・5xx）が続いた回数 */
  failCount?: number;
}

/** 募集が終わったことを示す文言（ページ全体に出るような、はっきりした言い回しだけ） */
const CLOSED =
  /(この求人|本求人|こちらの求人|当求人|この募集|本募集|このお仕事)(は|の)(既に|すでに)?((募集|掲載|受付|応募)(は|が|を)?)?(終了しました|終了いたしました|締め切りました|締切りました|締め切らせていただきました)/;

/** transient: 一時的な障害かもしれない異常（接続できない・5xx）。2回続いたときだけ異常とみなす */
export function classifyPage(r: PageResult): { ok: boolean | null; note: string; transient?: boolean } {
  if (r.status === 0) return r.transient ? { ok: null, note: `判定不能（${r.error ?? '接続失敗'}）` } : { ok: false, note: `つながらない（${r.error ?? '接続失敗'}）`, transient: true };
  if ([401, 403, 429].includes(r.status)) return { ok: null, note: `判定不能（HTTP ${r.status}。自動アクセスが弾かれている可能性）` };
  if (r.status >= 500) return { ok: false, note: `HTTP ${r.status}`, transient: true };
  if (r.status >= 400) return { ok: false, note: `HTTP ${r.status}` };
  const text = r.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '');
  const m = text.match(CLOSED);
  if (m) return { ok: false, note: `募集終了の表示あり（「${m[0]}」）` };
  return { ok: true, note: `HTTP ${r.status}` };
}

/** 実際にページを取りに行く（リダイレクトは追う。本文は先頭 300KB まで）。 */
export const fetchPage: CheckPage = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; adops-lp-check/1.0)', accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = res.ok ? (await res.text()).slice(0, 300_000) : '';
    return { status: res.status, body };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ?? err.name;
    // 名前解決できない・接続拒否・証明書エラーは「壊れている」。タイムアウトなどは判定不能
    const permanent = ['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code);
    return { status: 0, body: '', error: code, transient: !permanent };
  }
};

/** 入稿を止めるべき求人か（直近の確認で壊れていた）。 */
export function landingBroken(ctx: Ctx, jobId: string): LandingHealth | undefined {
  const h = ctx.store.state.landing?.[jobId];
  return h?.ok === false ? h : undefined;
}

export async function checkLandingPages(ctx: Ctx): Promise<string> {
  if (!ctx.checkPage) return '応募ページの確認は無効';
  const state = ctx.store.state;
  const health = (state.landing ??= {});
  const now = new Date().toISOString();
  const jobs = ctx.catalog.jobs.filter((j) => j.active && placeholderProblems(ctx.catalog, j.id).length === 0);
  // 同じ URL は1回だけ取りに行く
  const byUrl = new Map<string, Promise<PageResult>>();
  const broke: string[] = [];
  const recovered: string[] = [];
  let ok = 0;
  let unknown = 0;
  for (const j of jobs) {
    let p = byUrl.get(j.landingUrl);
    if (!p) byUrl.set(j.landingUrl, (p = ctx.checkPage(j.landingUrl)));
    const c = classifyPage(await p);
    const prev = health[j.id];
    if (c.ok === null) {
      unknown++;
      // 判定不能のときは前回の判定を引き継ぐ（確認日時と理由だけ更新）
      health[j.id] = { ...(prev ?? { ok: null, status: 0 }), note: c.note, checkedAt: now };
      continue;
    }
    if (c.ok) {
      ok++;
      if (prev?.ok === false) recovered.push(`• ${j.title}（${j.id}）`);
      health[j.id] = { ok: true, status: (await p).status, note: c.note, checkedAt: now };
    } else if (c.transient && (prev?.failCount ?? 0) < 1 && prev?.ok !== false) {
      // 一時的な障害かもしれないので、1回目は判定を保留して次の確認を待つ
      unknown++;
      health[j.id] = { ...(prev ?? { ok: null, status: 0 }), note: `${c.note}（1回目。次の確認でも同じなら異常とみなす）`, checkedAt: now, failCount: 1 };
    } else {
      if (prev?.ok !== false) broke.push(`• ${j.title}（${j.id}）: ${c.note}\n   ${j.landingUrl}`);
      health[j.id] = { ok: false, status: (await p).status, note: c.note, checkedAt: now, since: prev?.ok === false ? prev.since : now, failCount: (prev?.failCount ?? 0) + 1 };
    }
  }
  // 求人一覧から消えた・停止した求人の記録は消す
  for (const id of Object.keys(health)) if (!jobs.some((j) => j.id === id)) delete health[id];

  if (broke.length) {
    log.warn(`応募ページの異常 ${broke.length} 件`);
    await notifySlack(ctx.settings.slack.webhookUrl, {
      text: [
        `:rotating_light: *応募ページに問題があります（${broke.length} 件）*`,
        ...broke,
        'この求人の新しい広告の入稿を止めました。配信中の広告は止めていないので、ページを直すか、求人を停止（jobs.json の active: false）してください。',
      ].join('\n'),
    });
  }
  if (recovered.length) {
    await notifySlack(ctx.settings.slack.webhookUrl, { text: [':white_check_mark: *応募ページが復旧しました*', ...recovered, '入稿を再開します。'].join('\n') });
  }
  const bad = Object.values(health).filter((h) => h.ok === false).length;
  return `応募ページ 正常 ${ok} / 異常 ${bad} / 判定不能 ${unknown}`;
}
