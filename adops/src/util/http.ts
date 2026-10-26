import { logger } from './log.ts';

const log = logger('http');

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} ${redact(url)}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

/** URL に含まれるトークン類をログに出さない。 */
export function redact(url: string): string {
  return url.replace(/(access_token|key|token)=[^&]+/gi, '$1=***');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  json?: unknown;
  /** 429 / 5xx / ネットワークエラー時の最大試行回数 */
  attempts?: number;
  timeoutMs?: number;
}

/** リトライ付き fetch。429 と 5xx とネットワークエラーだけ再試行する（4xx は即失敗）。 */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (res.ok) return res;
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, text, url);
        if (i === attempts - 1) break; // 最後の試行の後は待たずに失敗を返す
        // Retry-After が極端に長くても最大60秒まで（実行時間の上限を食いつぶさないように）
        const wait = Math.min(60_000, Number(res.headers.get('retry-after')) * 1000 || 2 ** i * 1500);
        log.warn(`retry ${i + 1}/${attempts} after ${wait}ms (${res.status}) ${redact(url)}`);
        await sleep(wait);
        continue;
      }
      throw new HttpError(res.status, text, url);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(2 ** i * 1500);
    }
  }
  throw lastErr;
}

export async function requestJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);
  return (await res.json()) as T;
}
