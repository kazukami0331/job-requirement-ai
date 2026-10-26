/**
 * Google 広告で動画を使うための YouTube アップロード（限定公開）。
 * OAuth のリフレッシュトークンには youtube.upload スコープが必要。
 * YOUTUBE_REFRESH_TOKEN が無ければ Google 広告と同じトークンを使う（両スコープで発行しておく）。
 */
import { readFileSync, statSync } from 'node:fs';
import { HttpError, request } from '../util/http.ts';

export interface YoutubeAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function token(a: YoutubeAuth): Promise<string> {
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: a.clientId, client_secret: a.clientSecret, refresh_token: a.refreshToken, grant_type: 'refresh_token' }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function uploadToYoutube(
  a: YoutubeAuth,
  path: string,
  meta: { title: string; description: string; privacy?: 'unlisted' | 'public' },
): Promise<string> {
  const access = await token(a);
  const size = statSync(path).size;
  // 1) 再開可能アップロードのセッションを作る
  let init: Response;
  try {
    init = await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size),
      },
      json: {
        snippet: { title: meta.title.slice(0, 100), description: meta.description.slice(0, 4900), categoryId: '22' },
        // 既定は限定公開（広告用。検索やチャンネルには出さない）。オーガニックのショートは public で呼ぶ
        status: { privacyStatus: meta.privacy ?? 'unlisted', selfDeclaredMadeForKids: false },
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw new Error(`YouTube アップロードの開始に失敗: ${e.body.slice(0, 300)}`);
    throw e;
  }
  const location = init.headers.get('location');
  if (!location) throw new Error('YouTube: アップロード先 URL が返りませんでした');
  // 2) 本体を送る（短尺動画なので1回で送る）
  const res = await request(location, {
    method: 'PUT',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'video/mp4', 'content-length': String(size) },
    body: readFileSync(path),
    timeoutMs: 600_000,
    attempts: 1, // 再送で同じ動画が二重に公開されないように
  });
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error('YouTube: 動画 ID が返りませんでした');
  return body.id;
}
