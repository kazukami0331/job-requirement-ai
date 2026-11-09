# 求人要件ヒアリングAI

RAが人事担当者に募集求人の要件を聞き出すための対話型サービスです。AIからの質問に答えるだけで、採用背景や求める人材などを言語化できます。

> このリポジトリにはもう1つ、応募書類の自動判定（Gmail → Google ドライブ → Claude → 通知）を行う
> Google Apps Script が `gas/` に入っています。セットアップ手順は [gas/README.md](gas/README.md) を参照してください。

## 機能

- **対話型ヒアリング**: AIが順番に質問を投げかけ、回答を収集
- **自動求人票生成**: 回答内容から求人要件を自動でフォーマット
- **リアルタイムプレビュー**: 回答に応じてアウトプットが自動更新
- **編集機能**: 生成された求人要件を直接編集可能
- **コピー機能**: ワンクリックで求人要件をクリップボードにコピー

## 技術スタック

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS

## セットアップ

```bash
# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いてください。

## デプロイ

Vercelにデプロイする場合:

1. Vercelにプロジェクトをインポート
2. ビルドコマンド: `npm run build`
3. フレームワークプリセット: Next.js

## 使い方

1. AIからの質問に順番に回答していきます
2. 回答が短い場合、AIが追質問をすることがあります
3. すべての質問に答えると、右側のアウトプット画面に求人要件が生成されます
4. 生成された求人要件を編集できます
5. 「コピー」ボタンで求人要件をクリップボードにコピーできます

## SwipeJob 候補者ダッシュボード（`/admin`）

SwipeJob（Supabase: `swipe-jobs-production`）のデータを読み取り専用で表示する管理画面です。

- `/admin` … 登録ユーザーの一覧（Like / Pass / 応募の件数、最終スワイプ日時、流入元）。検索・並び替えができます
- `/admin/users/[id]` … 候補者のプロフィール（希望条件・職歴・書類）と、スワイプ履歴（すべて / Like / Pass / 応募済）
- `/admin/jobs/[id]` … 求人の詳細（仕事内容・応募条件・給与・勤務地など）と、その求人をスワイプした人の一覧

`job_swipes.jobId` を `jobs.id` に結合して表示します。日時は日本時間（JST）で表示します。

### 環境変数（Vercel の Settings → Environment Variables）

| 変数 | 内容 |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の Project Settings → API Keys にある service_role（または Secret key） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `/admin` に入るための Basic 認証の ID とパスワード（未設定だと誰も入れません） |

service_role キーはサーバー側でしか使わないため、ブラウザには出ません。
