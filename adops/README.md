# adops — ブルーカラー求人広告の自動運用

製造・物流・建設・ドライバーなどのブルーカラー求人の集客広告（Meta / Google 広告）を、
AI が **企画 → レビュー → 修正 → 制作 → 入稿 → 分析 → 改善** まで毎日回し続ける仕組みです。

人がやることは、最初の設定（求人・広告セット・API キー）と、日々の Slack 通知の確認だけ。
慣れるまでは「停止状態で入稿 → 人が Slack のボタンか管理画面で ON」の下書きモードで動かし、信頼できたら完全自動に切り替えます。

```
          ┌──────────────── 毎朝 6:00（GitHub Actions）─────────────────┐
          │                                                             │
 実績・状態取込 → 停止・予算判断 → AI分析 → 配分決定 → AI企画 ⇄ AIレビュー
 (Meta/Google/    (ルール)        (学び)   (バンディット) (コピー・構成)  (法令・品質)
  選考結果/コメント)                                          │
          Slack 報告 ← 入稿 ← 最終QA ← 動画/カルーセル化 ← 文字合成 ← 画像生成 → AI画像選定
          + レポート  (Meta/Google/   (AI)   (ffmpeg+ナレーション) (4比率×3レイアウト) (Midjourney
                       検索広告/Instagram)                                         ／Gemini 代替)
          ├──── 12:00 / 18:00 は「実績取込 → 停止判断」だけ
          └──── 9:30〜21:30 毎時: インスタントフォームの応募を Slack 通知
```

**最短の始め方**: `npm install` → `node src/cli.ts cycle --offline` で動きを見る → `config/` を自社の求人に書き換える →
GitHub の Secrets に `ANTHROPIC_API_KEY` と `SLACK_WEBHOOK_URL` を入れて DRY RUN のまま毎朝回す（企画・素材の質を Slack で確認）→
媒体の API キーと入稿先を設定して `ADOPS_DRY_RUN=false`。詳しい段取りは [RUNBOOK.md](RUNBOOK.md)。

## 何が自動化されているか

| 工程 | 担当 | 中身 |
|---|---|---|
| 企画（何を試すか） | コード（多腕バンディット） | 求人 × ペルソナ × 訴求軸（給与・寮・未経験…10種）× 画像/動画/カルーセル を、過去の応募実績から Thompson Sampling で配分。3割は未検証の訴求を試す探索枠 |
| 企画（どう表現するか） | Claude | フック・見出し・本文・画像に載せる文字・動画の絵コンテ・Midjourney 用プロンプト。過去の学び・勝ち/負けコピーを踏まえる |
| レビュー | ルール + Claude | 年齢/性別制限、求人に無い待遇、給与上限超え、成果保証、根拠なき No.1、個人属性の示唆（Meta 不承認の原因）、文字数を機械で検査。Claude がフック力・分かりやすさ・ペルソナ適合・信頼性・画像適合を各20点で採点 |
| フィードバック | Claude | 差し戻しの指摘を全部直した改訂版を作り、再レビュー（最大2回。直らなければ却下） |
| 画像生成 | Midjourney | 文字を含まない情景写真。画像広告は 4:5 と 9:16、動画は 9:16 を4候補 |
| 画像選定 | Claude（画像認識） | 手指の崩れ・文字化け・安全装備なし・暗すぎる構図を落とし、一番使える1枚を選ぶ |
| 文字合成 | コード（sharp） | 日本語コピー・バッジ・給与と勤務地のフッターを 4:5 / 1:1 / 9:16 / 1.91:1 に合成（Midjourney は日本語を描けないため）。レイアウトは「下部の帯」「白いカード」「給与を大きく」の3種類で、クリック率の良いものを自動で多めに使う |
| 動画化 | コード（ffmpeg） | 4候補をカットごとの背景にしてパン/ズーム＋字幕 → 求人情報のエンドカード。9:16 と 4:5 を書き出し。任意で Google Cloud の音声合成によるナレーション（カットの長さを声に合わせ、BGM を下げてミックス） |
| 最終チェック | Claude（画像認識） | 完成品の文字が読めるか、誤解を招かないか、審査で落ちそうな要素がないか |
| 入稿 | コード | Meta: 配置ごとに 4:5（フィード）と 9:16（ストーリーズ・リール）を出し分ける1広告。Google: デマンド ジェネレーション広告（動画は YouTube 限定公開経由）/ P-MAX アセット |
| 停止・入替・予算 | コード（ルール） | 応募ゼロのまま目標単価の2倍消化 / 応募単価が目標の1.5倍超 / CTR が基準未満 / 広告疲れ / 同時配信数の上限 → 停止。勝ち広告のある広告セットは日予算を段階的に増額（上限あり） |
| Google 検索広告 | Claude + コード | 求人ごとにレスポンシブ検索広告（見出し15・説明文4）を作り、広告グループ内で「現行＋挑戦者」の2本を回す。十分な表示の後、CTR（応募があれば応募率）が7割未満の方を止め、別の言い回しで次の挑戦者を作る |
| オーガニック投稿 | Claude + コード | 広告で反応の良かった素材（無ければ当日の新作）を、共感型のキャプションに書き直して Instagram（フィード/リール/カルーセル）に1日1本投稿。任意で Facebook ページと YouTube ショートにも。キャプションも同じ機械チェックを通す |
| コメント監視 | Claude + コード | 広告の Facebook・Instagram 両方の投稿のコメントを1日3回確認し、質問（＝応募見込み、返信案つき）とネガティブを Slack に通知。スパムは自動で非表示（`ADOPS_WATCH_COMMENTS=true`） |
| 分析 | Claude | 訴求軸・形式・ペルソナ・求人・媒体別の集計から「何が効いたか」を言語化し、次の企画に渡す |
| 報告 | コード | Slack に日次サマリ、`data/report.html` にクリエイティブ一覧つきレポート |

