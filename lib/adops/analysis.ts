/**
 * 管理画面の分析: どの要素（仮説・訴求・モチーフ・テイスト・コピーの型・レイアウト）が効いたか、
 * 採点（項目別）が高い広告ほど実際に反応が良いか、を配信結果から集計する。
 * 他のファイルを読み込まない（node --test で単体で試せるように）。
 */
export interface Row {
  key: string;
  ads: number;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  ctr: number;
  cvr: number;
  cpa: number | null;
}

type C = { briefId: string; metrics?: { date: string; impressions: number; clicks: number; spend: number; conversions: number }[]; review?: { score: number; scores: Record<string, number> } };

export function summarize(key: string, cs: C[], since: string): Row {
  const ms = cs.flatMap((c) => (c.metrics ?? []).filter((m) => m.date >= since));
  const t = ms.reduce((a, m) => ({ i: a.i + m.impressions, c: a.c + m.clicks, s: a.s + m.spend, v: a.v + m.conversions }), { i: 0, c: 0, s: 0, v: 0 });
  return { key, ads: cs.length, impressions: t.i, clicks: t.c, spend: t.s, conversions: t.v, ctr: t.i ? (t.c / t.i) * 100 : 0, cvr: t.c ? (t.v / t.c) * 100 : 0, cpa: t.v ? t.s / t.v : null };
}

/** 値ごとにまとめて、表示回数の多い順に並べる（配信の無い広告は数えない）。 */
export function groupBy<T extends C>(cs: T[], keyOf: (c: T) => string | undefined, since: string): Row[] {
  const m = new Map<string, T[]>();
  for (const c of cs) {
    if (!(c.metrics ?? []).some((x) => x.date >= since && x.impressions > 0)) continue;
    const k = keyOf(c);
    if (!k) continue;
    m.set(k, [...(m.get(k) ?? []), c]);
  }
  return [...m].map(([k, list]) => summarize(k, list, since)).sort((a, b) => b.impressions - a.impressions);
}

/** 採点の項目ごとに、点数の帯（1〜2 / 3 / 4〜5）別の反応。高い点の帯ほど反応が良ければ、その項目は当たっている。 */
export function rubricCalibration(cs: C[], itemIds: string[], since: string): { id: string; rows: Row[] }[] {
  const band = (s: number) => (s <= 2 ? "1〜2点" : s === 3 ? "3点" : "4〜5点");
  return itemIds.map((id) => ({ id, rows: groupBy(cs.filter((c) => c.review?.scores[id] !== undefined), (c) => band(c.review!.scores[id]), since).sort((a, b) => a.key.localeCompare(b.key)) }));
}
