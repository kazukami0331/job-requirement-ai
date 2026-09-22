/**
 * 設定。値はスクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）に保存する。
 * API キーなどをコードに直接書かないこと。
 */
var CONFIG_DEFAULTS = {
  // Claude API
  ANTHROPIC_MODEL: 'claude-opus-5',
  ANTHROPIC_EFFORT: 'low',          // low / medium / high / xhigh / max
  ANTHROPIC_MAX_TOKENS: '4000',

  // Gmail
  // 件名の書式（【応募】氏名）は守られないことがあるため、検索条件に件名は含めない。
  // 「応募書類が届くアドレス（からの転送）」＋「添付あり」だけで拾う。
  GMAIL_QUERY: 'label:selection-ai/inbox has:attachment',
  LABEL_INBOX: 'selection-ai/inbox',
  LABEL_DONE: 'selection-ai/done',
  LABEL_ERROR: 'selection-ai/error',
  MAX_MESSAGES: '10',               // 1回の実行で処理する最大メール数

  // 判定
  AGE_LIMIT: '70',                  // これを超えたら不合格
  AGE_CONCERN_FROM: '55',           // これ以上なら懸念として通知

  // 通知
  NOTIFY_VERDICTS: 'pass,review,fail',  // 通知する判定。例: 'review,fail' なら合格は通知しない
  SLACK_WEBHOOK_URL: '',

  // 添付ファイル
  MAX_ATTACHMENT_MB: '15',          // 1ファイルあたりの上限
  MAX_TOTAL_UPLOAD_MB: '25',        // 1候補者あたり Claude に送る合計の上限

  // true なら Drive 保存・台帳記録・通知・ラベル付けを一切せず、判定結果をログに出すだけ。
  // 台帳に書かないので同じメールを何度でも試せる。
  DRY_RUN: 'false'
};

var REQUIRED_CONFIG_KEYS = ['ANTHROPIC_API_KEY', 'DRIVE_ROOT_FOLDER_ID', 'LEDGER_SPREADSHEET_ID'];

function scriptProps_() {
  return PropertiesService.getScriptProperties();
}

/** 設定値を取得する。未設定ならデフォルト、それも無ければ ''。 */
function cfg(key) {
  var value = scriptProps_().getProperty(key);
  if (value === null || value === '') {
    return CONFIG_DEFAULTS[key] !== undefined ? CONFIG_DEFAULTS[key] : '';
  }
  return value;
}

function cfgInt(key) {
  var n = parseInt(cfg(key), 10);
  return isNaN(n) ? parseInt(CONFIG_DEFAULTS[key], 10) : n;
}

function cfgBool(key) {
  return String(cfg(key)).toLowerCase() === 'true';
}

function cfgList(key) {
  return cfg(key).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

/** 必須設定が欠けていれば分かりやすいエラーにする。 */
function requireCfg(key) {
  var value = cfg(key);
  if (!value) {
    throw new Error('スクリプトプロパティ "' + key + '" が未設定です。先に setup() を実行してください。');
  }
  return value;
}

function ageRule() {
  return { limit: cfgInt('AGE_LIMIT'), concernFrom: cfgInt('AGE_CONCERN_FROM') };
}

/** 通知先。未設定ならスクリプト実行ユーザー自身。 */
function notifyEmail() {
  return cfg('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
}
