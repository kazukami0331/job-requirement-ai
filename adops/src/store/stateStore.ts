import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Creative, CreativeStatus, State } from '../types.ts';

export function emptyState(): State {
  return { version: 1, briefs: {}, reviews: [], creatives: {}, insights: [], decisions: [], cycles: [], llmUsage: [] };
}

/**
 * 状態は1つの JSON ファイルにまとめる。量が少ない（1日数十件）ので DB は使わず、
 * GitHub Actions では state ブランチに commit して次回に引き継ぐ。
 */
export class StateStore {
  readonly dir: string;
  readonly path: string;
  state: State;

  constructor(dataDir: string) {
    this.dir = dataDir;
    this.path = join(dataDir, 'state.json');
    mkdirSync(dataDir, { recursive: true });
    this.state = existsSync(this.path) ? { ...emptyState(), ...JSON.parse(readFileSync(this.path, 'utf8')) } : emptyState();
  }

  /** 途中で落ちても壊れたファイルを残さないよう、一時ファイル経由で置き換える。 */
  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  assetDir(creativeId: string): string {
    const d = join(this.dir, 'assets', creativeId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  creatives(filter?: { status?: CreativeStatus | CreativeStatus[]; jobId?: string }): Creative[] {
    const statuses = filter?.status === undefined ? null : new Set([filter.status].flat());
    return Object.values(this.state.creatives).filter(
      (c) => (!statuses || statuses.has(c.status)) && (!filter?.jobId || c.jobId === filter.jobId),
    );
  }

  setStatus(c: Creative, status: CreativeStatus, reason?: string): void {
    c.status = status;
    c.statusReason = reason;
    c.updatedAt = new Date().toISOString();
  }

  /** 古いレビュー・使用量ログは肥大化するので一定件数で切る（集計済みの数値は creatives に残る）。 */
  compact(limits = { reviews: 2000, llmUsage: 5000, decisions: 3000, cycles: 400, insights: 200 }): void {
    const s = this.state;
    s.reviews = s.reviews.slice(-limits.reviews);
    s.llmUsage = s.llmUsage.slice(-limits.llmUsage);
    s.decisions = s.decisions.slice(-limits.decisions);
    s.cycles = s.cycles.slice(-limits.cycles);
    s.insights = s.insights.slice(-limits.insights);
  }
}
