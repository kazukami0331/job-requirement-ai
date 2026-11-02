/**
 * 管理画面から GitHub を読み書きする（サーバー側だけで使う）。
 * - 設定ファイル（adops/config/*.json）は main ブランチ（ADOPS_CONFIG_BRANCH）に直接コミットする。次の定期実行から反映される
 * - 状態（state.json）は adops-state ブランチから読むだけ
 * - LP の公開・緊急停止・今すぐ実行は、GitHub Actions のワークフローを起動して行う（Slack のコマンドと同じ）
 *
 * 必要な環境変数（Vercel）:
 *   ADOPS_GITHUB_TOKEN   Contents: Read and write と Actions: Read and write の権限を持つトークン（fine-grained 推奨）
 *   ADOPS_GITHUB_REPO    owner/repo
 *   ADOPS_CONFIG_BRANCH  設定を保存するブランチ（既定 ADOPS_GITHUB_REF、なければ main）
 *   ADOPS_STATE_BRANCH   既定 adops-state
 */
const API = () => (process.env.ADOPS_GITHUB_API || "https://api.github.com").replace(/\/$/, "");

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function env() {
  const repo = process.env.ADOPS_GITHUB_REPO;
  const token = process.env.ADOPS_GITHUB_TOKEN;
  if (!repo || !token) throw new GitHubError(500, "ADOPS_GITHUB_REPO / ADOPS_GITHUB_TOKEN が未設定です（Vercel の環境変数）");
  return { repo, token };
}

export const configBranch = () => process.env.ADOPS_CONFIG_BRANCH || process.env.ADOPS_GITHUB_REF || "main";
export const stateBranch = () => process.env.ADOPS_STATE_BRANCH || "adops-state";

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const { repo, token } = env();
  return fetch(`${API()}/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
    cache: "no-store",
  });
}

/** ファイルの中身と sha（更新時の衝突検知に使う）。無ければ null。 */
export async function readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
  const res = await gh(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(res.status, `GitHub から ${path} を読めませんでした（${res.status}）`);
  const j = (await res.json()) as { content?: string; sha: string; encoding?: string; download_url?: string };
  // 1MB を超えるファイルは content が空で返るので、raw で取り直す
  if (!j.content && j.download_url) {
    const raw = await gh(`/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers: { accept: "application/vnd.github.raw" } });
    return { text: await raw.text(), sha: j.sha };
  }
  return { text: Buffer.from(j.content ?? "", "base64").toString("utf8"), sha: j.sha };
}

/** ファイルを保存する（sha が違えば＝誰かが先に更新していれば失敗させる）。 */
export async function writeFile(path: string, text: string, sha: string | undefined, message: string, branch: string): Promise<void> {
  const res = await gh(`/contents/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(text, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) }),
  });
  if (res.status === 409 || res.status === 422) throw new GitHubError(res.status, "ほかの人（または定期実行）が先に更新しました。画面を読み込み直してから、もう一度保存してください");
  if (!res.ok) throw new GitHubError(res.status, `GitHub に保存できませんでした（${res.status}）。トークンに Contents の書き込み権限があるか確認してください`);
}

/** adops のワークフローがすでに待ち行列にあるか（あれば、その実行が始まるときに最新の依頼を取り込む）。 */
export async function hasQueuedRun(): Promise<boolean> {
  for (const status of ["queued", "pending", "waiting"]) {
    const res = await gh(`/actions/workflows/adops.yml/runs?status=${status}&per_page=1`);
    if (!res.ok) return false;
    const j = (await res.json()) as { total_count?: number };
    if ((j.total_count ?? 0) > 0) return true;
  }
  return false;
}

/** adops のワークフローを起動する（LP の公開・緊急停止・今すぐ実行）。 */
export async function dispatch(inputs: Record<string, string>): Promise<void> {
  const res = await gh(`/actions/workflows/adops.yml/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: configBranch(), inputs }),
  });
  if (!res.ok) throw new GitHubError(res.status, `ワークフローを起動できませんでした（${res.status}）。トークンに Actions の書き込み権限があるか確認してください`);
}
