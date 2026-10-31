import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    if (!existsSync(this.path)) {
      this.state = emptyState();
      return;
    }
    try {
      this.state = { ...emptyState(), ...JSON.parse(readFileSync(this.path, 'utf8')) };
    } catch (e) {
      // 壊れた状態ファイルは退避して止める（そのまま上書き保存して記録を失わないように）。復旧は adops-state-prev ブランチから
      renameSync(this.path, `${this.path}.corrupt`);
      throw new Error(`state.json が壊れています（${(e as Error).message}）。state.json.corrupt に退避しました。adops-state-prev ブランチの state.json で復旧してください`);
    }
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

  /** レポート用の小さなサムネイル（素材を掃除した後も残す）。 */
  thumbPath(creativeId: string): string {
    return join(this.dir, 'assets', creativeId, 'thumb.jpg');
  }

  /**
   * 入稿・停止・却下が済んだクリエイティブの素材ファイルを消し、サムネイルとフィード画像だけ残す。
   * 素材は媒体側に保管されるので、こちらに持ち続ける必要はない（state ブランチを小さく保つ）。
   */
  pruneAssets(inboxDir?: string, keepStatuses: CreativeStatus[] = ['planned', 'awaiting_images', 'produced']): number {
    let removed = 0;
    const keep = new Set(keepStatuses);
    const inbox = inboxDir && existsSync(inboxDir) ? readdirSync(inboxDir) : [];
    // 終わってから90日以上たった広告は、サムネイルも含めて消す（状態ブランチが際限なく大きくならないように）
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const terminal = new Set<CreativeStatus>(['retired', 'failed', 'rejected', 'qa_failed']);
    for (const c of Object.values(this.state.creatives)) {
      // 一部の媒体への入稿を再試行する予定のものも素材を残す
      if (keep.has(c.status) || (c.pendingPlatforms?.length && (c.publishRetries ?? 0) < 3)) continue;
      for (const f of inbox) {
        if (f.startsWith(`${c.id}_`)) {
          rmSync(join(inboxDir!, f), { recursive: true, force: true });
          removed++;
        }
      }
      const dir = join(this.dir, 'assets', c.id);
      if (!existsSync(dir)) continue;
      if (terminal.has(c.status) && c.updatedAt < old) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
        continue;
      }
      for (const f of readdirSync(dir)) {
        // サムネイルと、オーガニック投稿に転用できるフィード画像（4:5）は残す
        if (f === 'thumb.jpg' || f.endsWith('_4x5.jpg')) continue;
        rmSync(join(dir, f), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
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
    if (s.memos) s.memos = s.memos.slice(-52);
  }
}
