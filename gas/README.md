# 応募書類の自動判定（Gmail → Drive → Claude → 通知）

メールで届いた履歴書・職務経歴書を自動で読み取り、候補者名のフォルダで Google ドライブに保存し、
要件を満たすかを判定して結果だけをメール（任意で Slack）に通知する Google Apps Script です。

書類そのものは通知に添付しません。**ドライブに保存 → 通知にはリンクと判定だけ** という形にしています。

## 判定する内容

| 軸 | ◯ | △（懸念として通知） | ×（不合格） |
|---|---|---|---|
| 1. 年齢 | 54歳以下 | 55〜70歳 / 年齢を読み取れない | 71歳以上 |
| 2. 求人適合 | 3求人のいずれかの対象ツール・分野の経験がある | 関連はあるが対象ツールそのものではない | いずれの分野にも該当しない |
| 3. 実務経験 | 該当分野の実務経験がある（年数不問） | 学習・職業訓練・資格のみ / 実務か判別できない | 該当分野の実務経験がない |

総合判定は **×が1つでもあれば「不合格」／すべて◯なら「合格」／それ以外は「要確認」**。
「要確認」は懸念点つきで通知されるので、そこだけ人が見れば済みます。
なお、メール件名の氏名と書類の氏名が食い違う場合も（添付の取り違えを疑い）「要確認」に落とします。

対象求人（`src/Jobs.gs` に定義。求人票が変わったらここだけ直す）:

- `cad` CAD講師 — AutoCAD / Jw_cad / Vectorworks / Revit / SolidWorks / CATIA
- `web` Webデザイン講師 — Illustrator / Photoshop / HTML/CSS / JavaScript / Premiere Pro
- `it` プログラミング（IT）講師 — Java / Python / C言語 / SQL / ネットワーク / Linux / AWS / Power BI / Power Automate / Excel VBA

判定の重み付けは AI 任せにせず `src/Rules.gs`（純粋関数）で確定させています。
年齢は生年月日から計算し、「該当求人なし」なら必ず×、「対象ツールが1つも無い」なら◯にしない、といった補正もここで入れています。

## 処理の流れ

```
Gmail（ラベル selection-ai/inbox）
  └─ 添付を取り出す（PDF / Word / Excel / 画像 / ZIP）
       └─ Word・Excel は PDF に変換
            └─ Claude（claude-opus-5）に書類を渡して事実を抽出
                 ├─ Drive に <ルート>/<YYYY-MM>/<氏名>_<日時>/ で保存（_評価結果.json も同梱）
                 ├─ スプレッドシート「判定台帳」に1行追記
                 └─ 判定結果をメール通知（本文に Drive リンク）
```

処理したスレッドには `selection-ai/done`、失敗したスレッドには `selection-ai/error` ラベルが付きます。
同じメールを二重に処理しないよう、台帳のメッセージIDでも重複チェックしています。

## セットアップ

### 1. Apps Script プロジェクトを作る

```bash
npm install -g @google/clasp
clasp login
cd gas
clasp create --type standalone --title "応募書類 自動判定"   # .clasp.json ができる
clasp push
```

既存プロジェクトに入れる場合は `.clasp.json.example` をコピーして `scriptId` を書き換えてから `clasp push`。
clasp を使わない場合は、`script.google.com` で新規プロジェクトを作り、`src/*.gs` の中身を同名ファイルに貼り付け、
`appsscript.json`（プロジェクトの設定 → 「appsscript.json マニフェスト ファイルをエディタで表示する」）も置き換えてください。

### 2. Claude の API キーを登録

1. https://console.anthropic.com/ で API キーを発行
2. Apps Script の「プロジェクトの設定 → スクリプト プロパティ」で `ANTHROPIC_API_KEY` に貼り付け

### 3. 初期化

エディタで `setup()` を実行します（初回は権限の承認が必要）。次のものが自動で用意されます。

- ドライブのルートフォルダ「候補者書類（自動判定）」
- スプレッドシート「候補者判定台帳」
- Gmail ラベル `selection-ai/inbox` / `selection-ai/done` / `selection-ai/error`
- `NOTIFY_EMAIL`（未設定なら実行ユーザー自身のアドレス）

### 4. Gmail フィルタを作る

応募書類が届くメールに `selection-ai/inbox` ラベルが付くようにフィルタを設定します。

**条件は「差出人」＋「添付あり」だけにしてください。件名は条件に入れません。**
運用上は件名を `【応募】氏名` に統一していても、その通りに送られてこないことがあるためです。

```
条件: from:(kyujin@pcassist.co.jp) has:attachment
処理: ラベル「selection-ai/inbox」を付ける
```

件名が `【応募】氏名` の形であれば、氏名の**ヒント**として利用します（`nameFromSubject()`）。
ただし候補者氏名の確定は書類本体の記載を優先し、**件名と書類の氏名が食い違う場合は懸念として通知し、
判定が「合格」でも「要確認」に落とします**（添付の取り違えを検知するため）。

`GMAIL_QUERY` を直接書き換えてラベルなしで運用することもできます。

### 5. 動作確認 → 定期実行

転送設定を先方に依頼する前に、**自分のアドレスで一通り動かして確認する**ことをおすすめします。

#### 自分のアドレスで試す

1. 自分宛に、履歴書・職務経歴書を添付したテストメールを送る
   （実際の応募メールを1通転送してもらう、または手元のサンプルで代用）
2. エディタで `preview` を選んで実行する

```js
preview('from:me has:attachment')   // 自分で自分に送ったテストメール
preview()                           // GMAIL_QUERY の条件で最新1通
```

