import { ShopCourseMatrix } from "./aggregate";
import { BEFORE_SPLIT, JobCourse } from "./course";
import { HR_CATEGORIES, HrCategory, HrCross, HrTargets } from "./hrsheet";
import { PLAN_CATEGORIES, SHOP_MASTER, normalizeShopKey } from "./shops";

/**
 * 校舎 × コースの「応募」と「採用」を1つの表にまとめる。
 *
 * 2つを別の表にすると、「不足しているコースが埋まっていない」ことと
 * 「そのコースに応募が来ていない」ことを目で往復しないと結び付けられない。
 * 知りたいのは常に組みなので、同じ行・同じコースの隣に置く。
 *
 * ただし**出どころが違う**。隠すと数字を読み違えるので、列の見出しにも書く。
 *
 * - 応募 … ジョブオプ。コースは求人の職種名から判定するので、
 *   コース分け後の求人からの応募しかコース別に数えられない（分け前は「コース不明」）。
 * - 採用 … 採用チームのExcel。分野の列があるので全期間をコース別に数えられる。
 * - 目標 … 不足人数管理表。不足のあるコースに1名ずつ。
 *
 * 期間が違うので、コース分け前に応募した人が採用されていると
 * そのコースは「応募より採用のほうが多い」状態になりうる。これは誤りではない。
 */

/** ジョブオプのコース名と採用管理表の区分を、1本の列にそろえる */
const CATEGORY_OF_COURSE: Record<JobCourse, HrCategory> = {
  IT: "IT",
  Webデザイン: "D/W",
  CAD: "C",
};

/** 店舗マスタに当たる校舎は正式な略称にそろえる（「福岡天神」と「福岡天神校」を1行にする） */
const MASTER_BY_KEY = new Map(SHOP_MASTER.map((s) => [normalizeShopKey(s.short), s.short]));

export interface CourseFillCell {
  /** ジョブオプの応募数。「コース不明」の列はコース分け前の求人からの応募。 */
  applied: number;
  /** 採用チームのExcelの採用数。「コース不明」の列は分野が未記入の採用。 */
  hired: number;
  /** 不足人数管理表の目標。管理表に無い校舎と「コース不明」は null。 */
  target: number | null;
}

export interface CourseFillRow {
  key: string;
  shopShortName: string;
  /** IT / D/W / C と、どちらの側でもコースが分からない分（none） */
  byCourse: Record<HrCategory, CourseFillCell>;
  /** 校舎の合計。目標はコース別の目標の積み上げ（不足のあるコースに1名）。 */
  total: CourseFillCell;
  /** コース別の目標に対して、まだ埋まっていない数。並び順に使う。 */
  remaining: number;
}

export interface CourseFill {
  /** 「コース不明」を除いた列。IT / D/W / C。 */
  courses: HrCategory[];
  rows: CourseFillRow[];
  totalRow: CourseFillRow;
  /** 採用管理表（Excel）が入っているか。入っていなければ採用の列は空になる。 */
  hasHires: boolean;
  hasTargets: boolean;
}

const emptyCell = (): CourseFillCell => ({ applied: 0, hired: 0, target: null });

const emptyCourses = (): Record<HrCategory, CourseFillCell> => ({
  IT: emptyCell(),
  "D/W": emptyCell(),
  C: emptyCell(),
  none: emptyCell(),
});

/**
 * 行は3つの出どころの和集合にする。
 * 不足人数管理表にしか無い校舎（目標はあるが応募も採用も無い）がいちばん困っているので、
 * 落とすと表の意味が無くなる。
 */
export function courseFill(
  matrix: ShopCourseMatrix,
  cross: HrCross | null,
  targets: HrTargets | null
): CourseFill {
  const rows = new Map<string, CourseFillRow>();

  const row = (key: string, fallbackName: string): CourseFillRow => {
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        shopShortName: MASTER_BY_KEY.get(key) ?? fallbackName,
        byCourse: emptyCourses(),
        total: emptyCell(),
        remaining: 0,
      };
      rows.set(key, r);
    }
    return r;
  };

  for (const m of matrix.rows) {
    const r = row(normalizeShopKey(m.shopShortName), m.shopShortName);
    for (const [course, n] of Object.entries(m.byCourse)) {
      const cat = course === BEFORE_SPLIT ? "none" : CATEGORY_OF_COURSE[course as JobCourse];
      if (cat) r.byCourse[cat].applied += n;
    }
    r.total.applied += m.applied;
  }

  if (cross) {
    for (const s of cross.shops) {
      const r = row(s.key, s.shopShortName);
      for (const c of HR_CATEGORIES) r.byCourse[c].hired += s.byCategory[c];
      r.total.hired += s.total;
    }
  }

  if (targets) {
    for (const [key, t] of targets.byShop) {
      const r = row(key, t.shopShortName);
      for (const c of PLAN_CATEGORIES) r.byCourse[c].target = t.byCategory[c];
      r.total.target = t.minHires;
    }
  }

  for (const r of rows.values()) {
    r.remaining = PLAN_CATEGORIES.reduce(
      (a, c) => a + Math.max(0, (r.byCourse[c].target ?? 0) - r.byCourse[c].hired),
      0
    );
  }

  /**
   * 既定の並びは「埋まっていない枠が多く、応募も来ていない校舎」から。
   * 目標を入れていないときは残りが全校舎0になるので、応募の少ない順になる。
   */
  const list = [...rows.values()].sort(
    (a, b) =>
      b.remaining - a.remaining ||
      a.total.applied - b.total.applied ||
      a.shopShortName.localeCompare(b.shopShortName, "ja")
  );

  const totalRow: CourseFillRow = {
    key: "(合計)",
    shopShortName: "合計",
    byCourse: emptyCourses(),
    total: emptyCell(),
    remaining: 0,
  };
  const add = (into: CourseFillCell, from: CourseFillCell) => {
    into.applied += from.applied;
    into.hired += from.hired;
    // 目標が無い校舎（管理表に載っていない）を0として足すと分母が増えてしまうので、ある行だけ足す
    if (from.target !== null) into.target = (into.target ?? 0) + from.target;
  };
  for (const r of list) {
    for (const c of HR_CATEGORIES) add(totalRow.byCourse[c], r.byCourse[c]);
    add(totalRow.total, r.total);
    totalRow.remaining += r.remaining;
  }

  return {
    courses: PLAN_CATEGORIES,
    rows: list,
    totalRow,
    hasHires: cross !== null,
    hasTargets: targets !== null,
  };
}
