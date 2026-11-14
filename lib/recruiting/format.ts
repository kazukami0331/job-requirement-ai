/**
 * 割合の表示。
 *
 * 四捨五入すると、1件あるのに 0%、全部ではないのに 100% と出てしまう。
 * 件数と並べて出す場所ではこれが嘘に見えるので、両端だけ「1%未満」「99%超」に寄せる。
 */
export function ratioLabel(value: number, total: number): string {
  if (total <= 0) return "—";
  const r = (value / total) * 100;
  const rounded = Math.round(r);
  if (rounded === 0 && value > 0) return "1%未満";
  if (rounded === 100 && value < total) return "99%超";
  return `${rounded}%`;
}
