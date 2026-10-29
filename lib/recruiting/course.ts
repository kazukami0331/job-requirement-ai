/**
 * 応募がどのコースの求人から来たかを、ジョブオプの職種名から判定する。
 *
 * 2026年9月末に、3コースをまとめていた求人を CAD / Webデザイン / プログラミング に分けた。
 * 分けたあとの求人は職種名が「パソコンスクール講師（Webデザイン）」のようになっているので、
 * そこからコースを取れる。日付ではなく求人そのもので判定する
 * （旧求人は分けたあとも掲載が残っていて応募が来ているため）。
 *
 * **新しい求人が増えたら、ここに足す。** 足し忘れると「その他」に積み上がるだけで、
 * 画面上は「コースが分からない応募」に見えてしまう。
 * 何が「その他」に入っているかは職種名ごとに画面に出しているので、そこを見て足す。
 */

/** 表に出すときのコース名。先頭3つは不足人数マスタの区分と同じ並びにする。 */
export const JOB_COURSES = ["IT", "Python", "Webデザイン", "CAD", "事務"] as const;

export type JobCourse = (typeof JOB_COURSES)[number];

/**
 * どのコースにも当てはまらない求人。
 *
 * 中身は2種類ある。
 * - 3コースをまとめていた頃の求人（「パソコンスクール講師」など）
 * - 講師以外の求人（人事・採用担当、マネージャーなど）
 *
 * どちらも推測でコースに割り振らず、そのまま1つに置く。
 */
export const OTHER_COURSE = "その他";

/**
 * 職種名からコースを取る。当てはまらない求人は OTHER_COURSE を返す。
 *
 * 職種名の付け方が変わっても拾えるよう、括弧の中だけでなく名前全体を見る。
 * 「WEBDTP」のような書き方も Webデザイン に寄せる（採用管理表の分野と同じ寄せ方）。
 *
 * 判定の順番に意味がある。
 * - CAD を最初に見る（「CAD・Web」のような名前で取り違えないため）
 * - Python は IT より先（プログラミングの求人だが、行は分けて出す）
 * - 事務 は IT より先（「事務」に OA のような広い語を入れると旧求人を巻き込むので、語は狭く取る）
 */
export function courseOfJobTitle(jobTitle: string): JobCourse | typeof OTHER_COURSE {
  const t = jobTitle.replace(/[\s　]/g, "").toUpperCase();

  if (t.includes("CAD")) return "CAD";
  if (t.includes("PYTHON")) return "Python";
  if (/WEB|デザイン|DTP|映像/.test(t)) return "Webデザイン";
  if (t.includes("事務")) return "事務";
  if (/プログラミング|プログラマ|IT|エンジニア/.test(t)) return "IT";

  return OTHER_COURSE;
}