AI に任せない部分（配分・停止・予算・法令チェック・入稿可否）はコードで確定させています。
AI はあくまで「表現」と「解釈」を担当します。

## Midjourney について（重要）

Midjourney には**公式 API がありません**（2026年10月時点）。また利用規約で自動化ツールによる操作が禁止されています。
そのため画像の取り方を3つ用意しています（`IMAGE_PROVIDER`）。

| 方式 | 人の作業 | 規約リスク | 用途 |
|---|---|---|---|
| `handoff`（推奨・既定） | Slack に届くプロンプトを midjourney.com に貼って生成し、良い画像を `inbox/<ID>/` に保存（1本1〜2分） | なし | 本番 |
| `midjourney` | なし | **あり**（中継 API 経由。アカウント停止の可能性） | 規約を確認した上で自己責任で。PiAPI 形式（`POST /api/v1/task` → `GET /api/v1/task/{id}`）の中継サービスに対応。**PiAPI 自体は Midjourney API の提供終了を告知している**ため、同じ形式の別サービスか自前の中継を `MJ_API_BASE_URL` に指定する |
| `gemini` | なし | なし（Google の公式 API） | 完全自動にしたい場合。画像の雰囲気は Midjourney と異なる |
| `mock` | なし | なし | 動作確認・テスト |

**おすすめは `handoff` ＋ Gemini の代替**です。`GEMINI_API_KEY` を設定すると、手渡しで24時間（`IMAGE_FALLBACK_AFTER_HOURS`）
画像が置かれなかった依頼は自動で Gemini が生成して先に進みます。人に余裕がある日は Midjourney の画像、忙しい日も止まらない、という運用になります。

`handoff` の画像の置き場所は2通りです。

