/**
 * 応募がどのコースの求人から来たかを、ジョブオプの職種名から判定する。
 *
 * 2026年9月末に、3コースをまとめていた求人を CAD / Webデザイン / プログラミング に分けた。
 * 分けたあとの求人は職種名が「パソコンスクール講師（Webデザイン）」のようになっているので、
 * そこからコースを取れる。
 *
 * 分ける前の求人（「パソコンスクール講師」）はコースが分からない。
 * 推測で3つに割ると実態と違う数字になるので、「コース分け前」としてそのまま1つに置く。
 * 旧求人は分けたあとも数日は掲載が残っていて応募が来ているので、
 * 日付ではなく求人そのもので判定する。
 */

/** 表に出すときのコース名。不足人数マスタの区分と同じ並びにする。 */
export const JOB_COURSES = ["IT", "Webデザイン", "CAD"] as const;

export type JobCourse = (typeof JOB_COURSES)[number];

/** コース分け前の求人。推測で振り分けず、そのまま1つにまとめる。 */
export const BEFORE_SPLIT = "コース分け前";

/**
 * 職種名からコースを取る。分ける前の求人は BEFORE_SPLIT を返す。
 *
 * 職種名の付け方が変わっても拾えるよう、括弧の中だけでなく名前全体を見る。
 * 「WEBDTP」のような書き方も Webデザイン に寄せる（採用管理表の分野と同じ寄せ方）。
 */
export function courseOfJobTitle(jobTitle: string): JobCourse | typeof BEFORE_SPLIT {
  const t = jobTitle.replace(/[\s　]/g, "").toUpperCase();

  if (t.includes("CAD")) return "CAD";
  if (/WEB|デザイン|DTP|映像/.test(t)) return "Webデザイン";
  if (/プログラミング|プログラマ|IT|エンジニア/.test(t)) return "IT";

  return BEFORE_SPLIT;
}
