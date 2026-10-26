/**
 * 動画のナレーション（音声合成）。Google Cloud Text-to-Speech を使う。
 * 認証はドライブ連携と同じサービスアカウント（GOOGLE_SERVICE_ACCOUNT_JSON）。
 * Cloud プロジェクトで Text-to-Speech API を有効にしておく必要がある。
 */
import { writeFileSync } from 'node:fs';
import { requestJson } from '../util/http.ts';
import { signJwt } from './inbox.ts';

export interface Tts {
  /** text を読み上げた MP3 を path に書き出す */
  synthesize(text: string, path: string): Promise<void>;
}

/** 字幕用の改行や記号を、読み上げやすい文に整える。 */
export function narrationText(caption: string): string {
  return caption
    .replace(/\n+/g, '、')
    .replace(/[〜~]/g, 'から')
    .replace(/[!！]+/g, '。')
    .replace(/[｜|]/g, '、')
    .replace(/、+/g, '、')
    .replace(/^、|、$/g, '')
    .trim();
}

export class GoogleTts implements Tts {
  private sa: { client_email: string; private_key: string };
  private voice: string;
  private rate: number;
  private token: { value: string; exp: number } | null = null;

  constructor(serviceAccountJson: string, voice = 'ja-JP-Neural2-C', rate = 1.1) {
    if (!serviceAccountJson) throw new Error('ナレーションには GOOGLE_SERVICE_ACCOUNT_JSON が必要です');
    this.sa = JSON.parse(serviceAccountJson);
    this.voice = voice;
    this.rate = rate;
  }

  private async auth(): Promise<string> {
    if (!this.token || this.token.exp < Date.now() + 60_000) {
      const r = await requestJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(this.sa, 'https://www.googleapis.com/auth/cloud-platform') }),
      });
      this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    }
    return this.token.value;
  }

  async synthesize(text: string, path: string): Promise<void> {
    const r = await requestJson<{ audioContent: string }>('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.auth()}` },
      json: {
        input: { text: narrationText(text) },
        voice: { languageCode: 'ja-JP', name: this.voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: this.rate, sampleRateHertz: 44100 },
      },
    });
    writeFileSync(path, Buffer.from(r.audioContent, 'base64'));
  }
}

export function createTts(): Tts | null {
  if (process.env.ADOPS_TTS !== 'google') return null;
  return new GoogleTts(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '', process.env.ADOPS_TTS_VOICE || undefined, Number(process.env.ADOPS_TTS_RATE) || undefined);
}
