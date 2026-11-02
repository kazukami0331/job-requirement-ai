/** 管理画面のサーバーアクションの共通処理: 失敗したら理由を画面に出し、成功したらお知らせを出す。 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

function withMessage(path: string, key: "ok" | "error", msg: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(msg)}`;
}

/** fn が throw したら error で、成功したら ok のメッセージで path に戻る（redirect は try の外で呼ぶ）。 */
export async function act(path: string, okMessage: string, fn: () => Promise<string | void>, failPath = path): Promise<never> {
  let target: string;
  try {
    const msg = await fn();
    // 戻り先は管理画面の中だけ（外部への転送に使われないように）
    target = withMessage(typeof msg === "string" && /^\/admin(\/|$|\?)/.test(msg) ? msg : path, "ok", okMessage);
  } catch (e) {
    target = withMessage(failPath, "error", (e as Error).message);
  }
  revalidatePath("/admin", "layout");
  redirect(target);
}

/** 検証エラーの一覧を1つの例外にする。 */
export function assertValid(errors: string[]): void {
  if (errors.length) throw new Error(`保存できませんでした:\n・${errors.join("\n・")}`);
}
