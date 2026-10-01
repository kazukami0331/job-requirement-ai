import { MergedApplication, Snapshot } from "@/types/recruiting";

/**
 * 複数週のスナップショットを串刺しにして、応募IDごとの最新状態＋ステータス変遷を作る。
 *
 * ジョブオプのエクスポートは「その時点で管理画面に出ている応募」しか含まないため、
 * 週次スナップショットを積み上げて和集合を取ることで、
 * 途中で一覧から落ちた応募も履歴として保持できる。
 */
export function mergeSnapshots(snapshots: Snapshot[]): MergedApplication[] {
  const ordered = [...snapshots].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const byId = new Map<string, MergedApplication>();

  for (const snap of ordered) {
    for (const app of snap.applications) {
      const existing = byId.get(app.applicationId);
      if (!existing) {
        byId.set(app.applicationId, {
          ...app,
          firstSeenAt: snap.takenAt,
          statusHistory: [
            { observedAt: snap.takenAt, statusId: app.statusId, statusName: app.statusName },
          ],
        });
        continue;
      }

      const last = existing.statusHistory[existing.statusHistory.length - 1];
      if (last.statusId !== app.statusId) {
        existing.statusHistory.push({
          observedAt: snap.takenAt,
          statusId: app.statusId,
          statusName: app.statusName,
        });
      }
      // 新しいスナップショットの内容で最新状態を上書きする
      Object.assign(existing, app, {
        firstSeenAt: existing.firstSeenAt,
        statusHistory: existing.statusHistory,
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/**
 * 直近スナップショットとその1つ前を比べて、ステータスが動いた応募を返す。
 * 「今週の選考の動き」を出すのに使う。
 */
export function statusMovements(
  apps: MergedApplication[],
  sinceIso: string
): { app: MergedApplication; from: string; to: string }[] {
  const moved: { app: MergedApplication; from: string; to: string }[] = [];
  for (const app of apps) {
    const h = app.statusHistory;
    for (let i = 1; i < h.length; i++) {
      if (h[i].observedAt > sinceIso) {
        moved.push({ app, from: h[i - 1].statusName, to: h[i].statusName });
        break;
      }
    }
  }
  return moved;
}