- **Google ドライブ（おすすめ）** `MJ_INBOX=drive`: 共有フォルダの中に、AI が企画ごとのフォルダ（`cr_xxx_4x5` など）と
  `PROMPT.txt` を自動で作ります。Slack にフォルダへのリンクとプロンプトが届くので、midjourney.com（スマホ可）で生成して
  そのフォルダに画像を保存するだけ。次の実行で取り込まれ、選定・合成・入稿まで進みます。
  設定: Google Cloud でサービスアカウントを作り（Drive API を有効化）、鍵 JSON を `GOOGLE_SERVICE_ACCOUNT_JSON` に。
  **共有ドライブ**にフォルダを作ってサービスアカウントのメールアドレスを「コンテンツ管理者」で追加し、そのフォルダ ID を `DRIVE_INBOX_FOLDER_ID` に
  （サービスアカウントはマイドライブに容量を持たないため、マイドライブのフォルダだと PROMPT.txt を置けません）。
  画像は PNG / JPEG / WebP で保存してください（iPhone の HEIC は読めません）。
- **GitHub** `MJ_INBOX=local`（既定）: `adops-state` ブランチの `inbox/cr_xxx_4x5/` に「Add file → Upload files」で置く。

取り込んだフォルダは `.imported` に、画像審査で全て使えなかったフォルダは（ドライブでは）`.rejected-…` に名前が変わり、
新しいフォルダとプロンプトがもう一度届きます。

> Midjourney 以外の公式 API を持つ画像モデルに切り替えたい場合は、`src/creative/imageProvider.ts` に
> `ImageProvider` を1つ実装すれば差し替えられます。

## セットアップ

### 1. 手元で動かしてみる（API キー不要）

```bash
cd adops
npm install
node src/cli.ts check            # 設定と接続の確認
node src/cli.ts cycle --offline  # テンプレート企画・仮画像で1サイクル（媒体には何もしない）
open data/report.html
node src/cli.ts simulate --offline --days 21   # 架空の配信データで改善ループを確認
```

Node.js 22.18 以上（TypeScript をそのまま実行します）、`ffmpeg`、日本語フォント（`fonts-noto-cjk`）が必要です。

### 2. 求人・ペルソナ・ブランド・運用方針を書く（`config/`）

- `jobs.json` — 集客したい求人。求人票のテキストがあれば `node src/cli.ts add-job --file 求人票.txt --write` で
  Claude が事実だけを抜き出して追加します（`active: false` で入るので、確認してから `true` に）。**給与・待遇はここに書いた事実だけが広告に使われます**（書いていない待遇を広告に出すとレビューで止まります）。
  `placements` に入稿先（Meta の広告セット ID、Google の広告グループ ID / アセットグループ ID）を書きます。
- `personas.json` — 狙う求職者像（動機・不安・響く言葉）。
- `brand.json` — 社名、トーン、色、NG表現、画像の共通スタイル、必須表記（許可番号など）。
- `policy.json` — 運用方針。

| policy.json | 意味 |
|---|---|
| `autonomy` | `draft`: 停止状態で入稿（人が ON）。予算増は提案のみ / `auto`: 審査を通れば配信開始、予算増も自動 |
| `briefsPerCycle` | 1日に企画する本数（全求人合計。求人ごとの上限は `jobs.json` の `dailyCreativeQuota`） |
| `videoShare` / `carouselShare` / `exploreShare` | 動画の割合 / カルーセル（「1日の流れ」などの複数枚。Meta と Instagram のみ）の割合 / 新しい訴求を試す割合 |
| `review.passScore` / `maxRevisions` | 合格点（100点満点）/ 差し戻しの最大回数 |
| `organic` | Instagram のオーガニック投稿（有効/無効、1日の本数、固定ハッシュタグ、転用する広告の CTR 下限） |
| `guardrails.targetCpa` | 目標応募単価（円）。停止・予算増の基準 |
| `guardrails.minImpressions` | CTR で停止判断するのに必要な最低表示回数 |
| `guardrails.maxDailyBudget` | 自動で増やす日予算の上限（円） |
| `guardrails.maxActivePerAdset` | 1求人あたりの同時配信数の上限（入れすぎると学習が分散） |
| `guardrails.fatigueDays` / `fatigueCtrRatio` | 広告疲れの判定（配信から何日以上、初週比でCTRが何割まで落ちたら入替） |

### 3. 媒体側の準備

**Meta**
1. ビジネスマネージャでシステムユーザーを作り、広告アカウントとページの権限を付与。
   `ads_management` `ads_read` `pages_read_engagement` `business_management` で長期トークンを発行 → `META_ACCESS_TOKEN`
