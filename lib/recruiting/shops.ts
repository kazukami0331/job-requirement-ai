import { PlanCategory } from "@/types/recruiting";

/** ジョブオプの店舗マスタ（shopシート）から取り込んだ校舎一覧 */
export interface Shop {
  shopId: string;
  /** ブランド込みの正式名 */
  name: string;
  /** 「Winスクール 」を除いた短縮名。採用計画側のキーに使う。 */
  short: string;
}

export const SHOP_MASTER: Shop[] = [
  { shopId: "603064", name: "Winスクール 札幌駅前校", short: "札幌駅前校" },
  { shopId: "1106547", name: "Winスクール 仙台駅前校", short: "仙台駅前校" },
  { shopId: "1106577", name: "Winスクール つくば校", short: "つくば校" },
  { shopId: "1106570", name: "Winスクール 水戸校", short: "水戸校" },
  { shopId: "1106583", name: "Winスクール 宇都宮校", short: "宇都宮校" },
  { shopId: "752682", name: "Winスクール 高崎校", short: "高崎校" },
  { shopId: "988923", name: "Winスクール 大宮校", short: "大宮校" },
  { shopId: "948780", name: "Winスクール 千葉校", short: "千葉校" },
  { shopId: "1106565", name: "Winスクール 船橋駅前校", short: "船橋駅前校" },
  { shopId: "1106568", name: "Winスクール 柏校", short: "柏校" },
  { shopId: "1106562", name: "Winスクール 北千住校", short: "北千住校" },
  { shopId: "948779", name: "Winスクール 秋葉原校", short: "秋葉原校" },
  { shopId: "598776", name: "Winスクール 新宿校", short: "新宿校" },
  { shopId: "598774", name: "Winスクール 渋谷校", short: "渋谷校" },
  { shopId: "598772", name: "Winスクール 町田校", short: "町田校" },
  { shopId: "598765", name: "Winスクール 銀座校", short: "銀座校" },
  { shopId: "1106558", name: "Winスクール 立川校", short: "立川校" },
  { shopId: "603063", name: "Winスクール 池袋校", short: "池袋校" },
  { shopId: "713883", name: "Winスクール 横浜校", short: "横浜校" },
  { shopId: "598764", name: "Winスクール 藤沢校", short: "藤沢校" },
  { shopId: "756713", name: "Winスクール 金沢アピタ校", short: "金沢アピタ校" },
  { shopId: "1106587", name: "Winスクール 静岡校", short: "静岡校" },
  { shopId: "1106585", name: "Winスクール 浜松校", short: "浜松校" },
  { shopId: "756711", name: "Winスクール 豊田校", short: "豊田校" },
  { shopId: "814617", name: "Winスクール 名古屋駅前校", short: "名古屋駅前校" },
  { shopId: "1106584", name: "Winスクール 栄校", short: "栄校" },
  { shopId: "1106627", name: "Winスクール 四日市校", short: "四日市校" },
  { shopId: "1106630", name: "Winスクール 草津校", short: "草津校" },
  { shopId: "1016814", name: "Winスクール 全国採用窓口", short: "全国採用窓口" },
  { shopId: "1106628", name: "Winスクール 四条校", short: "四条校" },
  { shopId: "598778", name: "Winスクール 京都駅前校", short: "京都駅前校" },
  { shopId: "756716", name: "Winスクール 天王寺校", short: "天王寺校" },
  { shopId: "948778", name: "Winスクール 梅田校", short: "梅田校" },
  { shopId: "948781", name: "Winスクール なんば校", short: "なんば校" },
  { shopId: "948783", name: "Winスクール 神戸三宮校", short: "神戸三宮校" },
  { shopId: "1106629", name: "Winスクール 姫路イオンタウン校", short: "姫路イオンタウン校" },
  { shopId: "1106633", name: "Winスクール 岡山校", short: "岡山校" },
  { shopId: "1106631", name: "Winスクール 広島本校", short: "広島本校" },
  { shopId: "1106634", name: "Winスクール 松山校", short: "松山校" },
  { shopId: "814614", name: "Winスクール 北九州小倉校", short: "北九州小倉校" },
  { shopId: "598779", name: "Winスクール 福岡天神校", short: "福岡天神校" },
  { shopId: "756715", name: "Winスクール 熊本水前寺校", short: "熊本水前寺校" },
  { shopId: "1106635", name: "Winスクール 鹿児島中央駅前校", short: "鹿児島中央駅前校" },
  { shopId: "612404", name: "ピーシーアシスト株式会社 六本木オフィス", short: "六本木オフィス" },
  { shopId: "598763", name: "ピーシーアシスト株式会社 新宿本校", short: "新宿本校" },
  { shopId: "889609", name: "ピーシーアシスト株式会社 京都本部", short: "京都本部" },
  { shopId: "949809", name: "ピーシーアシスト株式会社 大阪事務所", short: "大阪事務所" },
];

/** 講座区分。採用計画は 校舎 × この区分 で管理する。 */
export const PLAN_CATEGORIES: PlanCategory[] = ["IT", "D/W", "C"];

export const CATEGORY_LABEL: Record<PlanCategory, string> = {
  IT: "IT",
  "D/W": "デザイン/Web",
  C: "CAD",
};

const BY_SHORT = new Map(SHOP_MASTER.map((s) => [s.short, s]));
const BY_ID = new Map(SHOP_MASTER.map((s) => [s.shopId, s]));

export function findShopByShort(short: string): Shop | undefined {
  return BY_SHORT.get(short.trim());
}

export function findShopById(shopId: string): Shop | undefined {
  return BY_ID.get(shopId.trim());
}

/**
 * 採用計画側の校舎名と応募データ側の校舎名を突き合わせる。
 * 計画側が「北千住」、応募データ側が「北千住校」のように
 * 「校」の有無で揺れることがあるため、そこを吸収する。
 */
export function normalizeShopKey(name: string): string {
  return name.trim().replace(/[\s\u3000]/g, "").replace(/校$/, "");
}
