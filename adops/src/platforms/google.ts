/**
 * Google 広告 API（REST）。
 *
 * - デマンド ジェネレーション（YouTube ショート / Discover / Gmail）: 広告グループに「広告」を1本ずつ追加する。
 *   広告単位で実績が取れるので、AI の学習（訴求軸ごとの勝ち負け）にはこちらを主に使う。
 * - P-MAX: アセットグループに画像・見出し・動画アセットを追加する（アセット単位の応募数は取れないため学習には使わない）。
 *
 * 動画は YouTube にアップロード（限定公開）してから広告に使う（youtube.ts）。
 */
import { readFileSync } from 'node:fs';
import type { Settings } from '../config.ts';
import type { Asset, Creative, CreativeBrief, DailyMetric, Job } from '../types.ts';
import { googleWidth } from '../compliance/rules.ts';
import { HttpError, requestJson } from '../util/http.ts';
import { logger } from '../util/log.ts';
import { withUtm } from './meta.ts';

const log = logger('google');

export class GoogleAdsClient {
  private s: Settings['google'];
  private token: { value: string; exp: number } | null = null;

  constructor(s: Settings['google']) {
    this.s = s;
  }

  get customer(): string {
    return `customers/${this.s.customerId}`;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const r = await requestJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.s.clientId,
        client_secret: this.s.clientSecret,
        refresh_token: this.s.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return r.access_token;
  }

  private async call<T = any>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      'developer-token': this.s.developerToken,
    };
    if (this.s.loginCustomerId) headers['login-customer-id'] = this.s.loginCustomerId;
    try {
      return await requestJson<T>(`https://googleads.googleapis.com/${this.s.apiVersion}/${path}`, { method: 'POST', headers, json: body });
    } catch (e) {
      if (e instanceof HttpError) throw new Error(`Google Ads ${path}: ${googleErrorMessage(e.body)}`);
      throw e;
    }
  }

  async search<T = any>(query: string): Promise<T[]> {
    const rows: T[] = [];
    let pageToken: string | undefined;
    do {
      const r: any = await this.call(`${this.customer}/googleAds:search`, { query, pageToken });
      rows.push(...(r.results ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return rows;
  }

  async createImageAsset(path: string, name: string): Promise<string> {
    const r = await this.call<{ results: { resourceName: string }[] }>(`${this.customer}/assets:mutate`, {
      operations: [{ create: { name, type: 'IMAGE', imageAsset: { data: readFileSync(path).toString('base64') } } }],
    });
    return r.results[0].resourceName;
  }

  async createYoutubeAsset(youtubeVideoId: string, name: string): Promise<string> {
    const r = await this.call<{ results: { resourceName: string }[] }>(`${this.customer}/assets:mutate`, {
      operations: [{ create: { name, type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId } } }],
    });
    return r.results[0].resourceName;
  }

  async createTextAssets(texts: string[]): Promise<string[]> {
    const r = await this.call<{ results: { resourceName: string }[] }>(`${this.customer}/assets:mutate`, {
      operations: texts.map((text) => ({ create: { type: 'TEXT', textAsset: { text } } })),
    });
    return r.results.map((x) => x.resourceName);
  }

  /** P-MAX のアセットグループにアセットを紐づける。 */
  async linkToAssetGroup(assetGroupId: string, links: { asset: string; fieldType: string }[]): Promise<string[]> {
    const r = await this.call<{ results: { resourceName: string }[] }>(`${this.customer}/assetGroupAssets:mutate`, {
      operations: links.map((l) => ({ create: { assetGroup: `${this.customer}/assetGroups/${assetGroupId}`, asset: l.asset, fieldType: l.fieldType } })),
      partialFailure: true,
    });
    return (r.results ?? []).map((x) => x.resourceName).filter(Boolean);
  }

  async removeAssetGroupAssets(resourceNames: string[]): Promise<void> {
    if (resourceNames.length === 0) return;
    await this.call(`${this.customer}/assetGroupAssets:mutate`, { operations: resourceNames.map((rn) => ({ remove: rn })), partialFailure: true });
  }

  /** デマンド ジェネレーションの広告を作る。 */
  async createDemandGenAd(adGroupId: string, ad: Record<string, unknown>, active: boolean): Promise<string> {
    const r = await this.call<{ results: { resourceName: string }[] }>(`${this.customer}/adGroupAds:mutate`, {
      operations: [{ create: { adGroup: `${this.customer}/adGroups/${adGroupId}`, status: active ? 'ENABLED' : 'PAUSED', ad } }],
    });
    return r.results[0].resourceName;
  }

  async setAdGroupAdStatus(resourceName: string, status: 'ENABLED' | 'PAUSED'): Promise<void> {
    await this.call(`${this.customer}/adGroupAds:mutate`, { operations: [{ update: { resourceName, status }, updateMask: 'status' }] });
  }

  /** 広告ごとの日次実績（デマンド ジェネレーション）。 */
  async adMetrics(adResourceNames: string[], since: string, until: string): Promise<Map<string, DailyMetric[]>> {
    const out = new Map<string, DailyMetric[]>();
    const ids = adResourceNames.map((rn) => rn.split('~').pop()).filter(Boolean);
    if (ids.length === 0) return out;
    const conv = this.s.conversionActionName;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const base = `FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${chunk.join(',')}) AND segments.date BETWEEN '${since}' AND '${until}'`;
      const rows = await this.search<any>(
        `SELECT ad_group_ad.resource_name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ${base}`,
      );
      // 応募のコンバージョンアクションを指定している場合は、そのアクションの件数だけを使う
      const convByKey = new Map<string, number>();
      if (conv) {
        const convRows = await this.search<any>(
          `SELECT ad_group_ad.resource_name, segments.date, segments.conversion_action_name, metrics.all_conversions ${base} AND segments.conversion_action_name = '${conv.replace(/'/g, "\\'")}'`,
        );
        for (const r of convRows) convByKey.set(`${r.adGroupAd.resourceName}|${r.segments.date}`, Number(r.metrics.allConversions ?? 0));
      }
      for (const r of rows) {
        const rn: string = r.adGroupAd.resourceName;
        const date: string = r.segments.date;
        const m: DailyMetric = {
          date,
          platform: 'google',
          impressions: Number(r.metrics.impressions ?? 0),
          clicks: Number(r.metrics.clicks ?? 0),
          spend: Number(r.metrics.costMicros ?? 0) / 1_000_000,
          conversions: conv ? convByKey.get(`${rn}|${date}`) ?? 0 : Number(r.metrics.conversions ?? 0),
        };
        out.set(rn, [...(out.get(rn) ?? []), m]);
      }
    }
    return out;
  }
}

