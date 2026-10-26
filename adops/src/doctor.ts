/**
 * 接続テスト（node src/cli.ts check --live）。
 * 各サービスに読み取りだけの呼び出しをして、キー・ID・権限・入稿先の設定が正しいかを確かめる。
 * 何も作成・変更しない（Claude はモデル情報の取得だけなので課金されない）。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Catalog, Settings } from './config.ts';
import { isGoogleConfigured, isMetaConfigured } from './config.ts';
import { MetaClient } from './platforms/meta.ts';
import { GoogleAdsClient } from './platforms/google.ts';
import { DriveInbox } from './creative/inbox.ts';
import { requestJson } from './util/http.ts';

export interface CheckResult {
  name: string;
  ok: boolean | null; // null = 未設定でスキップ
  detail: string;
}

async function attempt(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

export async function liveChecks(s: Settings, catalog: Catalog): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  if (s.anthropic.apiKey) {
    out.push(
      await attempt('Claude', async () => {
        const client = new Anthropic({ apiKey: s.anthropic.apiKey });
        const models = [s.anthropic.model, s.anthropic.fastModel];
        for (const m of models) await client.models.retrieve(m);
        return `モデル ${models.join(' / ')} を利用可能`;
      }),
    );
  } else out.push({ name: 'Claude', ok: null, detail: 'ANTHROPIC_API_KEY 未設定（オフラインで動作）' });

  if (isMetaConfigured(s)) {
    const meta = new MetaClient(s.meta);
    out.push(
      await attempt('Meta 広告アカウント', async () => {
        const qs = new URLSearchParams({ access_token: s.meta.accessToken, fields: 'name,account_status,currency,timezone_name' });
        const r = await requestJson<{ name: string; account_status: number; currency: string; timezone_name: string }>(
          `https://graph.facebook.com/${s.meta.apiVersion}/act_${s.meta.adAccountId}?${qs}`,
        );
        if (r.account_status !== 1) throw new Error(`アカウントが有効ではありません（account_status=${r.account_status}）`);
        if (r.currency !== 'JPY') return `${r.name}（通貨 ${r.currency}: 予算の金額単位に注意）`;
        return `${r.name}（${r.currency} / ${r.timezone_name}）`;
      }),
    );
    for (const job of catalog.jobs.filter((j) => j.active)) {
      for (const id of job.placements.meta?.adsetIds ?? []) {
        out.push(
          await attempt(`Meta 広告セット ${id}（${job.id}）`, async () => {
            const a = await meta.getAdset(id);
            return `状態 ${a.status} / 日予算 ${a.dailyBudget === null ? 'キャンペーン予算' : `${a.dailyBudget.toLocaleString()}円`}`;
          }),
        );
      }
    }
    if (s.meta.instagramUserId) {
      out.push(
        await attempt('Instagram アカウント', async () => {
          const qs = new URLSearchParams({ access_token: s.meta.accessToken, fields: 'username,followers_count' });
          const r = await requestJson<{ username: string; followers_count: number }>(`https://graph.facebook.com/${s.meta.apiVersion}/${s.meta.instagramUserId}?${qs}`);
          return `@${r.username}（フォロワー ${r.followers_count?.toLocaleString() ?? '-'}）`;
        }),
      );
    }
  } else out.push({ name: 'Meta', ok: null, detail: '未設定' });

  if (isGoogleConfigured(s)) {
    const g = new GoogleAdsClient(s.google);
    out.push(
      await attempt('Google 広告アカウント', async () => {
        const [r] = await g.search<any>('SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
        return `${r.customer.descriptiveName}（${r.customer.currencyCode} / ${r.customer.timeZone}）`;
      }),
    );
    const adGroups = catalog.jobs.filter((j) => j.active).flatMap((j) => (j.placements.google?.adGroupIds ?? []).map((id) => ({ id, job: j.id })));
    if (adGroups.length) {
      out.push(
        await attempt('Google 広告グループ', async () => {
          const rows = await g.search<any>(
            `SELECT ad_group.id, ad_group.status, campaign.advertising_channel_type FROM ad_group WHERE ad_group.id IN (${adGroups.map((a) => a.id).join(',')})`,
          );
          const found = new Map(rows.map((r) => [String(r.adGroup.id), r]));
          const missing = adGroups.filter((a) => !found.has(a.id));
          if (missing.length) throw new Error(`見つからない広告グループ: ${missing.map((m) => `${m.id}（${m.job}）`).join(', ')}`);
          const notDg = rows.filter((r) => r.campaign.advertisingChannelType !== 'DEMAND_GEN');
          if (notDg.length) throw new Error(`デマンド ジェネレーション以外のキャンペーンです: ${notDg.map((r) => r.adGroup.id).join(', ')}`);
          return `${rows.length} 件 OK`;
        }),
      );
      if (!process.env.GOOGLE_ADS_LOGO_ASSET || !process.env.GOOGLE_ADS_BUSINESS_NAME)
        out.push({ name: 'Google ロゴ・社名', ok: false, detail: 'デマンド ジェネレーション広告に GOOGLE_ADS_LOGO_ASSET と GOOGLE_ADS_BUSINESS_NAME が必要です' });
    }
  } else out.push({ name: 'Google 広告', ok: null, detail: '未設定' });

  if (s.image.provider === 'handoff' && s.image.inbox === 'drive') {
    out.push(
      await attempt('Google ドライブ inbox', async () => {
        const inbox = new DriveInbox(s.image.drive.serviceAccountJson, s.image.drive.folderId);
        await inbox.fetch('__adops_check__');
        return `フォルダ ${s.image.drive.folderId} を参照可能`;
      }),
    );
  }
  if (s.image.provider === 'midjourney') {
    out.push({ name: 'Midjourney 中継 API', ok: s.image.midjourney.apiKey ? true : false, detail: s.image.midjourney.apiKey ? `${s.image.midjourney.baseUrl}（規約上のリスクに注意）` : 'MJ_API_KEY 未設定' });
  }

  return out;
}
