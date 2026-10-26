/**
 * Meta（Facebook / Instagram）Marketing API。
 *
 * 役割分担: キャンペーン・広告セット（目的・ターゲティング・予算・特別広告カテゴリ）は人が作り、
 * このモジュールはそこに「広告（クリエイティブ）」を入れ替え続ける。
 *
 * 配置ごとに比率を出し分ける（フィード=4:5、ストーリーズ/リール=9:16）ため、
 * 配置カスタマイズ（asset_feed_spec + asset_customization_rules）で1広告にまとめる。
 */
import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Settings } from '../config.ts';
import type { Asset, Creative, CreativeBrief, DailyMetric, Job } from '../types.ts';
import { HttpError, request, requestJson, sleep } from '../util/http.ts';
import { logger } from '../util/log.ts';

const log = logger('meta');

/** adops が止めた広告の名前に付ける印（Slack 承認の受け口でも参照する） */
export const STOP_MARK = '[adops停止]';

/** 応募としてカウントする action_type（ピクセル/リード広告の設定に合わせて変える） */
export const DEFAULT_CONVERSION_ACTIONS = [
  'offsite_conversion.fb_pixel_lead',
  'offsite_conversion.fb_pixel_submit_application',
  'onsite_conversion.lead_grouped',
  'lead',
  'submit_application_total',
];

export interface MetaPublishResult {
  adIds: string[];
  creativeIds: string[];
  /** 一部の広告セットで失敗した場合の理由（作成できた広告は adIds に入る） */
  errors: string[];
  /** フィード用画像（動画ならサムネイル）の公開 URL */
  previewUrl?: string;
}

export class MetaClient {
  private s: Settings['meta'];
  private base: string;
  private conversionActions: string[];