export function googleErrorMessage(body: string): string {
  try {
    const e = JSON.parse(body).error;
    const details = (e.details ?? []).flatMap((d: any) => (d.errors ?? []).map((x: any) => `${x.message}${x.trigger?.stringValue ? `「${x.trigger.stringValue}」` : ''}`));
    return `${e.message}${details.length ? ` / ${details.join(' / ')}` : ''}`;
  } catch {
    return body.slice(0, 300);
  }
}

/** Google の文字数上限（全角=2）に収まるよう切る。収まらなければ代替候補を使う。 */
export function fitGoogle(candidates: string[], limit: number): string | null {
  for (const c of candidates) if (c && googleWidth(c) <= limit) return c;
  const first = candidates.find(Boolean);
  if (!first) return null;
  let out = '';
  for (const ch of first) {
    if (googleWidth(out + ch) > limit) break;
    out += ch;
  }
  return out || null;
}

export interface GoogleTexts {
  headlines: string[];
  longHeadline: string;
  descriptions: string[];
}

/** ブリーフから Google の見出し（全角15字）・説明文（全角45字）を作る。 */
export function googleTexts(brief: CreativeBrief, job: Job): GoogleTexts {
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  const headlines = uniq([
    fitGoogle([brief.headline, brief.overlay.main], 30),
    fitGoogle([brief.hook], 30),
    fitGoogle([`${job.location.replace(/^(.+?[都道府県]).*$/, '$1')}で${job.category}`], 30),
    fitGoogle(brief.overlay.badges.slice(0, 2).join('・') ? [brief.overlay.badges.slice(0, 2).join('・')] : [], 30),
  ]).slice(0, 5);
  const descriptions = uniq([fitGoogle([brief.description, brief.overlay.sub], 90), fitGoogle([brief.primaryText], 90)]).slice(0, 5);
  return { headlines, longHeadline: fitGoogle([brief.overlay.main + ' ' + brief.overlay.sub, brief.headline], 90) ?? brief.headline, descriptions };
}

const FIELD_BY_RATIO: Record<string, string> = {
  '1.91:1': 'MARKETING_IMAGE',
  '1:1': 'SQUARE_MARKETING_IMAGE',
  '4:5': 'PORTRAIT_MARKETING_IMAGE',
};

