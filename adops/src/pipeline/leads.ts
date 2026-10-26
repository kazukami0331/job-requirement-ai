/**
 * インスタントフォーム（Meta リード獲得広告）に届いた応募を Slack に即知らせる。
 * 個人情報は Slack にも状態ファイルにも残さない（イニシャルと求人名だけ）。詳細は Meta のリードセンター/CRM で確認する。
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Ctx } from './context.ts';
import { allPlacements } from '../config.ts';
import { notifySlack } from '../notify/slack.ts';
import { ANGLE_LABELS } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('leads');

/** 氏名をイニシャルにする（「山田 太郎」→「山…様」）。 */
export function maskName(fields: Record<string, string>): string {
  const name = fields.full_name ?? fields['氏名'] ?? fields.first_name ?? fields.last_name ?? '';
  const first = [...name.trim()][0];
  return first ? `${first}…様` : '（氏名なし）';
}

/**
 * 通知する時間帯。状態ファイルに位置を持たず（毎時の実行と日次の実行が状態を上書きし合わないように）、
 * 毎時 :30 で区切った直前1時間を対象にする。朝いちばん（9:30）の実行は夜間の分（21:30〜）もまとめて送る。
 */
export function leadWindow(now = new Date()): { since: number; until: number } {
  const t = Math.floor(now.getTime() / 1000);
  const hour = 3600;
  // 直近の「xx:30」（UTC と日本時間は分がずれないのでどちらでも同じ）
  const until = Math.floor((t - 1800) / hour) * hour + 1800;
  const jstHour = new Date((until + 9 * hour) * 1000).getUTCHours();
  const since = jstHour === 9 ? until - 12 * hour : until - hour;
  return { since, until };
}

/**
 * 前回どこまで通知したか（cursorPath）があれば、そこから今までを対象にする（実行の遅延・失敗で取りこぼさない）。
 * 無ければ（初回・キャッシュ切れ）時刻で区切った窓。さかのぼるのは最大24時間。
 */
export function windowFromCursor(cursorPath: string | undefined, now = new Date()): { since: number; until: number } {
  const fallback = leadWindow(now);
  if (!cursorPath || !existsSync(cursorPath)) return fallback;
  try {
    const prev = Number(JSON.parse(readFileSync(cursorPath, 'utf8')).until);
    const until = Math.floor(now.getTime() / 1000) - 60;
    if (!(prev > until - 24 * 3600) || prev >= until) return fallback;
    return { since: prev, until };
  } catch {
    return fallback;
  }
}

export async function notifyLeads(ctx: Ctx, now = new Date(), cursorPath?: string): Promise<string> {
  if (!ctx.meta) return 'Meta 未設定';
  const forms = [...new Set(ctx.catalog.jobs.flatMap((j) => allPlacements(j).flatMap((p) => (p.meta?.leadFormId ? [p.meta.leadFormId] : []))))];
  if (forms.length === 0) return 'インスタントフォーム未使用';
  const { since, until } = windowFromCursor(cursorPath, now);
  const adToCreative = new Map<string, string>();
  for (const c of ctx.store.creatives()) for (const id of c.platformRefs.meta?.adIds ?? []) adToCreative.set(id, c.id);

  const lines: string[] = [];
  const forward: Record<string, unknown>[] = [];
  for (const formId of forms) {
    // API は「より後」の指定なので1秒手前から取り、範囲 [since, until) で絞る
    const leads = (await ctx.meta.leads(formId, since - 1)).filter((l) => l.createdTime >= since && l.createdTime < until);
    const job = ctx.catalog.jobs.find((j) => allPlacements(j).some((p) => p.meta?.leadFormId === formId));
    for (const l of leads.sort((a, b) => a.createdTime - b.createdTime)) {
      const c = l.adId ? ctx.store.state.creatives[adToCreative.get(l.adId) ?? ''] : undefined;
      const when = new Date(l.createdTime * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      lines.push(`• ${when} ${maskName(l.fields)}｜${job?.title ?? formId}${c ? `｜広告: ${ANGLE_LABELS[c.angle]}「${ctx.store.state.briefs[c.briefId]?.overlay.main ?? ''}」` : ''}`);
      forward.push({
        leadId: l.id,
        createdAt: new Date(l.createdTime * 1000).toISOString(),
        formId,
        jobId: job?.id ?? null,
        jobTitle: job?.title ?? null,
        adId: l.adId ?? null,
        creativeId: c?.id ?? null,
        angle: c?.angle ?? null,
        fields: l.fields,
      });
    }
  }
  // 連携先（自社の CRM・ATS など）に応募者情報を送る。個人情報はここにだけ送り、adops には残さない。
  // Slack より先に送り、失敗したら位置を進めずに失敗させる（次回また送る。受け手は leadId で重複を除く）
  const hook = (process.env.ADOPS_LEADS_WEBHOOK_URL ?? '').trim();
  if (hook && forward.length) await postLeads(hook, forward);
  if (lines.length) {
    const ok = await notifySlack(ctx.settings.slack.webhookUrl, {
      text: [
        `:inbox_tray: *新しい応募（インスタントフォーム）${lines.length} 件*`,
        ...lines.slice(0, 30),
        hook ? '連絡先は連携先の CRM に送りました。' : '連絡先は Meta のリードセンター（または連携先の CRM）で確認してください。',
      ].join('\n'),
    });
    // 通知に失敗したら実行を失敗にして気づけるようにする（Actions の失敗通知）
    if (!ok) throw new Error(`応募 ${lines.length} 件の Slack 通知に失敗しました。リードセンターで確認してください`);
  }
  if (cursorPath) writeFileSync(cursorPath, JSON.stringify({ until }));
  log.info(`リード ${lines.length} 件（${new Date(since * 1000).toISOString()}〜）`);
  return `新しい応募 ${lines.length} 件`;
}

/** 応募者情報を連携先に送る（HMAC-SHA256 の署名つき。ヘッダ x-adops-signature: sha256=<hex>）。 */
export async function postLeads(url: string, leads: Record<string, unknown>[]): Promise<void> {
  const body = JSON.stringify({ leads });
  const secret = process.env.ADOPS_LEADS_WEBHOOK_SECRET ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-adops-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`応募者情報の連携先への送信に失敗しました（HTTP ${res.status}）。次回の実行で再送します`);
}