`preview()` は**Drive への保存・台帳への記録・メール通知・ラベル付けを一切行いません**。
判定結果（通知されるのと同じ本文）が実行ログに出るだけなので、同じメールで何度でも試せます。
プロンプトや判定ルールを調整しながら精度を確認するのに使ってください。

#### 一括で試す

`DRY_RUN` を `true` にして `run()` を実行すると、検索条件に合うメールをまとめて判定し、
結果をログに出します。こちらも保存・通知・ラベル付けは行いません。

#### モデルを比べる

同じメールに対して Opus と Sonnet を撃ち比べられます。実行ログにトークン数と概算コストが出ます。

```js
previewOpus()      // claude-opus-5 で判定
previewSonnet()    // claude-sonnet-5 で判定
compareModels()    // 両方を続けて実行して並べる（API を2回叩きます）
```

納得できるモデルが決まったら、スクリプト プロパティの `ANTHROPIC_MODEL` をその値にします。
本番運用時のコストは判定台帳の「概算コスト（円）」列に1件ずつ記録されます。

#### Slack に通知する

1. https://api.slack.com/apps → 「Create New App」→「From scratch」
2. アプリ名とワークスペースを選んで作成
3. 左メニュー「Incoming Webhooks」→ トグルを **On**
4. 「Add New Webhook to Workspace」→ **投稿先チャンネルを選ぶ**（例: `#書類選考bot`）
5. 発行された Webhook URL を、スクリプト プロパティの `SLACK_WEBHOOK_URL` に登録
6. `testSlack()` を実行して、チャンネルにテスト投稿が届くか確認

投稿先チャンネルは Webhook 作成時に決まります。変更したいときは Webhook を作り直してください。

既定では **Slack にのみ通知**します。メールでも受け取りたい場合は `NOTIFY_VIA` を `email,slack` にしてください。
`SLACK_WEBHOOK_URL` が未設定のまま `slack` を指定した場合は、通知が消えないよう自動でメールに切り替わります。

#### 本番運用に切り替える

1. `DRY_RUN` を `false` にする
2. `GMAIL_QUERY` を本番の条件に変える（テスト中は `from:me has:attachment` など）
3. `installTrigger()` を実行（15分ごとに `run()` が走る）

止めるときは `removeTriggers()`。現在の設定は `showConfig()` で確認できます（APIキーは値を表示しません）。

## スクリプト プロパティ

| キー | 既定値 | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | （必須） | Claude API キー |
| `DRIVE_ROOT_FOLDER_ID` | setup() が設定 | 保存先ルートフォルダ |
| `LEDGER_SPREADSHEET_ID` | setup() が設定 | 判定台帳 |
| `NOTIFY_EMAIL` | 実行ユーザー | 通知先 |
| `NOTIFY_VERDICTS` | `pass,review,fail` | 通知する判定。`review,fail` にすれば合格は通知されない |
| `NOTIFY_VIA` | `slack` | 通知先。`email` / `slack` / `email,slack`。Webhook 未設定時は自動でメールに切り替わる |
| `SLACK_WEBHOOK_URL` | （空） | Slack Incoming Webhook の URL。未設定なら Slack には投稿しない |
| `USD_JPY` | `150` | 概算コスト表示に使う為替レート |
| `ANTHROPIC_MODEL` | `claude-opus-5` | 使用モデル |
| `ANTHROPIC_EFFORT` | `low` | 思考の深さ。判定が甘いと感じたら `medium` |
| `ANTHROPIC_MAX_TOKENS` | `4000` | 出力上限 |
| `GMAIL_QUERY` | `label:selection-ai/inbox has:attachment` | 処理対象の検索条件 |
| `MAX_MESSAGES` | `10` | 1回の実行で処理する最大件数 |
| `AGE_LIMIT` | `70` | これを超えたら不合格 |
| `AGE_CONCERN_FROM` | `55` | これ以上なら懸念として通知 |
| `MAX_ATTACHMENT_MB` | `15` | 1ファイルの上限 |
| `MAX_TOTAL_UPLOAD_MB` | `25` | 1候補者あたり Claude に送る合計上限 |
| `DRY_RUN` | `false` | `true` で保存・台帳記録・通知・ラベル付けをせず、ログ出力のみ |

## テスト

判定ロジック（`src/Rules.gs` / `src/Jobs.gs`）は GAS の API に依存しないので、ローカルで実行できます。

```bash
npm run test:gas
```

## 運用上の注意

- **個人情報**：履歴書・職務経歴書はドライブとスプレッドシートに残ります。保存先フォルダと台帳の共有範囲は
  自分（と必要な担当者）だけに絞ってください。通知メールには書類を添付せずリンクだけを載せています。
- **年齢での判定**：今回の3求人は業務委託なので労働施策総合推進法の年齢制限規制の直接の対象外ですが、
  雇用契約の求人に同じ仕組みを流用する場合は年齢要件の扱いを確認してください。
  `AGE_LIMIT` / `AGE_CONCERN_FROM` はプロパティで変更でき、軸自体を外すこともできます。
- **AI の一次判定**：不合格の自動通知は「候補者への自動不採用連絡」ではありません。本システムは通知までで、
  候補者への連絡は行いません。最終判断は人が行う前提です。
- **タイムアウト**：Apps Script の UrlFetch には待ち時間の上限があります。添付が多い・重い場合に失敗したら、
  `ANTHROPIC_EFFORT` を下げるか `MAX_ATTACHMENT_MB` を下げてください。失敗時は `selection-ai/error`
  ラベルが付き、「判定不可」として通知されるので取りこぼしはありません。
