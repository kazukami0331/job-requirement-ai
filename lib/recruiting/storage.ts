import { HiringPlan, Snapshot } from "@/types/recruiting";

/**
 * 週次スナップショットと採用計画をブラウザのIndexedDBに保存する。
 *
 * サーバーを立てずに運用を始められるようにこの形にしているが、
 * 保存先はブラウザごとなので、共有・バックアップはJSONの書き出し/読み込みで行う。
 */

const DB_NAME = "recruiting-monitor";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const SETTING_STORE = "settings";
const PLAN_KEY = "hiringPlan";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTING_STORE)) {
        db.createObjectStore(SETTING_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const req = run(transaction.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        transaction.oncomplete = () => db.close();
      })
  );
}

export async function listSnapshots(): Promise<Snapshot[]> {
  const all = await tx<Snapshot[]>(SNAPSHOT_STORE, "readonly", (s) => s.getAll() as IDBRequest<Snapshot[]>);
  return all.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await tx(SNAPSHOT_STORE, "readwrite", (s) => s.put(snapshot) as IDBRequest<IDBValidKey>);
}

export async function deleteSnapshot(id: string): Promise<void> {
  await tx(SNAPSHOT_STORE, "readwrite", (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

export async function clearSnapshots(): Promise<void> {
  await tx(SNAPSHOT_STORE, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>);
}

export async function loadPlan(): Promise<HiringPlan | null> {
  const plan = await tx<HiringPlan | undefined>(SETTING_STORE, "readonly", (s) => s.get(PLAN_KEY));
  return plan ?? null;
}

export async function savePlan(plan: HiringPlan): Promise<void> {
  await tx(SETTING_STORE, "readwrite", (s) => s.put(plan, PLAN_KEY) as IDBRequest<IDBValidKey>);
}

export async function deletePlan(): Promise<void> {
  await tx(SETTING_STORE, "readwrite", (s) => s.delete(PLAN_KEY) as unknown as IDBRequest<undefined>);
}

/** バックアップ・共有用のエクスポート形式 */
export interface Backup {
  version: 1;
  exportedAt: string;
  snapshots: Snapshot[];
  plan: HiringPlan | null;
}

export async function exportBackup(): Promise<Backup> {
  const [snapshots, plan] = await Promise.all([listSnapshots(), loadPlan()]);
  return { version: 1, exportedAt: new Date().toISOString(), snapshots, plan };
}

/**
 * 同梱してある初期データを、保存領域が空のときだけ読み込む。
 *
 * 保存先がブラウザごとなので、何もしないと初めて開いた人の画面は空になる。
 * すでに受け取っている分をアプリに同梱しておき、URLを開いた時点で中身が見える状態にする。
 * 一度でも取り込み・削除の操作をしたブラウザでは二度と入れない。
 */
const SEED_DONE_KEY = "seedLoaded";

export async function loadSeedIfEmpty(): Promise<boolean> {
  const done = await tx<boolean | undefined>(SETTING_STORE, "readonly", (s) => s.get(SEED_DONE_KEY));
  if (done) return false;

  const existing = await listSnapshots();
  if (existing.length > 0) {
    await tx(SETTING_STORE, "readwrite", (s) => s.put(true, SEED_DONE_KEY) as IDBRequest<IDBValidKey>);
    return false;
  }

  try {
    const res = await fetch("/seed/initial.json", { cache: "no-store" });
    if (!res.ok) return false;
    const backup: Backup = await res.json();
    if (backup?.version !== 1 || !Array.isArray(backup.snapshots)) return false;

    for (const snapshot of backup.snapshots) await saveSnapshot(snapshot);
    if (backup.plan) await savePlan(backup.plan);
    await tx(SETTING_STORE, "readwrite", (s) => s.put(true, SEED_DONE_KEY) as IDBRequest<IDBValidKey>);
    return backup.snapshots.length > 0;
  } catch {
    // 初期データが無くても空の状態で使えればよいので、失敗は握りつぶす
    return false;
  }
}

/**
 * 公開データの取り込み。
 *
 * 公開された時刻を覚えておき、同じものを二度入れない。
 * 取り込みは上書きではなく追加なので、まだ公開していない手元の週は消えない。
 */
const SHARED_AT_KEY = "sharedAt";

export async function getSharedAt(): Promise<string | null> {
  return (await tx<string | undefined>(SETTING_STORE, "readonly", (s) => s.get(SHARED_AT_KEY))) ?? null;
}

export async function setSharedAt(publishedAt: string): Promise<void> {
  await tx(SETTING_STORE, "readwrite", (s) => s.put(publishedAt, SHARED_AT_KEY) as IDBRequest<IDBValidKey>);
}

/** 公開データが手元のものより新しければ取り込む。入れたらtrue。 */
export async function applyShared(data: Backup, publishedAt: string): Promise<boolean> {
  if ((await getSharedAt()) === publishedAt) return false;
  await importBackup(data);
  await setSharedAt(publishedAt);
  await markSeedLoaded();
  return true;
}

/**
 * 按分する期間の選択。
 *
 * 選ばずにおくと既定（当月〜一番遅い期限）になり、月が変わるたびに
 * 月ごとの目標が割り直される。経営会議に出す計画はそれでは困るので、
 * 一度選んだ期間はこのブラウザに覚えさせて、開き直しても変わらないようにする。
 */
const GOAL_WINDOW_KEY = "goalWindow";

export async function loadGoalWindow(): Promise<{ from: string; to: string } | null> {
  return (
    (await tx<{ from: string; to: string } | undefined>(SETTING_STORE, "readonly", (s) => s.get(GOAL_WINDOW_KEY))) ??
    null
  );
}

export async function saveGoalWindow(window: { from: string; to: string }): Promise<void> {
  await tx(SETTING_STORE, "readwrite", (s) => s.put(window, GOAL_WINDOW_KEY) as IDBRequest<IDBValidKey>);
}

/** 初期データを読み込み済みにして、以後の自動読み込みを止める */
export async function markSeedLoaded(): Promise<void> {
  await tx(SETTING_STORE, "readwrite", (s) => s.put(true, SEED_DONE_KEY) as IDBRequest<IDBValidKey>);
}

/** バックアップを取り込む。同じIDのスナップショットは上書きする。 */
export async function importBackup(backup: Backup): Promise<{ snapshots: number }> {
  if (backup?.version !== 1 || !Array.isArray(backup.snapshots)) {
    throw new Error("対応していないバックアップ形式です");
  }
  for (const snapshot of backup.snapshots) await saveSnapshot(snapshot);
  if (backup.plan) await savePlan(backup.plan);
  return { snapshots: backup.snapshots.length };
}
