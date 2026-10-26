# adops 運用手順書

導入から本番化、日々の確認、トラブル時の対応までをまとめています。仕組みの説明は [README.md](README.md) を参照してください。

## 導入から本番まで（目安 3〜4 週間）

| 段階 | 期間 | 設定 | やること | 次に進む条件 |
|---|---|---|---|---|
| 0. 準備 | 1〜2日 | — | `config/` に求人・ペルソナ・ブランドを書く（求人票があれば `add-job`）。媒体でキャンペーン・広告セットを作る。Secrets / Variables を登録。`check --live` が全部 OK | 接続テストが通る |
| 1. 試運転 | 3〜7日 | `ADOPS_DRY_RUN=true` | 毎朝の Slack とレポートで、企画・コピー・画像・動画の質を見る。気になる表現は `brand.json` の NG 表現や `examples.json` の悪い例に足す | 「このまま出してよい」と思える企画が大半になる |
| 2. 下書き入稿 | 1〜2週 | `ADOPS_DRY_RUN=false` / `autonomy: draft` | 停止状態で入稿される広告を管理画面で確認して ON にする。停止判断は自動で動く | 媒体審査の不承認がほぼ無い。応募単価が目標の範囲 |
| 3. 完全自動 | 以降 | `autonomy: auto` ＋ `ADOPS_DAILY_SPEND_CAP` | 毎朝 Slack を見るだけ。月曜の戦略メモで予算配分などを判断 | — |

`autonomy` は `config/policy.json`、`ADOPS_DRY_RUN` は GitHub の Variables で切り替えます。

## 毎日の確認（5分）

Slack の日次通知で次を見ます。

1. **失敗した段階**（:warning:）が無いか。あれば下の「トラブル時」へ。
2. **Midjourney の依頼**（手渡しモード）: プロンプトをコピーして midjourney.com で生成し、示されたフォルダに良い画像を1〜4枚保存。
3. **入稿**（draft モード）: Slack の承認メッセージで「配信開始 / 却下」を押す（承認ボタンを設定していなければ、管理画面で名前が `adops_` で始まる広告を確認して ON）。
4. **運用判断**: 停止された広告と理由。納得できない停止が続くなら `policy.json` の `guardrails` を見直す。
5. **予算増の提案**（draft モード）: 妥当なら管理画面で反映。

## 毎週の確認（月曜・15分）

- Slack の **週次戦略メモ**「判断してほしいこと」に対応する（媒体間の予算配分、求人・ペルソナの追加など）。
- レポート（`https://<Vercel のドメイン>/adops`、または Actions の Artifacts）で、訴求軸別の成績とクリエイティブ一覧を見る。
- 反応の良かった表現を `config/examples.json` の good に足す（企画の質が上がります）。
- 選考結果のスプレッドシート（`ADOPS_OUTCOMES_CSV_URL`）が更新されているか確認する。

## 調整のつまみ

| したいこと | 変える場所 |
|---|---|
| 1日に作る本数を増やす/減らす | `policy.json` の `briefsPerCycle`、求人ごとは `jobs.json` の `dailyCreativeQuota` |
| 応募の数より質（面接に来る人）で最適化する | 選考結果の取り込みが1〜2か月分貯まったら `policy.json` に `"rewardMetric": "interviews"` |
| 動画を増やす | `policy.json` の `videoShare` |
| 新しい訴求をもっと試す / 勝ち筋に寄せる | `policy.json` の `exploreShare`（上げると試す、下げると寄せる）。シミュレーション（30日・3通り）では 0.1 と 0.3 がほぼ同等、0.5 は応募が約2割減。市場の変化に追従するため既定は 0.3、0.5 以上は非推奨 |
| 停止を厳しく/ゆるく | `policy.json` の `guardrails`（`targetCpa`、`ctrFloorPct`、`minImpressions` など） |
| 予算の自動増額の上限 | `guardrails.maxDailyBudget`、間隔は `ADOPS_BUDGET_COOLDOWN_DAYS` |
| 使ってほしくない言葉 | `brand.json` の `bannedPhrases`、`examples.json` の bad |
| 求人を止める（募集終了） | `jobs.json` の `active: false`（次の実行で、その求人の新しい広告を作らなくなり、配信中の広告・検索広告も自動で止まる。急ぐなら Actions で `steps` に `collect,optimize` を指定して手動実行） |
| Instagram 投稿を止める | `policy.json` の `organic.enabled: false` |
| AI 費用を抑える | `briefsPerCycle` を下げる、`ADOPS_MAX_LLM_USD`（1回の上限）、`ADOPS_EFFORT=medium` |

## トラブル時

### すぐ全部止めたい
Slack で **`/adops stop`**（設定済みの場合）、または GitHub の Actions → **adops** → Run workflow → `control` に **stop** を選んで実行。
adops が入稿した広告（Meta・Google・検索広告）をすべて停止し、解除するまで企画・入稿・投稿をしません（実績の取り込みと報告は続けます）。
緊急停止は実行中のサイクルを打ち切ってから動くので、通常1〜3分で全広告が止まります。**一刻を争うときは、媒体の管理画面でキャンペーンごと停止**してから、続けて上の緊急停止をしてください（adops が新しく入稿しないように）。
手元からなら `node src/cli.ts emergency-stop`。解除は `control: resume` か `node src/cli.ts resume`
（止めた広告は自動では再開しないので、必要なものを管理画面で ON にしてください）。

### 媒体審査で不承認になった
Slack とレポートに理由が出ます（`failed`「媒体審査で不承認: …」）。理由は次回から企画エージェントに渡され、同じ表現を避けます。
同じ理由が続く場合は `brand.json` の NG 表現に追加するか、`compliance/rules.ts` に機械チェックを足してください。

### 「AI 費用が上限に達した」
1回の実行で `ADOPS_MAX_LLM_USD`（既定 $20）を超えそうになったため止めています。差し戻しが多すぎる（レビューが厳しすぎる・求人情報が不足している）ことが多いので、
レポートのレビュー指摘を確認してください。上限そのものは Variables で変更できます。

### 画像待ち（awaiting_images）が溜まる
手渡しモードで画像が置かれていません。溜まりすぎると新しい企画を自動で控えます（`briefsPerCycle` の2倍まで）。
画像を置くか、`briefsPerCycle` を下げてください。

### 入稿に失敗する
- `check --live` で、トークンの期限切れ・広告セット ID の誤り・権限不足を確認。
- 一部の媒体だけ失敗した場合は、自動で最大3回まで再試行します。
- Meta のトークンはシステムユーザーの無期限トークンを推奨（個人トークンは約60日で切れます）。

### 状態をやり直したい
`adops-state` ブランチの `state.json` が全ての記録です。消すと初回からやり直しになります（媒体の広告は消えません）。
特定のクリエイティブだけ扱いを変えたい場合は、`state.json` の該当 `creatives.<ID>.status` を書き換えてください。