2. キャンペーン（目的: リード or 売上/コンバージョン）と広告セット（ターゲティング・予算・最適化イベント）を**人が作る**。
   求人広告なので **特別な広告カテゴリ「雇用」** の宣言が必要な地域があります。媒体の最新の規定に従って設定してください。
3. 広告セット ID を `jobs.json` の `placements.meta.adsetIds` に書く。
4. 応募の計測（ピクセル/CAPI の Lead・SubmitApplication、またはリード獲得フォーム）。
   応募として数える action_type が既定と違う場合は `META_CONVERSION_ACTION_TYPES` で指定。

**インスタントフォーム（任意・おすすめ）**
- LP に飛ばすより、Meta のアプリ内フォームで応募を完結させた方が応募率が高いことが多いです。
  広告マネージャでフォーム（質問項目・プライバシーポリシー）を作り、その ID を `jobs.json` の `placements.meta.leadFormId` に書くと、
  その求人の広告はフォーム型で入稿されます（キャンペーン目的はリード獲得に）。
- 新しい応募は日本時間 9:30〜21:30 に毎時確認し、Slack に「時刻・イニシャル・求人・どの広告から」を通知します。
  電話番号などの個人情報は Slack にも状態ファイルにも残しません（リードセンターや CRM で確認）。トークンに `leads_retrieval` 権限が必要です。

**Instagram（オーガニック投稿を使う場合）**
- プロフェッショナルアカウントを Facebook ページに接続し、`META_INSTAGRAM_USER_ID` を設定。
- トークンに `instagram_basic` `instagram_content_publish` `instagram_manage_insights` 権限を追加。
- `policy.json` の `organic`（`enabled` / `postsPerDay` / `baseHashtags` / `minAdCtrForRepost` / `channels`）で調整。
- `channels` に `"facebook"` を足すと Facebook ページにも（画像・複数画像・動画）、`"youtube"` を足すと縦動画を**公開の YouTube ショート**としても投稿します
  （Facebook はトークンに `pages_manage_posts`、YouTube は `youtube.upload` スコープが必要）。広告費をかけずにリーチを増やせます。

**Google 広告**
1. 開発者トークン、OAuth クライアント、リフレッシュトークン（`adwords` と、動画を使うなら `youtube.upload` スコープ）。
2. **デマンド ジェネレーション**キャンペーンと広告グループを人が作り、ID を `placements.google.adGroupIds` に書く
   （広告単位で成果が取れるので AI の学習に使えます）。ロゴ画像アセットを1つ作って `GOOGLE_ADS_LOGO_ASSET`、社名を `GOOGLE_ADS_BUSINESS_NAME` に。
3. 検索広告を回す場合は、検索キャンペーンと広告グループ（キーワード・入札は人が設定）を作り、ID を `placements.google.searchAdGroupIds` に書く。
4. P-MAX を使う場合はアセットグループ ID を `placements.google.assetGroupIds` に（素材の追加・入替のみ。成果の学習には使いません）。
5. 応募のコンバージョンアクション名を `GOOGLE_ADS_CONVERSION_ACTION` に。

### 選考結果（面接・入社）を取り込む（任意）

広告のリンクには `utm_content=<企画ID>`（`br_...`）が付きます。応募管理やスプレッドシートにこの値を残し、
次の列を持つ CSV を `ADOPS_OUTCOMES_CSV_URL`（Google スプレッドシートの「ウェブに公開 → CSV」URL など）に設定すると、
広告ごとの面接・内定・入社数がレポートと AI 分析に入ります。「応募は取れるが面接に来ない訴求」を見分けられます。

| 企画ID（utm_content） | 応募者ID（任意） | ステータス（応募/面接/内定/入社） |
|---|---|---|
| br_20261027_600542 | 1234 | 面接 |

### Slack で承認する（draft モード・任意）

