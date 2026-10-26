/**
 * インスタントフォーム（Meta リード獲得広告）に届いた応募を Slack に即知らせる。
 * 個人情報は Slack にも状態ファイルにも残さない（イニシャルと求人名だけ）。詳細は Meta のリードセンター/CRM で確認する。
 */
import type { Ctx } from './context.ts';
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

export async function notifyLeads(ctx: Ctx): Promise<string> {
  if (!ctx.meta) return 'Meta 未設定';
  const forms = [...new Set(ctx.catalog.jobs.flatMap((j) => (j.placements.meta?.leadFormId ? [j.placements.meta.leadFormId] : [])))];
  if (forms.length === 0) return 'インスタントフォーム未使用';
  const cursor = (ctx.store.state.leadCursor ??= {});
  const adToCreative = new Map<string, string>();
  for (const c of ctx.store.creatives()) for (const id of c.platformRefs.meta?.adIds ?? []) adToCreative.set(id, c.id);

  let total = 0;
  const lines: string[] = [];
  for (const formId of forms) {
    // 初回は直近24時間だけ（過去分を大量に通知しない）
    const since = cursor[formId] ?? Math.floor(Date.now() / 1000) - 86_400;
    const leads = await ctx.meta.leads(formId, since);
    const job = ctx.catalog.jobs.find((j) => j.placements.meta?.leadFormId === formId);
    for (const l of leads.sort((a, b) => a.createdTime - b.createdTime)) {
      const c = l.adId ? ctx.store.state.creatives[adToCreative.get(l.adId) ?? ''] : undefined;
      const when = new Date(l.createdTime * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      lines.push(`• ${when} ${maskName(l.fields)}｜${job?.title ?? formId}${c ? `｜広告: ${ANGLE_LABELS[c.angle]}「${ctx.store.state.briefs[c.briefId]?.overlay.main ?? ''}」` : ''}`);
      cursor[formId] = Math.max(cursor[formId] ?? 0, l.createdTime);
      total++;
    }
  }
  if (total) {
    await notifySlack(ctx.settings.slack.webhookUrl, {
      text: [`:inbox_tray: *新しい応募（インスタントフォーム）${total} 件*`, ...lines.slice(0, 30), '連絡先は Meta のリードセンター（または連携先の CRM）で確認してください。'].join('\n'),
    });
  }
  ctx.store.save();
  log.info(`リード ${total} 件`);
  return `新しい応募 ${total} 件`;
}