export interface GooglePublishResult {
  assetResourceNames: string[];
  /** 作成した広告（ad_group_ad）またはアセットグループの紐付け */
  linkedTo: string[];
}

/**
 * 1クリエイティブを Google 広告に入稿する。
 * youtubeVideoId は動画クリエイティブの場合に youtube.ts でアップロード済みの ID を渡す。
 */
export async function publishToGoogle(
  client: GoogleAdsClient,
  creative: Creative,
  brief: CreativeBrief,
  job: Job,
  active: boolean,
  opts: { youtubeVideoId?: string; logoAsset?: string; businessName?: string },
): Promise<GooglePublishResult> {
  const placement = job.placements.google ?? {};
  const adGroups = placement.adGroupIds ?? [];
  const assetGroups = placement.assetGroupIds ?? [];
  if (adGroups.length + assetGroups.length === 0) throw new Error(`求人 ${job.id} に Google の入稿先（placements.google）が設定されていません`);

  const texts = googleTexts(brief, job);
  const name = `adops_${creative.id}`;
  const assetRns: string[] = [];
  const imageAssets: { rn: string; ratio: string }[] = [];
  for (const a of creative.assets.filter((x: Asset) => x.kind === 'image' && FIELD_BY_RATIO[x.ratio])) {
    const rn = await client.createImageAsset(a.path, `${name}_${a.ratio.replace(':', 'x')}`);
    imageAssets.push({ rn, ratio: a.ratio });
    assetRns.push(rn);
  }
  let videoAsset: string | undefined;
  if (opts.youtubeVideoId) {
    videoAsset = await client.createYoutubeAsset(opts.youtubeVideoId, `${name}_video`);
    assetRns.push(videoAsset);
  }

  const linked: string[] = [];
  const finalUrl = withUtm(job.landingUrl, 'google', brief.id);
  const businessName = opts.businessName || process.env.GOOGLE_ADS_BUSINESS_NAME || '';
  const logo = opts.logoAsset || process.env.GOOGLE_ADS_LOGO_ASSET || '';

  for (const adGroupId of adGroups) {
    if (!logo || !businessName) {
      throw new Error('デマンド ジェネレーション広告には GOOGLE_ADS_LOGO_ASSET（ロゴ画像アセットのリソース名）と GOOGLE_ADS_BUSINESS_NAME が必要です');
    }
    const common = {
      headlines: texts.headlines.map((text) => ({ text })),
      descriptions: texts.descriptions.map((text) => ({ text })),
      logoImages: [{ asset: logo }],
    };
    const ad = videoAsset
      ? {
          name,
          finalUrls: [finalUrl],
          demandGenVideoResponsiveAd: {
            ...common,
            longHeadlines: [{ text: texts.longHeadline }],
            videos: [{ asset: videoAsset }],
            businessName: { text: businessName },
            callToActions: [{ text: '応募する' }],
          },
        }
      : {
          name,
          finalUrls: [finalUrl],
          demandGenMultiAssetAd: {
            ...common,
            businessName,
            callToActionText: '応募する',
            marketingImages: imageAssets.filter((i) => i.ratio === '1.91:1').map((i) => ({ asset: i.rn })),
            squareMarketingImages: imageAssets.filter((i) => i.ratio === '1:1').map((i) => ({ asset: i.rn })),
            portraitMarketingImages: imageAssets.filter((i) => i.ratio === '4:5').map((i) => ({ asset: i.rn })),
          },
        };
    const rn = await client.createDemandGenAd(adGroupId, ad, active);
    linked.push(rn);
    log.info(`入稿 ${creative.id} → Demand Gen 広告グループ ${adGroupId}`);
  }

  for (const assetGroupId of assetGroups) {
    const links = [
      ...imageAssets.map((i) => ({ asset: i.rn, fieldType: FIELD_BY_RATIO[i.ratio] })),
      ...(videoAsset ? [{ asset: videoAsset, fieldType: 'YOUTUBE_VIDEO' }] : []),
    ];
    const textRns = await client.createTextAssets(texts.headlines.slice(0, 2));
    links.push(...textRns.map((asset) => ({ asset, fieldType: 'HEADLINE' })));
    linked.push(...(await client.linkToAssetGroup(assetGroupId, links)));
    log.info(`入稿 ${creative.id} → P-MAX アセットグループ ${assetGroupId}（${links.length} アセット）`);
  }

  return { assetResourceNames: assetRns, linkedTo: linked };
}
