"use client";

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900">
      <p className="mb-2 font-semibold">読み込めませんでした</p>
      <p className="mb-4">
        GitHub に接続できないか、設定ファイルの形が正しくない可能性があります。Vercel の環境変数（ADOPS_GITHUB_REPO・ADOPS_GITHUB_TOKEN）と、トークンの権限（Contents と Actions の読み書き）を確認してください。
      </p>
      <button onClick={reset} className="rounded-lg border border-red-300 bg-white px-4 py-2 font-semibold">
        もう一度読み込む
      </button>
    </div>
  );
}