draft モードでは、入稿した広告ごとに Slack へ「プレビュー画像・コピー・**配信開始 / 却下**ボタン」を送れます。
スマホの Slack からワンタップで配信を始められるので、媒体の管理画面を開く必要がありません。

1. このリポジトリの Next.js アプリを Vercel にデプロイする（受け口 `app/api/adops/slack/route.ts` が含まれます）。
2. Slack アプリ（Incoming Webhook を発行したもの）で **Interactivity** を ON にし、Request URL に `https://<Vercel のドメイン>/api/adops/slack` を設定。
3. ランダムな長い文字列を1つ作り（例: `openssl rand -hex 32`）、**GitHub の Secrets と Vercel の環境変数の両方**に `ADOPS_APPROVAL_SECRET` として登録
   （ボタンの値に署名を付け、偽のボタンや改ざんを受け付けないため）。
4. Vercel の環境変数に `SLACK_SIGNING_SECRET`（Slack アプリの Signing Secret）、`ADOPS_SLACK_APPROVERS`（承認できる人の Slack ユーザー ID をカンマ区切り。**必須**）、
   `META_ACCESS_TOKEN`（と `META_APP_SECRET`）、Google の広告も承認するなら `GOOGLE_ADS_*` を設定。
5. GitHub の Variables に `ADOPS_SLACK_APPROVALS=true`。

**Slack から緊急停止**: Slack アプリに Slash Command `/adops`（Request URL は同じ `https://<Vercel のドメイン>/api/adops/slack`）を追加し、
Vercel に `ADOPS_GITHUB_REPO` と `ADOPS_GITHUB_TOKEN`（このリポジトリの Actions: Read and write 権限）を設定すると、
承認者が `/adops stop` で緊急停止、`/adops resume` で解除できます。

ボタンの有効期限は48時間です。adops が停止判断や緊急停止で止めた広告（広告名の末尾に `[adops停止]`）は、古いボタンを押しても再開しません。

ボタンが押されると媒体の広告が ON（却下なら停止のまま）になり、メッセージが「◯◯さんが配信を開始しました」に書き換わります。
次の adops の実行で状態が同期され、配信中の広告として停止判断の対象になります。

### 実績をスプレッドシートに書き出す（任意）

`ADOPS_SHEET_ID` にスプレッドシートの ID を設定し、サービスアカウント（`GOOGLE_SERVICE_ACCOUNT_JSON`）を「編集者」で共有すると、
毎回の実行後に「adops_日次」（日付×広告×媒体の実績、直近60日）と「adops_広告」（広告一覧・コピー・選考結果）を書き直します。
報告資料やピボット、Looker Studio などにそのまま使えます。

### レポートをスマホで見る（任意）

Next.js アプリを Vercel にデプロイしていれば、`https://<Vercel のドメイン>/adops` でパスワード付きのレポートが見られます
（`adops-state` ブランチの最新のレポートと画像を GitHub から取って表示します。状態ファイル自体は公開しません）。
Vercel の環境変数に `ADOPS_REPORT_PASSWORD`（ユーザー名は `adops`）、`ADOPS_GITHUB_REPO`（例: `kazukami0331/job-requirement-ai`）、
`ADOPS_GITHUB_TOKEN`（このリポジトリの Contents: Read-only の fine-grained トークン）を設定してください。
GitHub の Variables に `ADOPS_REPORT_URL=https://<Vercel のドメイン>/adops` を入れると、毎日の Slack 通知にリンクが付きます。

### 4. GitHub Actions で毎日動かす

`.github/workflows/adops.yml` が毎朝 6:00（フル）と 12:00 / 18:00（停止判断のみ）に動きます。
リポジトリの **Settings → Secrets and variables → Actions** に次を登録してください。

