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

## SwipeJob 顧客管理（`/admin`）

SwipeJob（Supabase: `swipe-jobs-production`）の候補者を管理する画面です。

- `/admin` … 候補者一覧（ステータス・担当・架電回数・最終連絡・Like / Pass / 応募）。検索・ステータス / 担当で絞り込み
- `/admin/users/[id]` … プロフィール、ステータスと担当の変更、架電・メモの記録と履歴、スワイプ履歴
- `/admin/jobs/[id]` … 求人の詳細と、その求人をスワイプした人
- `/admin/analytics` … 登録→初回架電のリードタイム、接続率、つながるまでの架電回数、ステータス別の到達人数と日数、担当者別、時間帯別の接続率
- `/admin/staff` … メンバー一覧、招待リンクの発行、自分の名前・アイコン色・パスワードの変更

対象は `ADMIN_SCOPE_START`（既定 2026-10-01、JST）以降に登録したユーザーです。

### 初回セットアップ

1. Supabase の SQL Editor で [`supabase/crm.sql`](supabase/crm.sql) を実行する（`crm_` で始まるテーブルを追加。既存テーブルは変更しない）
2. `/admin` を開き「管理者アカウントを作る」→ 合言葉に `ADMIN_PASSWORD` の値を入れて、自分のアカウントを作る
3. メンバー画面で招待リンクを作り、他のメンバーに送る（1 回だけ・7 日間有効）

### 環境変数（Vercel の Settings → Environment Variables）

| 変数 | 内容 |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の Project Settings → API Keys →「Secret keys」の `sb_secret_...` |
| `ADMIN_PASSWORD` | 最初の管理者アカウントを作るときの合言葉（作成後は使わない） |
| `ADMIN_SCOPE_START`（任意） | この日（JST）以降に登録したユーザーだけを表示。未設定なら `2026-10-01` |
| `SESSION_SECRET`（任意） | ログイン Cookie の署名用。未設定なら Secret key から作る |

Secret key はサーバー側でしか使わないため、ブラウザには出ません。
