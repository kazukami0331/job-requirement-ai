/** 状態に記録された素材のパス（実行環境の絶対パス）から、管理画面で表示する URL を作る。 */
export function assetUrl(path: string | undefined): string | null {
  const m = /assets\/([\w.-]+\/[\w.-]+\.(?:jpg|jpeg|png))$/.exec(path ?? "");
  return m ? `/admin/asset/${m[1]}` : null;
}
