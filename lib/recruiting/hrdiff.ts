import { Application } from "@/types/recruiting";
import { CrossOptions, HrSheet, categoryOf, HR_CATEGORY_LABEL } from "./hrsheet";
import { normalizeShopKey } from "./shops";

/**
 * 「Excelの合格」と「ジョブオプの採用」の、片方にしか無い人を出す。
 *
 * 数の差だけ見せても「で、誰？」が分からないと確認に動けない。
 * ただし**氏名は取り込んでいない**（この画面はURLを知っていれば誰でも開けるため）。
 * 代わりに、ジョブオプ側は応募ID、Excel側は応募日と分野を出して、
 * 手元のジョブオプ・管理表で本人をたどれるようにする。
 *
 * 突き合わせの鍵は **校舎 ＋ 応募日**。両方に同じ日付の採用があれば一致とみなす。
 * 同じ日に複数いる場合は件数ぶんだけ一致させ、余ったほうを「片方にしか無い」に出す。
 * 応募日の書き方がずれている（管理表に手入力した日が1日違う等）と一致しないので、
 * そこは画面に断りを書いておく。
 */

export interface DiffRecord {
  side: "excel" | "jobop";
  /** YYYY-MM-DD。読めなかった行は null */
  receivedDate: string | null;
  /** ジョブオプ側。これでジョブオプの応募を開ける */
  applicationId?: string;
  /** ジョブオプ側のステータスと、その更新日 */
  statusName?: string;
  statusUpdatedAt?: string | null;
  /** Excel側の分野（IT / WEBDTP など、シートに書かれているまま） */
  course?: string;
  /** Excel側の分野を3区分に寄せたときの名前 */
  courseLabel?: string;
  /** Excel側のステータス（「合格」など） */
  status?: string;
}

export interface ShopHireDiff {
  key: string;
  /** 応募日で突き合わせて一致した件数 */
  matched: number;
  /** 片方にしか無い採用。応募日の古い順。 */
  only: DiffRecord[];
}

/**
 * 校舎ごとに、片方にしか無い採用を集める。
 * 期間・対象校舎の条件は crossTab と同じものを渡すこと（母数が変わると差の意味が変わる）。
 */
export function hireDiffDetail(
  sheet: HrSheet | null,
  options: CrossOptions,
  hires: Application[]
): Map<string, ShopHireDiff> {
  const { from = null, include } = options;
  const out = new Map<string, ShopHireDiff>();

  const entry = (key: string): ShopHireDiff => {
    let e = out.get(key);
    if (!e) {
      e = { key, matched: 0, only: [] };
      out.set(key, e);
    }
    return e;
  };

  /** 校舎ごとに、Excel側とジョブオプ側の採用を応募日で並べる */
  const excel = new Map<string, DiffRecord[]>();
  const jobop = new Map<string, DiffRecord[]>();

  if (sheet) {
    for (const r of sheet.rows) {
      if (!r.hired) continue;
      if (from && r.receivedDate && r.receivedDate < from) continue;
      const key = normalizeShopKey(r.shopShortName);
      if (include && !include(key)) continue;
      const list = excel.get(key) ?? [];
      list.push({
        side: "excel",
        receivedDate: r.receivedDate,
        course: r.course,
        courseLabel: HR_CATEGORY_LABEL[categoryOf(r)],
        status: r.status,
      });
      excel.set(key, list);
    }
  }

  for (const a of hires) {
    const key = normalizeShopKey(a.shopShortName);
    if (include && !include(key)) continue;
    const list = jobop.get(key) ?? [];
    list.push({
      side: "jobop",
      receivedDate: a.receivedDate,
      applicationId: a.applicationId,
      statusName: a.statusName,
      statusUpdatedAt: a.statusUpdatedAt,
    });
    jobop.set(key, list);
  }

  for (const key of new Set([...excel.keys(), ...jobop.keys()])) {
    const e = entry(key);
    const left = [...(excel.get(key) ?? [])];
    const right = [...(jobop.get(key) ?? [])];

    // 同じ応募日のものから先に消し込む
    for (const l of left.slice()) {
      const i = right.findIndex((r) => r.receivedDate === l.receivedDate);
      if (i >= 0) {
        right.splice(i, 1);
        left.splice(left.indexOf(l), 1);
        e.matched++;
      }
    }

    e.only = [...left, ...right].sort(
      (a, b) => (a.receivedDate ?? "").localeCompare(b.receivedDate ?? "") || a.side.localeCompare(b.side)
    );
  }

  return out;
}
