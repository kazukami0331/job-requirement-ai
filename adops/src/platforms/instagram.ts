/**
 * Instagram のオーガニック投稿（Instagram Graph API / コンテンツ公開）。
 * 広告アカウントと同じシステムユーザーのトークンに instagram_basic / instagram_content_publish /
 * instagram_manage_insights 権限が必要。
 *
 * - フィード画像: 公開 URL が必要なので、Meta の広告画像ライブラリにアップロードして得た CDN URL を使う
 * - リール: 再開可能アップロード（rupload.facebook.com）で動画本体を直接送る
 */
import { readFileSync, statSync } from 'node:fs';
import type { Settings } from '../config.ts';
import { HttpError, request, requestJson, sleep } from '../util/http.ts';
import { metaErrorMessage } from './meta.ts';

export interface OrganicInsight {
  date: string;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  saved: number;
  shares: number;
}

export class InstagramClient {
  private s: Settings['meta'];
  private base: string;

  constructor(s: Settings['meta']) {
    if (!s.instagramUserId) throw new Error('Instagram 投稿には META_INSTAGRAM_USER_ID が必要です');
    this.s = s;
    this.base = `https://graph.facebook.com/${s.apiVersion}`;
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ access_token: this.s.accessToken, ...params });
    try {
      return method === 'GET'
        ? await requestJson<T>(`${this.base}/${path}?${qs}`)
        : await requestJson<T>(`${this.base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs });
    } catch (e) {
      if (e instanceof HttpError) throw new Error(`Instagram API ${method} ${path}: ${metaErrorMessage(e.body)}`);
      throw e;
    }
  }

  /** 広告画像ライブラリ経由で公開 URL を得る（Instagram は画像の URL しか受け付けない）。 */
  async publicImageUrl(path: string): Promise<string> {
    const res = await this.call<{ images: Record<string, { url?: string }> }>('POST', `act_${this.s.adAccountId}/adimages`, {
      bytes: readFileSync(path).toString('base64'),
    });
    const url = Object.values(res.images ?? {})[0]?.url;
    if (!url) throw new Error('画像の公開 URL を取得できませんでした');
    return url;
  }

  private async waitContainer(id: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const r = await this.call<{ status_code?: string; status?: string }>('GET', id, { fields: 'status_code,status' });
      if (r.status_code === 'FINISHED') return;
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new Error(`Instagram のメディア処理に失敗: ${r.status ?? r.status_code}`);
      await sleep(5000);
    }
    throw new Error('Instagram のメディア処理が5分以内に終わりませんでした');
  }

  private async publishContainer(creationId: string): Promise<{ id: string; permalink: string }> {
    const { id } = await this.call<{ id: string }>('POST', `${this.s.instagramUserId}/media_publish`, { creation_id: creationId });
    const { permalink } = await this.call<{ permalink: string }>('GET', id, { fields: 'permalink' });
    return { id, permalink };
  }

  async postImage(path: string, caption: string): Promise<{ id: string; permalink: string }> {
    const image_url = await this.publicImageUrl(path);
    const { id } = await this.call<{ id: string }>('POST', `${this.s.instagramUserId}/media`, { image_url, caption });
    await this.waitContainer(id);
    return this.publishContainer(id);
  }

  async postReel(videoPath: string, caption: string, coverAtMs = 1000): Promise<{ id: string; permalink: string }> {
    const container = await this.call<{ id: string; uri?: string }>('POST', `${this.s.instagramUserId}/media`, {
      media_type: 'REELS',
      upload_type: 'resumable',
      caption,
      share_to_feed: 'true',
      thumb_offset: String(coverAtMs),
    });
    const size = statSync(videoPath).size;
    const uploadUrl = container.uri ?? `https://rupload.facebook.com/ig-api-upload/${this.s.apiVersion}/${container.id}`;
    await request(uploadUrl, {
      method: 'POST',
      headers: { authorization: `OAuth ${this.s.accessToken}`, offset: '0', file_size: String(size) },
      body: readFileSync(videoPath),
      timeoutMs: 600_000,
    });
    await this.waitContainer(container.id);
    return this.publishContainer(container.id);
  }

  /** 投稿の反応（リーチ・再生・いいね・保存・シェア）。 */
  async insights(mediaId: string, date: string): Promise<OrganicInsight> {
    const r = await this.call<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>('GET', `${mediaId}/insights`, {
      metric: 'reach,views,likes,comments,saved,shares',
    });
    const v = (name: string) => {
      const m = r.data.find((d) => d.name === name);
      return Number(m?.total_value?.value ?? m?.values?.[0]?.value ?? 0);
    };
    return { date, reach: v('reach'), views: v('views'), likes: v('likes'), comments: v('comments'), saved: v('saved'), shares: v('shares') };
  }
}
