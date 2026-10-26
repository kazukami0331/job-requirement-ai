/**
 * 職種カテゴリ別の画像表現のヒント（Midjourney 用の英語）。
 * 企画エージェントに渡し、実在感のある日本の現場写真になるよう誘導する。
 * 当てはまるカテゴリが無ければ汎用のヒントを使う。
 */
const PRESETS: { match: RegExp; hint: string }[] = [
  {
    match: /製造|工場|組立|検査|加工/,
    hint: 'bright modern Japanese factory floor, worker in clean work uniform and cap with safety glasses, organized production line, soft overhead lighting, shallow depth of field',
  },
  {
    match: /物流|倉庫|ピッキング|仕分け|フォークリフト/,
    hint: 'spacious Japanese logistics warehouse with tall racks, worker in reflective vest and helmet, handheld scanner or forklift, morning light through high windows',
  },
  {
    match: /ドライバー|配送|運送|トラック/,
    hint: 'Japanese delivery truck on a calm suburban road in early morning, driver in neat uniform beside the cab, clear sky, sense of freedom and routine',
  },
  {
    match: /建設|施工|現場|土木|足場|設備/,
    hint: 'Japanese construction site with scaffolding and safety netting, worker wearing helmet, harness and work gloves, reviewing drawings with a colleague, golden hour light',
  },
  {
    match: /警備|交通誘導|施設警備/,
    hint: 'Japanese security guard in clean uniform at a modern building entrance, calm and trustworthy posture, daylight',
  },
  {
    match: /介護|福祉/,
    hint: 'warm Japanese care facility common room, caregiver in polo uniform smiling while talking with an elderly person, soft natural light',
  },
  {
    match: /清掃|ビルメンテ|クリーン/,
    hint: 'clean Japanese office building lobby, cleaning staff in tidy uniform with professional equipment, bright and orderly',
  },
];

const COMMON = 'photorealistic, candid documentary style, real Japanese people, natural expressions, 35mm lens, no text, no letters, no logos, no watermark';

export function visualHint(category: string, title = ''): string {
  const preset = PRESETS.find((p) => p.match.test(category) || p.match.test(title));
  return `${preset?.hint ?? 'Japanese workplace with worker in proper safety gear, clean and well-lit'}, ${COMMON}`;
}

/** 寮・住まい訴求のときは職場ではなく部屋を見せる。 */
export const HOUSING_HINT = 'tidy furnished Japanese one-room apartment with bed, desk, refrigerator and washing machine, bright natural light, welcoming and clean, no people or one person relaxing, no text';