| 種類 | 名前 |
|---|---|
| Secrets | `ADOPS_APPROVAL_SECRET` `GEMINI_API_KEY` `GOOGLE_SERVICE_ACCOUNT_JSON` `ADOPS_OUTCOMES_CSV_URL` `ANTHROPIC_API_KEY` `META_ACCESS_TOKEN` `META_APP_SECRET` `GOOGLE_ADS_DEVELOPER_TOKEN` `GOOGLE_ADS_CLIENT_ID` `GOOGLE_ADS_CLIENT_SECRET` `GOOGLE_ADS_REFRESH_TOKEN` `YOUTUBE_REFRESH_TOKEN` `MJ_API_KEY` `SLACK_WEBHOOK_URL` |
| Variables | `ADOPS_DRY_RUN`（`false` で本番）`IMAGE_PROVIDER` `META_AD_ACCOUNT_ID` `META_PAGE_ID` `META_INSTAGRAM_USER_ID` `META_CONVERSION_ACTION_TYPES` `GOOGLE_ADS_CUSTOMER_ID` `GOOGLE_ADS_LOGIN_CUSTOMER_ID` `GOOGLE_ADS_CONVERSION_ACTION` `GOOGLE_ADS_LOGO_ASSET` `GOOGLE_ADS_BUSINESS_NAME` `ADOPS_MODEL` `MJ_API_BASE_URL` `MJ_VIDEO_ENABLED` `MJ_INBOX` `DRIVE_INBOX_FOLDER_ID` `ADOPS_MAX_LLM_USD` `ADOPS_SLACK_APPROVALS` `ADOPS_TTS` `ADOPS_TTS_VOICE` `GEMINI_IMAGE_MODEL` `IMAGE_FALLBACK_AFTER_HOURS` `ADOPS_WATCH_COMMENTS` `ADOPS_HIDE_SPAM` `ADOPS_REPORT_URL` `ADOPS_SHEET_ID` `ADOPS_DAILY_SPEND_CAP` `ADOPS_LP_CHECK` |

本番前に、手元で `.env` を作って `node src/cli.ts check --live` を実行すると、Claude・Meta（広告アカウント・各広告セット・Instagram）・
Google 広告（アカウント・広告グループがデマンド ジェネレーションか）・ドライブの設定を読み取りだけで確認できます。

`ADOPS_DRY_RUN` を `false` にするまでは媒体に何も書き込みません。最初は DRY RUN のまま数日動かし、
Slack とレポートで企画と素材の質を確認してから本番にしてください。

状態（企画・レビュー・実績・学び）は `adops-state` ブランチに保存されます（毎回最新だけを上書きする履歴なしブランチ）。
入稿済みの素材ファイルは媒体側に残るので、こちらではサムネイルだけ残して掃除します。
全素材は Actions の Artifacts に14日間残ります。

手動実行は Actions → adops → Run workflow（`steps` に `plan,produce` のように段階を指定可能）。

## CLI

```
node src/cli.ts cycle [--steps collect,optimize,analyze,plan,produce,publish,search,organic,report]
node src/cli.ts plan | produce | publish | collect | optimize | analyze | report
node src/cli.ts status                 # クリエイティブの状態一覧
node src/cli.ts check [--live]         # 設定の確認（--live で各サービスへ読み取りだけの接続テスト）
node src/cli.ts simulate --days 21     # 架空の配信データで改善ループを確認
node src/cli.ts add-job --file 求人票.txt [--write]   # 求人票から jobs.json に追加
node src/cli.ts leads                  # インスタントフォームの新しい応募を Slack に通知
node src/cli.ts emergency-stop / resume  # 緊急停止 / 解除
共通: --offline（Claude を使わない） --today YYYY-MM-DD
```

## 安全装置

> 導入から本番化の進め方、毎日・毎週の確認、トラブル時の対応は [RUNBOOK.md](RUNBOOK.md) にまとめています。

- **1日の広告費の上限**: `ADOPS_DAILY_SPEND_CAP`（円）を設定すると、日中の実績取り込みで当日の消化額が上限を超えた時点で自動的に緊急停止します（自動モードでは必ず設定してください）。
- **応募ページの死活監視**: 1日3回、各求人の `landingUrl` を確認し、404・つながらない・「募集は終了しました」の表示があれば Slack に知らせ、その求人の新規入稿（検索広告・Instagram 投稿を含む）を止める。直れば自動で再開（配信中の広告は止めない。`ADOPS_LP_CHECK=false` で無効）。
- **承認ボタンの安全確認**: Vercel に `ADOPS_GITHUB_TOKEN` / `ADOPS_GITHUB_REPO` を設定すると、承認前に adops の状態を読み、緊急停止中や adops が止めたクリエイティブの承認を断る（Google の広告は名前で判別できないため設定を推奨）。
- **緊急停止**: Slack で `/adops stop`、または Actions → adops → Run workflow → `control: stop`（手元なら `node src/cli.ts emergency-stop`）で、adops が入稿した広告をすべて停止し、解除（`resume`）まで新しい入稿もしない。

