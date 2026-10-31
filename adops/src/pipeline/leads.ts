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
 * 無ければ（初回・キャッシュ切れ）時刻で区切った窓。さかのぼるのは最大24時間（それより古い位置なら直近24時間）。
 * hookSince は連携先（CRM）への送信が前回失敗していたときの、未送信分の開始位置（最大7日さかのぼる）。
 */
export function windowFromCursor(cursorPath: string | undefined, now = new Date()): { since: number; until: number; hookSince: number } {
  const fallback = leadWindow(now);
  let cur: { until?: unknown; hookPendingSince?: unknown } = {};
  try {
    if (cursorPath && existsSync(cursorPath)) cur = JSON.parse(readFileSync(cursorPath, 'utf8'));
  } catch {
    cur = {};
  }
  const prev = Number(cur.until);
  const until = Math.floor(now.getTime() / 1000) - 60;
  const base = prev < until ? { since: Math.max(prev, until - 24 * 3600), until } : fallback;
  // 連携先への未送信分は、位置が使えない場合でも引き継ぐ
  const pending = Number(cur.hookPendingSince);
  const hookSince = pending < base.since ? Math.max(pending, base.until - 7 * 86400) : base.since;
  if (pending < base.until - 7 * 86400) log.warn(`連携先への未送信の応募のうち7日より前の分は再送しません（Meta のリードセンターで確認してください）`);
  return { ...base, hookSince };
}

export async function notifyLeads(ctx: Ctx, now = new Date(), cursorPath?: string): Promise<string> {
  if (!ctx.meta) return 'Meta 未設定';
  const forms = [...new Set(ctx.catalog.jobs.flatMap((j) => allPlacements(j).flatMap((p) => (p.meta?.leadFormId ? [p.meta.leadFormId] : []))))];
  if (forms.length === 0) return 'インスタントフォーム未使用';
  const { since, until, hookSince } = windowFromCursor(cursorPath, now);
  const adToCreative = new Map<string, string>();
  for (const c of ctx.store.creatives()) for (const id of c.platformRefs.meta?.adIds ?? []) adToCreative.set(id, c.id);

  const lines: string[] = [];
  const forward: Record<string, unknown>[] = [];
  for (const formId of forms) {
    // API は「より後」の指定なので1秒手前から取り、範囲 [since, until) で絞る
    // 連携先への未送信分があれば、その分もさかのぼって取る（Slack には新しい分だけ）
    const leads = (await ctx.meta.leads(formId, hookSince - 1)).filter((l) => l.createdTime >= hookSince && l.createdTime < until);
    const job = ctx.catalog.jobs.find((j) => allPlacements(j).some((p) => p.meta?.leadFormId === formId));
    for (const l of leads.sort((a, b) => a.createdTime - b.createdTime)) {
      const c = l.adId ? ctx.store.state.creatives[adToCreative.get(l.adId) ?? ''] : undefined;
      if (l.createdTime >= since) {
        const when = new Date(l.createdTime * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        lines.push(`• ${when} ${maskName(l.fields)}｜${job?.title ?? formId}${c ? `｜広告: ${ANGLE_LABELS[c.angle]}「${ctx.store.state.briefs[c.briefId]?.overlay.main ?? ''}」` : ''}`);
      }
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
  // 失敗しても Slack 通知は止めない。未送信分の位置を残して次回さかのぼって再送する（受け手は leadId で重複を除く）
  const hook = (process.env.ADOPS_LEADS_WEBHOOK_URL ?? '').trim();
  let hookError: Error | null = null;
  if (hook && forward.length) await postLeads(hook, forward).catch((e: Error) => (hookError = e));
  if (lines.length) {
    const ok = await notifySlack(ctx.settings.slack.webhookUrl, {
      text: [
        `:inbox_tray: *新しい応募（インスタントフォーム）${lines.length} 件*`,
        ...lines.slice(0, 30),
        hook && !hookError ? '連絡先は連携先の CRM に送りました。' : '連絡先は Meta のリードセンター（または連携先の CRM）で確認してください。',
        ...(hookError ? [`:warning: 連携先（CRM）への送信に失敗しました。次回の実行で再送します: ${(hookError as Error).message}`] : []),
      ].join('\n'),
    });
    // 通知に失敗したら実行を失敗にして気づけるようにする（Actions の失敗通知）。位置は進めない
    if (!ok) throw new Error(`応募 ${lines.length} 件の Slack 通知に失敗しました。リードセンターで確認してください`);
  }
  if (cursorPath) writeFileSync(cursorPath, JSON.stringify(hookError ? { until, hookPendingSince: hookSince } : { until }));
  if (hookError) throw hookError;
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
