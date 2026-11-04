/**
 * 認証情報の期限切れを事前に知らせる。Meta のユーザーのアクセストークンは約60日で切れ、
 * 切れると実績の取り込みも広告の停止もできなくなる（自動運用が気づかないうちに止まる）ので、14日前から毎日知らせる。
 */
import type { Ctx } from './context.ts';
import { logger } from '../util/log.ts';

const log = logger('credentials');
const WARN_DAYS = 14;

export async function checkCredentials(ctx: Ctx, now = Date.now()): Promise<string> {
  // 1日1回で十分（日中の実行では確認しない）
  if (ctx.store.state.credentials?.checkedOn === ctx.today) return '';
  const alerts: string[] = [];
  if (ctx.meta) {
    try {
      const t = await ctx.meta.tokenExpiry();
      if (!t.valid) alerts.push('Meta のアクセストークンが無効です。取り直して META_ACCESS_TOKEN を更新してください');
      else if (t.expiresAt !== null) {
        const days = Math.floor((t.expiresAt * 1000 - now) / 86_400_000);
        if (days < WARN_DAYS) {
          alerts.push(
            `Meta のアクセストークンがあと ${Math.max(0, days)} 日で切れます。システムユーザーの無期限トークンに切り替えるか、取り直して META_ACCESS_TOKEN を更新してください`,
          );
        }
      }
    } catch (e) {
      // 確認できないだけでは止めない（他の取得で失敗していれば別に分かる）
      log.warn(`Meta のトークン確認に失敗: ${(e as Error).message.slice(0, 200)}`);
      return '';
    }
  }
  ctx.store.state.credentials = { checkedOn: ctx.today, alerts };
  return alerts.join(' / ');
}
