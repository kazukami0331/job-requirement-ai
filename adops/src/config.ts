import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brand, Job, Persona, Policy } from './types.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

/** .env を読み込む（既に環境変数があれば上書きしない）。依存を増やさないため自前で最小実装。 */
export function loadDotEnv(path = join(ROOT, '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export type ImageProviderKind = 'mock' | 'midjourney' | 'handoff';

export interface Settings {
  dryRun: boolean;
  dataDir: string;
  configDir: string;
  anthropic: { apiKey: string; model: string; fastModel: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; maxUsdPerRun: number };
  image: {
    provider: ImageProviderKind;
    midjourney: {
      baseUrl: string;
      apiKey: string;
      /** 中継サービスの API 形式 */
      flavor: 'piapi' | 'generic';
      /** --v / --style raw 等、毎回付けるパラメータ */
      params: string;
      videoEnabled: boolean;
    };
    /** 手渡しモードで人が画像を置くフォルダ */
    inboxDir: string;
    /** 手渡しの置き場所: local（data/inbox）か drive（Google ドライブ） */
    inbox: 'local' | 'drive';
    drive: { serviceAccountJson: string; folderId: string };
  };
  meta: {
    accessToken: string;
    adAccountId: string;
    pageId: string;
    instagramUserId: string;
    apiVersion: string;
  };
  google: {
    developerToken: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    customerId: string;
    loginCustomerId: string;
    apiVersion: string;
    conversionActionName: string;
  };
  slack: { webhookUrl: string };
  fontPath: string;
}

export function loadSettings(): Settings {
  const dataDir = resolve(ROOT, env('ADOPS_DATA_DIR', 'data'));
  return {
    // 既定は「書き込みなし」。本番で ADOPS_DRY_RUN=false を明示したときだけ媒体に入稿する。
    dryRun: envBool('ADOPS_DRY_RUN', true),
    dataDir,
    configDir: resolve(ROOT, env('ADOPS_CONFIG_DIR', 'config')),
    anthropic: {
      apiKey: env('ANTHROPIC_API_KEY'),
      model: env('ADOPS_MODEL', 'claude-opus-5-5'),
      fastModel: env('ADOPS_FAST_MODEL', 'claude-sonnet-5-5'),
      effort: env('ADOPS_EFFORT', 'high') as Settings['anthropic']['effort'],
      maxUsdPerRun: Number(env('ADOPS_MAX_LLM_USD', '20')),
    },
    image: {
      provider: env('IMAGE_PROVIDER', 'mock') as ImageProviderKind,
      midjourney: {
        baseUrl: env('MJ_API_BASE_URL', 'https://api.piapi.ai'),
        apiKey: env('MJ_API_KEY'),
        flavor: env('MJ_API_FLAVOR', 'piapi') as 'piapi' | 'generic',
        params: env('MJ_PARAMS', '--v 7 --style raw'),
        videoEnabled: envBool('MJ_VIDEO_ENABLED', false),
      },
      inboxDir: resolve(ROOT, env('MJ_INBOX_DIR', 'data/inbox')),
      inbox: env('MJ_INBOX', 'local') as 'local' | 'drive',
      drive: { serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'), folderId: env('DRIVE_INBOX_FOLDER_ID') },
    },
    meta: {
      accessToken: env('META_ACCESS_TOKEN'),
      adAccountId: env('META_AD_ACCOUNT_ID').replace(/^act_/, ''),
      pageId: env('META_PAGE_ID'),
      instagramUserId: env('META_INSTAGRAM_USER_ID'),
      apiVersion: env('META_API_VERSION', 'v25.0'),
    },
    google: {
      developerToken: env('GOOGLE_ADS_DEVELOPER_TOKEN'),
      clientId: env('GOOGLE_ADS_CLIENT_ID'),
      clientSecret: env('GOOGLE_ADS_CLIENT_SECRET'),
      refreshToken: env('GOOGLE_ADS_REFRESH_TOKEN'),
      customerId: env('GOOGLE_ADS_CUSTOMER_ID').replaceAll('-', ''),
      loginCustomerId: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replaceAll('-', ''),
      apiVersion: env('GOOGLE_ADS_API_VERSION', 'v26'),
      conversionActionName: env('GOOGLE_ADS_CONVERSION_ACTION', ''),
    },
    slack: { webhookUrl: env('SLACK_WEBHOOK_URL') },
    fontPath: env('ADOPS_FONT_PATH', findJapaneseFont()),
  };
}

/** 画像に日本語を描くためのフォント。CI では fonts-noto-cjk を入れる前提。 */
function findJapaneseFont(): string {
  const candidates = [
    join(ROOT, 'assets/fonts/NotoSansJP-Black.ttf'),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ];
  return candidates.find((p) => existsSync(p)) ?? '';
}

export function isMetaConfigured(s: Settings): boolean {
  return Boolean(s.meta.accessToken && s.meta.adAccountId && s.meta.pageId);
}

export function isGoogleConfigured(s: Settings): boolean {
  const g = s.google;
  return Boolean(g.developerToken && g.clientId && g.clientSecret && g.refreshToken && g.customerId);
}

function readJson<T>(dir: string, file: string): T {
  const p = join(dir, file);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (e) {
    throw new Error(`設定ファイル ${p} を読めませんでした: ${(e as Error).message}`);
  }
}

export interface Catalog {
  jobs: Job[];
  personas: Persona[];
  brand: Brand;
  policy: Policy;
}

export function loadCatalog(configDir: string): Catalog {
  const catalog: Catalog = {
    jobs: readJson<Job[]>(configDir, 'jobs.json'),
    personas: readJson<Persona[]>(configDir, 'personas.json'),
    brand: readJson<Brand>(configDir, 'brand.json'),
    policy: readJson<Policy>(configDir, 'policy.json'),
  };
  validateCatalog(catalog);
  return catalog;
}

/** 設定ミスは実行前に止める（途中で失敗して半端に入稿されるのを防ぐ）。 */
export function validateCatalog(c: Catalog): void {
  const errors: string[] = [];
  const personaIds = new Set(c.personas.map((p) => p.id));
  const jobIds = new Set<string>();
  for (const j of c.jobs) {
    if (jobIds.has(j.id)) errors.push(`求人IDが重複しています: ${j.id}`);
    jobIds.add(j.id);
    if (!j.landingUrl?.startsWith('http')) errors.push(`${j.id}: landingUrl が URL ではありません`);
    if (!j.salary || !(j.salary.min > 0)) errors.push(`${j.id}: salary.min が未設定です（給与の明示は必須）`);
    for (const p of j.personas) if (!personaIds.has(p)) errors.push(`${j.id}: 未定義のペルソナ ${p}`);
    if (j.personas.length === 0) errors.push(`${j.id}: personas が空です`);
  }
  const p = c.policy;
  if (!(p.videoShare >= 0 && p.videoShare <= 1)) errors.push('policy.videoShare は 0〜1');
  if (!(p.exploreShare >= 0 && p.exploreShare <= 1)) errors.push('policy.exploreShare は 0〜1');
  if (!['draft', 'auto'].includes(p.autonomy)) errors.push('policy.autonomy は draft か auto');
  if (errors.length) throw new Error(`設定エラー:\n- ${errors.join('\n- ')}`);
}
