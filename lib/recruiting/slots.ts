/**
 * シフトの時間帯。
 *
 * 2つの表で呼び方が違うので、ここで1本にそろえる。
 * - 委託講師配置表の見出し … IT【平日】/ IT【夜】/ IT【土日】
 * - 採用管理表のW〜Y列 … 平日昼 / 平日夜 / 土日
 *
 * 「どのコースが足りないか」だけでは、平日夜しか入れない人を3人採っても
 * 土日のコマは埋まらない。コースと時間帯の両方で見るために分けて持つ。
 */
export const SLOTS = ["平日昼", "平日夜", "土日"] as const;

export type Slot = (typeof SLOTS)[number];

/** 配置表の見出しの書き方（IT【平日】の【】の中） */
export const SLOT_IN_SHEET: Record<Slot, string> = {
  平日昼: "平日",
  平日夜: "夜",
  土日: "土日",
};

/** 画面に出すときの短い名前 */
export const SLOT_LABEL: Record<Slot, string> = {
  平日昼: "平日昼",
  平日夜: "平日夜",
  土日: "土日",
};

export const zeroSlots = (): Record<Slot, number> => ({ 平日昼: 0, 平日夜: 0, 土日: 0 });
