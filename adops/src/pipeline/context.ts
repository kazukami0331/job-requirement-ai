import type { Catalog, Settings } from '../config.ts';
import { isGoogleConfigured, isMetaConfigured } from '../config.ts';
import type { Llm } from '../llm/llm.ts';
import type { ImageProvider } from '../creative/imageProvider.ts';
import { MetaClient } from '../platforms/meta.ts';
import { GoogleAdsClient } from '../platforms/google.ts';
import type { StateStore } from '../store/stateStore.ts';
import { jstDate } from '../util/id.ts';
import type { CheckPage } from './landing.ts';

/** 各段階に渡す実行コンテキスト。外部依存はすべてここ経由にしてテストで差し替えられるようにする。 */
export interface Ctx {
  settings: Settings;
  catalog: Catalog;
  store: StateStore;
  llm: Llm;
  images: ImageProvider;
  meta: MetaClient | null;
  google: GoogleAdsClient | null;
  today: string;
  cycleId: string;
  /** 入稿・停止・予算変更などの「外部への書き込み」をしない */
  dryRun: boolean;
  /** 応募ページの死活監視に使う（未指定なら確認しない。テストでは差し替える） */
  checkPage?: CheckPage;
}

export function platformClients(settings: Settings): { meta: MetaClient | null; google: GoogleAdsClient | null } {
  return {
    meta: isMetaConfigured(settings) ? new MetaClient(settings.meta) : null,
    google: isGoogleConfigured(settings) ? new GoogleAdsClient(settings.google) : null,
  };
}

export function makeCtx(parts: Omit<Ctx, 'today' | 'cycleId'> & { today?: string; cycleId: string }): Ctx {
  return { ...parts, today: parts.today ?? jstDate() };
}
