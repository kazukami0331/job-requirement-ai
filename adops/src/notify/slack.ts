/** Slack 通知（Incoming Webhook）。未設定なら標準出力に出すだけ。 */
import { request } from '../util/http.ts';
import { logger } from '../util/log.ts';

const log = logger('slack');

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

/** 送れたら true。失敗してもサイクル全体は止めない（呼び出し側で必要なら扱う）。 */
export async function notifySlack(webhookUrl: string, msg: SlackMessage): Promise<boolean> {
  if (!webhookUrl) {
    log.info(`(Slack 未設定のため出力のみ)\n${msg.text}`);
    return true;
  }
  try {
    await request(webhookUrl, { method: 'POST', json: msg, attempts: 3 });
    return true;
  } catch (e) {
    log.warn(`Slack 通知に失敗: ${(e as Error).message}`);
    return false;
  }
}

/** mrkdwn のセクションを作る（Slack の1ブロック3000字制限に合わせて分割）。 */
export function sections(markdown: string): unknown[] {
  const out: unknown[] = [];
  let buf = '';
  for (const line of markdown.split('\n')) {
    if ((buf + line).length > 2800) {
      out.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
      buf = '';
    }
    buf += `${line}\n`;
  }
  if (buf.trim()) out.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
  return out;
}