  constructor(s: Settings['meta']) {
    this.s = s;
    this.base = `https://graph.facebook.com/${s.apiVersion}`;
    this.conversionActions = (process.env.META_CONVERSION_ACTION_TYPES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (this.conversionActions.length === 0) this.conversionActions = DEFAULT_CONVERSION_ACTIONS;
  }

  private authParams(): Record<string, string> {
    const p: Record<string, string> = { access_token: this.s.accessToken };
    const secret = process.env.META_APP_SECRET;
    if (secret) p.appsecret_proof = createHmac('sha256', secret).update(this.s.accessToken).digest('hex');
    return p;
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ ...this.authParams(), ...params });
    return `${this.base}/${path.replace(/^\//, '')}?${qs}`;
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<T> {
    const flat = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    try {
      if (method === 'GET') return await requestJson<T>(this.url(path, flat));
      const body = new URLSearchParams({ ...this.authParams(), ...flat });
      // 広告・クリエイティブの作成は、タイムアウト後の再送で二重作成になり得るので再試行しない
      const creates = /\/(ads|adcreatives)$/.test(path);
      return await requestJson<T>(`${this.base}/${path.replace(/^\//, '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        attempts: creates ? 1 : undefined,
      });
    } catch (e) {
      if (e instanceof HttpError) throw new Error(`Meta API ${method} ${path}: ${metaErrorMessage(e.body)}`);
      throw e;
    }
  }

  /**
   * アクセストークンの有効期限。システムユーザーのトークンは無期限（null）。ユーザーのトークンは約60日で切れ、
   * 切れると広告の停止も含めて何もできなくなるので、事前に知らせるために使う。
   */
  async tokenExpiry(): Promise<{ valid: boolean; expiresAt: number | null }> {
    const r = await this.call<{ data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number } }>('GET', 'debug_token', {
      input_token: this.s.accessToken,
    });
    const d = r.data ?? {};
    const times = [d.expires_at, d.data_access_expires_at].filter((t): t is number => typeof t === 'number' && t > 0);
    return { valid: d.is_valid !== false, expiresAt: times.length ? Math.min(...times) : null };
  }

  get account(): string {
    return `act_${this.s.adAccountId}`;
  }

  /** アップロードした画像の公開 URL（ローカルパス → URL）。Slack の承認メッセージのプレビューに使う */
  readonly imageUrls = new Map<string, string>();

  async uploadImage(path: string): Promise<string> {
    const bytes = readFileSync(path).toString('base64');
    const res = await this.call<{ images: Record<string, { hash: string; url?: string }> }>('POST', `${this.account}/adimages`, { bytes, name: basename(path) });
    const first = Object.values(res.images ?? {})[0];
    if (!first?.hash) throw new Error('Meta: 画像ハッシュが返りませんでした');
    if (first.url) this.imageUrls.set(path, first.url);
    return first.hash;
  }

  /** 動画をアップロードし、処理完了まで待つ（数十秒〜数分）。 */
  async uploadVideo(path: string, title: string): Promise<string> {
    const size = statSync(path).size;
    if (size > 900 * 1024 * 1024) throw new Error('Meta: 動画が大きすぎます（900MB超）');
    const form = new FormData();
    for (const [k, v] of Object.entries(this.authParams())) form.append(k, v);
    form.append('title', title);
    form.append('source', new Blob([readFileSync(path)], { type: 'video/mp4' }), basename(path));
    const res = await request(`${this.base}/${this.account}/advideos`, { method: 'POST', body: form, timeoutMs: 600_000 });
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < 60; i++) {
      const st = await this.call<{ status?: { video_status?: string } }>('GET', id, { fields: 'status' });
      const vs = st.status?.video_status;
      if (vs === 'ready') return id;
      if (vs === 'error') throw new Error(`Meta: 動画の処理に失敗しました (${id})`);
      await sleep(10_000);
    }
    throw new Error(`Meta: 動画の処理が10分以内に終わりませんでした (${id})`);
  }

  /**
   * クリエイティブを作る。フィード用（4:5 か 1:1）とストーリーズ/リール用（9:16）を配置ごとに出し分ける。
   */
  async createCreative(brief: CreativeBrief, job: Job, assets: Asset[], name: string): Promise<string> {
    const feed = assets.find((a) => a.ratio === '4:5') ?? assets.find((a) => a.ratio === '1:1');
    const vertical = assets.find((a) => a.ratio === '9:16');
    if (!feed && !vertical) throw new Error('Meta: 入稿できる比率（4:5 / 1:1 / 9:16）の素材がありません');
    const link = withUtm(job.landingUrl, 'meta', brief.id);
    // インスタントフォーム（リード獲得）の場合は、ボタンの遷移先をフォームにする（link は審査・フォールバック用）
    const leadFormId = job.placements.meta?.leadFormId;
    const ctaValue = leadFormId ? { link, lead_gen_form_id: leadFormId } : { link };
    const isVideo = (feed ?? vertical)!.kind === 'video';
    const ig = this.s.instagramUserId ? { instagram_user_id: this.s.instagramUserId } : {};

    // カルーセル: カード画像を順に child_attachments に並べる
    const cards = assets.filter((a) => a.card !== undefined).sort((a, b) => a.card! - b.card!);
    if (brief.format === 'carousel' && cards.length >= 2) {
      // 制作したカードは最大5枚 + 条件まとめ。最後のカードの見出しは広告の見出し
      const titles = [...brief.storyboard.slice(0, cards.length - 1).map((s) => s.text), brief.headline];
      const child_attachments = [];
      for (const [i, a] of cards.entries()) {
        child_attachments.push({
          link,
          image_hash: await this.uploadImage(a.path),
          name: (titles[i] ?? brief.headline).replace(/\n/g, ' ').slice(0, 40),
          description: brief.description.slice(0, 30),
          call_to_action: { type: brief.cta, value: ctaValue },
        });
      }
      const res = await this.postCreative({
        name,
        object_story_spec: {
          page_id: this.s.pageId,
          ...ig,
          link_data: {
            link,
            message: brief.primaryText,
            child_attachments,
            // カードの順番は物語になっているので、Meta に並べ替えさせない。最後の自動カード（ページ）も付けない
            multi_share_optimized: false,
            multi_share_end_card: false,
            call_to_action: { type: brief.cta, value: ctaValue },
          },
        },
      });
      return res.id;
    }

    // 配置カスタマイズはフォーム型の広告では使わない（object_story_spec の単一素材で入稿する）
    const usePac = process.env.META_USE_PLACEMENT_CUSTOMIZATION !== 'false' && feed && vertical && !leadFormId;
    if (!usePac) {
      const a = (feed ?? vertical)!;
      const story = isVideo
        ? {
            page_id: this.s.pageId,
            ...ig,
            video_data: {
              video_id: await this.uploadVideo(a.path, name),
              image_hash: await this.uploadImage(thumbOf(a)),
              message: brief.primaryText,
              title: brief.headline,
              link_description: brief.description,
              call_to_action: { type: brief.cta, value: ctaValue },
            },
          }
        : {
            page_id: this.s.pageId,
            ...ig,
            link_data: {
              image_hash: await this.uploadImage(a.path),
              link,
              message: brief.primaryText,
              name: brief.headline,
              description: brief.description,
              call_to_action: { type: brief.cta, value: ctaValue },
            },
          };
      const res = await this.postCreative({ name, object_story_spec: story }, { video: isVideo });
      return res.id;
    }

    // 配置カスタマイズ
    const feedLabel = { name: `${brief.id}_feed` };
    const vertLabel = { name: `${brief.id}_vertical` };
    const media = isVideo
      ? {
          videos: [
            { video_id: await this.uploadVideo(feed!.path, `${name}_feed`), thumbnail_hash: await this.uploadImage(thumbOf(feed!)), adlabels: [feedLabel] },
            { video_id: await this.uploadVideo(vertical!.path, `${name}_vertical`), thumbnail_hash: await this.uploadImage(thumbOf(vertical!)), adlabels: [vertLabel] },
          ],
          ad_formats: ['SINGLE_VIDEO'],
        }
      : {
          images: [
            { hash: await this.uploadImage(feed!.path), adlabels: [feedLabel] },
            { hash: await this.uploadImage(vertical!.path), adlabels: [vertLabel] },
          ],
          ad_formats: ['SINGLE_IMAGE'],
        };
    const labelKey = isVideo ? 'video_label' : 'image_label';
    const assetFeedSpec = {
      ...media,
      bodies: [{ text: brief.primaryText }],
      titles: [{ text: brief.headline }],
      descriptions: [{ text: brief.description }],
      link_urls: [{ website_url: link }],
      call_to_action_types: [brief.cta],
      asset_customization_rules: [
        {
          customization_spec: {
            publisher_platforms: ['facebook', 'instagram'],
            facebook_positions: ['story', 'facebook_reels'],
            instagram_positions: ['story', 'reels'],
          },
          [labelKey]: vertLabel,
          priority: 1,
        },
        {
          customization_spec: {
            publisher_platforms: ['facebook', 'instagram', 'audience_network', 'messenger'],
          },
          [labelKey]: feedLabel,
          priority: 2,
        },
      ],
    };
    const res = await this.postCreative({
      name,
      object_story_spec: { page_id: this.s.pageId, ...ig },
      asset_feed_spec: assetFeedSpec,
    }, { video: isVideo });
    return res.id;
  }

  /**
   * 広告クリエイティブを作る。Meta の自動「テキストの最適化」などは、レビュー済みのコピーを書き換えて
   * 法令チェックを通っていない表現になりうるので、既定で OPT_OUT する（ADOPS_META_ENHANCEMENTS=allow で無効化）。
   * 指定が広告の種類に合わず「パラメータ不正」で拒否された場合だけ、段階的に減らして作り直す
   * （まずテキストの最適化の OPT_OUT だけ残し、最後に指定なし）。5xx・429 などは作られた可能性があるので作り直さない。
   */
  private async postCreative(params: Record<string, unknown>, opts: { video?: boolean } = {}): Promise<{ id: string }> {
    const post = (extra: Record<string, unknown>) => this.call<{ id: string }>('POST', `${this.account}/adcreatives`, { ...params, ...extra });
    if (process.env.ADOPS_META_ENHANCEMENTS === 'allow') return post({});
    const optOut = { enroll_status: 'OPT_OUT' };
    const textOnly = { creative_features_spec: { text_optimizations: optOut } };
    // 画像の補正・テンプレートは動画には無いので、動画はテキストの最適化だけ
    const stages: Record<string, unknown>[] = opts.video
      ? [{ degrees_of_freedom_spec: textOnly }, {}]
      : [{ degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: optOut, image_touchups: optOut, image_template: optOut } } }, { degrees_of_freedom_spec: textOnly }, {}];
    for (const [i, extra] of stages.entries()) {
      try {
        return await post(extra);
      } catch (e) {
        const msg = (e as Error).message;
        if (i === stages.length - 1 || !isSpecRejection(msg)) throw e;
        const next = stages[i + 1].degrees_of_freedom_spec ? 'テキストの最適化の OPT_OUT だけ' : '指定なし（Meta がコピーを書き換える可能性あり）';
        log.warn(`自動補正の OPT_OUT 指定が受け付けられなかったため、${next}で作成します: ${msg.slice(0, 200)}`);
      }
    }
    throw new Error('unreachable');
  }

  async createAd(adsetId: string, creativeId: string, name: string, active: boolean): Promise<string> {
    const res = await this.call<{ id: string }>('POST', `${this.account}/ads`, {
      name,
      adset_id: adsetId,
      creative: { creative_id: creativeId },
      status: active ? 'ACTIVE' : 'PAUSED',
    });
    return res.id;
  }

  async setAdStatus(adId: string, status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'): Promise<void> {
    await this.call('POST', adId, { status });
  }

  /**
   * adops の判断で止めた広告として印を付けて停止する（広告名の末尾に [adops停止]）。
   * Slack の古い承認ボタンや、人の再開と区別するために使う。
   */
  async stopAd(adId: string): Promise<void> {
    const cur = await this.call<{ name?: string }>('GET', adId, { fields: 'name' }).catch(() => ({ name: undefined }));
    const params: Record<string, string> = { status: 'PAUSED' };
    if (cur.name && !cur.name.includes(STOP_MARK)) params.name = `${cur.name} ${STOP_MARK}`.slice(0, 400);
    await this.call('POST', adId, params);
  }

  /** 広告セット内の、adops が作った（名前が adops_ で始まる）配信中の広告。緊急停止の取りこぼし対策に使う。 */
  async liveAdopsAds(adsetId: string): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let after: string | undefined;
    // 配信中のものだけを取り、ページを最後までたどる（停止済みの広告が溜まっても取りこぼさない）
    for (let page = 0; page < 20; page++) {
      const res = await this.call<{ data: { id: string; name?: string }[]; paging?: { cursors?: { after?: string }; next?: string } }>('GET', `${adsetId}/ads`, {
        fields: 'id,name',
        effective_status: ['ACTIVE'],
        limit: '200',
        ...(after ? { after } : {}),
      });
      out.push(...(res.data ?? []).filter((a) => a.name?.startsWith('adops_')).map((a) => ({ id: a.id, name: a.name! })));
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /**
   * 広告の配信状態と審査結果。effective_status は ACTIVE / PAUSED / DISAPPROVED / PENDING_REVIEW / WITH_ISSUES など。
   */
  async adStatuses(adIds: string[]): Promise<Map<string, { status: string; review?: string }>> {
    const out = new Map<string, { status: string; review?: string }>();
    for (let i = 0; i < adIds.length; i += 50) {
      const chunk = adIds.slice(i, i + 50);
      const r = await this.call<Record<string, { effective_status?: string; ad_review_feedback?: Record<string, Record<string, string>> }>>('GET', '', {
        ids: chunk.join(','),
        fields: 'effective_status,ad_review_feedback',
      });
      for (const [id, v] of Object.entries(r)) {
        const fb = v.ad_review_feedback?.global ?? {};
        out.set(id, { status: v.effective_status ?? 'UNKNOWN', review: Object.entries(fb).map(([k, m]) => `${k}: ${m}`).join(' / ') || undefined });
      }
    }
    return out;
  }

  /**
   * インスタントフォームに届いたリード（応募）。since（UNIX 秒）より新しいものだけ。
   * 個人情報は呼び出し側で保存しないこと（状態ファイルは Git に保存されるため）。
   */
  async leads(formId: string, since: number): Promise<{ id: string; createdTime: number; adId?: string; fields: Record<string, string> }[]> {
    const out: { id: string; createdTime: number; adId?: string; fields: Record<string, string> }[] = [];
    let url: string | null = this.url(`${formId}/leads`, {
      fields: 'id,created_time,ad_id,field_data',
      filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]),
      limit: '100',
    });
    while (url) {
      const page: any = await requestJson(url);
      for (const l of page.data ?? []) {
        out.push({
          id: l.id,
          createdTime: Math.floor(Date.parse(l.created_time) / 1000),
          adId: l.ad_id,
          fields: Object.fromEntries((l.field_data ?? []).map((f: { name: string; values: string[] }) => [f.name, (f.values ?? []).join(', ')])),
        });
      }
      url = page.paging?.next ?? null;
    }
    return out;
  }

  /** 広告クリエイティブの投稿 ID（コメントが付く先）。 */
  async storyIdOf(creativeId: string): Promise<string | null> {
    const r = await this.call<{ effective_object_story_id?: string }>('GET', creativeId, { fields: 'effective_object_story_id' }).catch(() => ({ effective_object_story_id: undefined }));
    return r.effective_object_story_id ?? null;
  }

  /** 広告の Instagram 側の投稿 ID（Instagram に配信していなければ null）。 */
  async instagramMediaIdOf(creativeId: string): Promise<string | null> {
    const r = await this.call<{ effective_instagram_media_id?: string }>('GET', creativeId, { fields: 'effective_instagram_media_id' }).catch(() => ({
      effective_instagram_media_id: undefined,
    }));
    return r.effective_instagram_media_id ?? null;
  }

  /** Instagram の投稿のコメント（since: UNIX 秒より後）。自社アカウントの返信は除く。 */
  async instagramComments(mediaId: string, since: number): Promise<{ id: string; message: string; createdTime: number }[]> {
    const out: { id: string; message: string; createdTime: number }[] = [];
    let url: string | null = this.url(`${mediaId}/comments`, { fields: 'id,text,timestamp,from', limit: '50' });
    while (url) {
      const page: any = await requestJson(url);
      for (const c of page.data ?? []) {
        if (c.from?.id && c.from.id === this.s.instagramUserId) continue;
        out.push({ id: c.id, message: c.text ?? '', createdTime: Math.floor(Date.parse(c.timestamp) / 1000) });
      }
      url = page.paging?.next ?? null;
    }
    return out.filter((c) => c.createdTime > since);
  }

  async hideInstagramComment(commentId: string): Promise<void> {
    await this.call('POST', commentId, { hide: 'true' });
  }

  /** 投稿のコメント（since: UNIX 秒より後）。 */
  async comments(postId: string, since: number): Promise<{ id: string; message: string; createdTime: number }[]> {
    const out: { id: string; message: string; createdTime: number }[] = [];
    let url: string | null = this.url(`${postId}/comments`, { fields: 'id,message,created_time,from', filter: 'stream', order: 'chronological', limit: '100', since: String(since) });
    while (url) {
      const page: any = await requestJson(url);
      for (const c of page.data ?? []) {
        // 自社ページの返信は対象外（返信案を使って答えたコメントが再び通知されないように）
        if (c.from?.id && c.from.id === this.s.pageId) continue;
        out.push({ id: c.id, message: c.message ?? '', createdTime: Math.floor(Date.parse(c.created_time) / 1000) });
      }
      url = page.paging?.next ?? null;
    }
    return out.filter((c) => c.createdTime > since);
  }

  async hideComment(commentId: string): Promise<void> {
    await this.call('POST', commentId, { is_hidden: 'true' });
  }

  async getAdset(adsetId: string): Promise<{ id: string; dailyBudget: number | null; status: string }> {
    const r = await this.call<{ id: string; daily_budget?: string; effective_status?: string }>('GET', adsetId, { fields: 'id,daily_budget,effective_status' });
    // JPY は補助通貨単位が無いので daily_budget はそのまま円
    return { id: r.id, dailyBudget: r.daily_budget ? Number(r.daily_budget) : null, status: r.effective_status ?? '' };
  }

  async setAdsetDailyBudget(adsetId: string, yen: number): Promise<void> {
    await this.call('POST', adsetId, { daily_budget: String(Math.round(yen)) });
  }

  /** 広告ごとの日次実績。 */
  async insights(adIds: string[], since: string, until: string): Promise<Map<string, DailyMetric[]>> {
    const out = new Map<string, DailyMetric[]>();
    for (let i = 0; i < adIds.length; i += 50) {
      const chunk = adIds.slice(i, i + 50);
      let url: string | null = this.url(`${this.account}/insights`, {
        level: 'ad',
        fields: 'ad_id,date_start,impressions,inline_link_clicks,spend,actions',
        time_increment: '1',
        time_range: JSON.stringify({ since, until }),
        filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: chunk }]),
        limit: '500',
      });
      while (url) {
        const page: any = await requestJson(url);
        for (const row of page.data ?? []) {
          const actions: { action_type: string; value: string }[] = row.actions ?? [];
          const sum = (types: string[]) => actions.filter((a) => types.includes(a.action_type)).reduce((s, a) => s + Number(a.value), 0);
          // 同じ応募が複数の action_type で重複計上されるので、最初に見つかった種類だけ数える
          const conv = this.conversionActions.map((t) => sum([t])).find((v) => v > 0) ?? 0;
          const m: DailyMetric = {
            date: row.date_start,
            platform: 'meta',
            impressions: Number(row.impressions ?? 0),
            clicks: Number(row.inline_link_clicks ?? 0),
            spend: Number(row.spend ?? 0),
            conversions: conv,
            videoViews: sum(['video_view']),
          };
          out.set(row.ad_id, [...(out.get(row.ad_id) ?? []), m]);
        }
        url = page.paging?.next ?? null;
      }
    }
    return out;
  }
}

/** クリエイティブ作成のエラーが「指定の内容が不正」（＝作られていない）によるものか。 */
export function isSpecRejection(msg: string): boolean {
  if (!msg.startsWith('Meta API')) return false;
  return /degrees_of_freedom|creative_features|Invalid parameter|\(code 100[)/]/i.test(msg);
}

export function metaErrorMessage(body: string): string {
  try {
    const e = JSON.parse(body).error;
    return `${e.message}${e.error_user_msg ? ` / ${e.error_user_msg}` : ''} (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})`;
  } catch {
    return body.slice(0, 300);
  }
}

/** 動画素材のサムネイル（video.ts が同名 .jpg で書き出す）。 */
function thumbOf(a: Asset): string {
  return a.path.replace(/\.mp4$/, '.jpg');
}

/** 計測用の UTM を付ける（既存のクエリは保持）。 */
export function withUtm(url: string, source: 'meta' | 'google', content: string): string {
  const u = new URL(url);
  if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', source);
  if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'paid_social');
  if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', 'adops');
  u.searchParams.set('utm_content', content);
  return u.toString();
}

/** 1クリエイティブを、求人に紐づく全広告セットに入稿する。 */
export async function publishToMeta(client: MetaClient, creative: Creative, brief: CreativeBrief, job: Job, active: boolean): Promise<MetaPublishResult> {
  const adsets = job.placements.meta?.adsetIds ?? [];
  if (adsets.length === 0) throw new Error(`求人 ${job.id} に Meta の広告セット（placements.meta.adsetIds）が設定されていません`);
  const name = `adops_${creative.id}_${creative.angle}_${creative.format}`;
  const creativeId = await client.createCreative(brief, job, creative.assets, name);
  const adIds: string[] = [];
  const errors: string[] = [];
  // 1つの広告セットで失敗しても、作成済みの広告は必ず返す（追跡されない配信中広告を残さない）
  for (const adsetId of adsets) {
    try {
      adIds.push(await client.createAd(adsetId, creativeId, name, active));
      log.info(`入稿 ${creative.id} → adset ${adsetId}（${active ? '配信開始' : '停止状態'}）`);
    } catch (e) {
      errors.push(`adset ${adsetId}: ${(e as Error).message}`);
    }
  }
  const feed = creative.assets.find((a) => a.ratio === '4:5') ?? creative.assets.find((a) => a.ratio === '1:1') ?? creative.assets[0];
  const previewUrl = feed ? client.imageUrls?.get(feed.kind === 'video' ? thumbOf(feed) : feed.path) : undefined;
  return { adIds, creativeIds: [creativeId], errors, previewUrl };
}
