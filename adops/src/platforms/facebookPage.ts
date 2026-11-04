/**
 * Facebook ページへのオーガニック投稿（画像 / 複数画像 / 動画）。
 * ページとして投稿するため、システムユーザーのトークンからページのアクセストークンを取得して使う
 * （pages_manage_posts / pages_read_engagement 権限が必要）。
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Settings } from '../config.ts';
import { HttpError, request, requestJson } from '../util/http.ts';
import { metaErrorMessage } from './meta.ts';

export class FacebookPageClient {
  private s: Settings['meta'];
  private base: string;
  private pageToken: string | null = null;

  constructor(s: Settings['meta']) {
    this.s = s;
    this.base = `https://graph.facebook.com/${s.apiVersion}`;
  }

  private proof(token: string): Record<string, string> {
    const secret = process.env.META_APP_SECRET;
    return secret ? { appsecret_proof: createHmac('sha256', secret).update(token).digest('hex') } : {};
  }

  private async token(): Promise<string> {
    if (this.pageToken) return this.pageToken;
    const qs = new URLSearchParams({ access_token: this.s.accessToken, fields: 'access_token', ...this.proof(this.s.accessToken) });
    const r = await requestJson<{ access_token?: string }>(`${this.base}/${this.s.pageId}?${qs}`);
    if (!r.access_token) throw new Error('ページのアクセストークンを取得できませんでした（pages_manage_posts 権限を確認）');
    this.pageToken = r.access_token;
    return r.access_token;
  }

  private async post<T = any>(path: string, params: Record<string, string>, attempts?: number): Promise<T> {
    const t = await this.token();
    try {
      return await requestJson<T>(`${this.base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: t, ...this.proof(t), ...params }),
        attempts,
      });
    } catch (e) {
      if (e instanceof HttpError) throw new Error(`Facebook ページ ${path}: ${metaErrorMessage(e.body)}`);
      throw e;
    }
  }

  /** 画像をアップロードする（published=false なら複数画像投稿の部品として使う）。 */
  private async uploadPhoto(path: string, published: boolean, caption?: string): Promise<string> {
    const t = await this.token();
    const form = new FormData();
    form.append('access_token', t);
    for (const [k, v] of Object.entries(this.proof(t))) form.append(k, v);
    form.append('published', String(published));
    if (caption) form.append('caption', caption);
    form.append('source', new Blob([readFileSync(path)], { type: 'image/jpeg' }), basename(path));
    const res = await request(`${this.base}/${this.s.pageId}/photos`, { method: 'POST', body: form, attempts: 1 });
    const r = (await res.json()) as { id?: string; post_id?: string };
    if (!r.id) throw new Error('Facebook ページへの画像アップロードに失敗しました');
    return published ? (r.post_id ?? r.id) : r.id;
  }

  async postPhoto(path: string, caption: string): Promise<string> {
    return this.uploadPhoto(path, true, caption);
  }

  async postPhotos(paths: string[], caption: string): Promise<string> {
    const ids: string[] = [];
    for (const p of paths.slice(0, 10)) ids.push(await this.uploadPhoto(p, false));
    const params: Record<string, string> = { message: caption };
    ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const r = await this.post<{ id: string }>(`${this.s.pageId}/feed`, params, 1);
    return r.id;
  }

  async postVideo(path: string, description: string): Promise<string> {
    const t = await this.token();
    const form = new FormData();
    form.append('access_token', t);
    for (const [k, v] of Object.entries(this.proof(t))) form.append(k, v);
    form.append('description', description);
    form.append('source', new Blob([readFileSync(path)], { type: 'video/mp4' }), basename(path));
    const res = await request(`https://graph-video.facebook.com/${this.s.apiVersion}/${this.s.pageId}/videos`, { method: 'POST', body: form, attempts: 1, timeoutMs: 600_000 });
    const r = (await res.json()) as { id?: string };
    if (!r.id) throw new Error('Facebook ページへの動画投稿に失敗しました');
    return r.id;
  }
}