- 既定は DRY RUN（媒体への入稿・停止・予算変更・Instagram 投稿をしない。企画・画像生成・制作は行うので Claude と Midjourney の費用はかかる）。
  `draft` モードでは停止状態で入稿し、予算は増やさない（提案のみ）。
- draft モードでは、停止状態で入れられない P-MAX アセットは入稿せず、Instagram 投稿も人が ON にした広告の素材だけを使う。
- 予算増は同じ広告セットにつき3日に1回まで（`ADOPS_BUDGET_COOLDOWN_DAYS`）。Meta の予算は Meta での実績だけで判断。
- 広告・クリエイティブの作成リクエストはタイムアウトしても再送しない（二重入稿の防止）。一部の広告セット/媒体だけ失敗した場合も作成済みの広告は必ず記録し、失敗した媒体は最大3回まで再試行。
- 停止（お金を守る方向）は `draft` モードでも自動。予算増は `auto` モードのときだけ、1回 +20%・上限 `maxDailyBudget`。
- 法令・ポリシーの blocker はレビューの点数に関係なく入稿しない。給与額は求人の上限を超えられない。
- 媒体の審査落ちなど入稿失敗は `failed` にして再送しない（Slack に理由を出す）。
- 1本の制作・入稿の失敗でサイクル全体は止まらない。各段階の成否は Slack とレポートに出る。

## 構成

```
adops/
  config/           求人・ペルソナ・ブランド・運用方針・お手本コピー（人が編集する）
  src/
    agents/         Claude のエージェント（企画・レビュー・画像審査・分析・週次メモ・SNS/検索広告コピー・コメント仕分け・求人取込）
    compliance/     求人広告の機械チェック（法令・ポリシー・文字数）
    optimize/       集計・配分（訴求軸/レイアウトのバンディット）・停止/予算の判断
    creative/       画像生成（Midjourney 手渡し・中継 / Gemini）・文字合成・動画化・ナレーション・inbox（ローカル/ドライブ）
    platforms/      Meta / Google 広告 / YouTube / Instagram の API
    pipeline/       各段階（収集・最適化・企画・制作・入稿・検索広告・SNS投稿・応募通知・コメント・選考結果・緊急停止）とサイクル全体
    report/ notify/ レポート・Slack（承認ボタン）
    sim/            架空データでのシミュレーター
  test/             node --test（単体・統合）
app/api/adops/slack/  Slack 承認ボタンの受け口（Next.js）
app/adops/            レポートの閲覧ページ（Next.js）
```

## 費用の目安

- Claude: 1日6本の企画・レビュー（差し戻し込み）・画像選定・最終チェック・分析で、おおむね $1〜3/日の見込み（未実測の見積もり。実績は `data/report.html` と Slack に毎回表示）。
- Midjourney: 画像広告1本につき2回、動画1本につき1回の生成（Video を使う場合は追加）。
- GitHub Actions: 1回 5〜15 分程度。

## まだやっていないこと

- 実際の Meta / Google / Midjourney 中継 / Instagram / ドライブ / Gemini / 音声合成 API での疎通確認（認証情報が必要）。最初は `check --live` と DRY RUN で確認してください。
- 選考結果は「面接率」で訴求軸の配分を補正していますが、報酬そのものはまだ応募数です。入社データが十分に貯まったら「入社」を報酬にできます。
- LINE 広告・TikTok 広告など、Meta / Google 以外の媒体。`platforms/` に同じ形のクライアントを足せば広げられます。
