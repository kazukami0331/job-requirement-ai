/**
 * 本番モード（DRY RUN なし）で、偽の媒体クライアントを使ってサイクルを通しで回す。
 * 入稿 → 状態同期 → 実績取り込み → 停止判断 → 媒体への停止反映 までがつながっていることを確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offlineLlm } from '../src/llm/offline.ts';
import { StateStore } from '../src/store/stateStore.ts';
import { MockProvider } from '../src/creative/imageProvider.ts';
import { makeCtx } from '../src/pipeline/context.ts';
import { runCycle } from '../src/pipeline/cycle.ts';
import { loadSettings } from '../src/config.ts';
import { catalog, job, policy } from './fixtures.ts';
import type { DailyMetric } from '../src/types.ts';

class FakeMeta {
  ads = new Map<string, { adset: string; status: string; creative: string }>();
  creatives = 0;
  imageUrls = new Map<string, string>();
  /** 広告 ID → 1日あたりの実績 */
  perf = new Map<string, Omit<DailyMetric, 'date' | 'platform'>>();
  async createCreative(): Promise<string> {
    return `cre_${++this.creatives}`;
  }
  async createAd(adset: string, creative: string, _name: string, active: boolean): Promise<string> {
    const id = `ad_${this.ads.size + 1}`;
    this.ads.set(id, { adset, status: active ? 'ACTIVE' : 'PAUSED', creative });
    return id;
  }
  async setAdStatus(id: string, status: string): Promise<void> {
    this.ads.get(id)!.status = status;
  }
  async adStatuses(ids: string[]) {
    return new Map(ids.map((id) => [id, { status: this.ads.get(id)?.status ?? 'DELETED' }]));
  }
  async getAdset(id: string) {
    return { id, dailyBudget: 10000, status: 'ACTIVE' };
  }
  async setAdsetDailyBudget(): Promise<void> {}
  async insights(ids: string[], since: string, until: string): Promise<Map<string, DailyMetric[]>> {
    const out = new Map<string, DailyMetric[]>();
    for (const id of ids) {
      const p = this.perf.get(id);
      if (!p || this.ads.get(id)?.status !== 'ACTIVE') continue;
      const rows: DailyMetric[] = [];
      for (let d = new Date(`${since}T00:00:00Z`); d.toISOString().slice(0, 10) <= until; d.setUTCDate(d.getUTCDate() + 1)) {
        rows.push({ date: d.toISOString().slice(0, 10), platform: 'meta', ...p });
      }
      out.set(id, rows);
    }
    return out;
  }
}

test('e2e: 入稿 → 人が ON → 実績取り込み → 悪い広告を自動停止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adops-e2e-'));
  const cat = catalog({
    jobs: [job({ dailyCreativeQuota: 2, placements: { meta: { adsetIds: ['as1'] } } })],
    policy: policy({ briefsPerCycle: 2, videoShare: 0, exploreShare: 0.5, autonomy: 'draft' }),
  });
  const meta = new FakeMeta();
  const ctx = makeCtx({
    settings: { ...loadSettings(), dataDir: dir, slack: { webhookUrl: '' } },
    catalog: cat,
    store: new StateStore(dir),
    llm: offlineLlm(cat),
    images: new MockProvider(),
    meta: meta as any,
    google: null,
    dryRun: false,
    cycleId: 'cy1',
    today: '2026-10-01',
  });

  // 1日目: 企画・制作・入稿（draft なので停止状態）
  const r1 = await runCycle(ctx);
  assert.ok(r1.steps.every((s) => s.ok), JSON.stringify(r1.steps));
  const published = ctx.store.creatives({ status: 'published' });
  assert.equal(published.length, 2);
  assert.ok([...meta.ads.values()].every((a) => a.status === 'PAUSED'));

  // 人が管理画面で2本とも ON にし、1本は好調・1本は応募ゼロで消化
  const [good, bad] = published;
  const goodAd = good.platformRefs.meta!.adIds[0];
  const badAd = bad.platformRefs.meta!.adIds[0];
  meta.ads.get(goodAd)!.status = 'ACTIVE';
  meta.ads.get(badAd)!.status = 'ACTIVE';
  meta.perf.set(goodAd, { impressions: 3000, clicks: 45, spend: 2000, conversions: 1 });
  meta.perf.set(badAd, { impressions: 3000, clicks: 30, spend: 3000, conversions: 0 });

  // 7日後: 実績取り込み → 停止判断（新しい企画は作らない）
  ctx.today = '2026-10-07';
  ctx.cycleId = 'cy2';
  const r2 = await runCycle(ctx, ['collect', 'optimize', 'report']);
  assert.ok(r2.steps.every((s) => s.ok), JSON.stringify(r2.steps));
  const s = ctx.store.state.creatives;
  assert.equal(s[good.id].live, true);
  assert.ok(s[good.id].metrics.length >= 6);
  assert.equal(s[bad.id].status, 'paused');
  assert.match(s[bad.id].statusReason!, /応募0件/);
  assert.equal(meta.ads.get(badAd)!.status, 'PAUSED');
  assert.equal(meta.ads.get(goodAd)!.status, 'ACTIVE');
  // draft モードなので予算は増やさない（提案のみ）
  assert.ok(ctx.store.state.decisions.every((d) => d.action !== 'scale_budget' || !d.applied));
});
