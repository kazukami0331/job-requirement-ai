/**
 * 初期セットアップ。Apps Script のエディタから setup() を1回実行する。
 * 既にフォルダ・台帳がある場合は作り直さない。
 */

var ROOT_FOLDER_NAME = '候補者書類（自動判定）';
var LEDGER_FILE_NAME = '候補者判定台帳';

/**
 * 書類の保存先にしたいドライブフォルダ。
 * 変更したいときはこのURLを差し替えて applyDriveFolder() を実行する。
 */
var DRIVE_ROOT_FOLDER_URL = 'https://drive.google.com/drive/folders/1ZowhopNqFMpUoJP86f5qC0jTMkwpBjbt';

/**
 * DRIVE_ROOT_FOLDER_URL のフォルダを保存先として設定する。
 * アクセスできるか確認してから書き込むので、URLを間違えていればここで分かる。
 */
function applyDriveFolder() {
  var id = folderIdFromUrl(DRIVE_ROOT_FOLDER_URL);
  if (!id) {
    log_('フォルダURLからIDを取り出せませんでした: ' + DRIVE_ROOT_FOLDER_URL);
    return;
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(id);
    folder.getName();  // アクセス権が無ければここで例外になる
  } catch (e) {
    log_('このフォルダにアクセスできません（IDが違うか権限がありません）: ' + id + ' / ' + e.message);
    return;
  }

  scriptProps_().setProperty('DRIVE_ROOT_FOLDER_ID', id);
  log_('保存先を変更しました: ' + folder.getName() + ' / ' + folder.getUrl());
  log_('以降、候補者ごとに「' + folder.getName() + '/<候補者氏名>」フォルダを作って保存します。');
}

function setup() {
  var props = scriptProps_();

  if (!props.getProperty('DRIVE_ROOT_FOLDER_ID')) {
    var folder = findOrCreateRootFolder_();
    props.setProperty('DRIVE_ROOT_FOLDER_ID', folder.getId());
    log_('ドライブのルートフォルダを用意しました: ' + folder.getUrl());
  }

  if (!props.getProperty('LEDGER_SPREADSHEET_ID')) {
    var ss = SpreadsheetApp.create(LEDGER_FILE_NAME);
    var root = DriveApp.getFolderById(props.getProperty('DRIVE_ROOT_FOLDER_ID'));
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props.setProperty('LEDGER_SPREADSHEET_ID', ss.getId());
    log_('判定台帳を作成しました: ' + ss.getUrl());
  }
  ledgerSheet_();  // ヘッダー行を用意する

  ['LABEL_INBOX', 'LABEL_DONE', 'LABEL_ERROR'].forEach(function (key) {
    var label = getOrCreateLabel_(cfg(key));
    log_('Gmail ラベルを用意しました: ' + label.getName());
  });

  if (!props.getProperty('NOTIFY_EMAIL')) {
    props.setProperty('NOTIFY_EMAIL', Session.getEffectiveUser().getEmail());
  }

  var missing = REQUIRED_CONFIG_KEYS.filter(function (key) { return !props.getProperty(key); });
  if (missing.length) {
    log_('▲ 次のスクリプトプロパティを手動で設定してください: ' + missing.join(', '));
  } else {
    log_('セットアップ完了。installTrigger() を実行すると定期実行が始まります。');
  }
  log_('Gmail 側で、応募書類が届くメールに "' + cfg('LABEL_INBOX') + '" ラベルを付けるフィルタを作成してください。');
}

function findOrCreateRootFolder_() {
  var it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
}

/**
 * 定期実行を登録する。実行時刻は TRIGGER_TIMES（例: "8:30,17:00"）で決まる。
 * Apps Script には「メール受信時に実行」というトリガーが無いため、時刻ベースで回す。
 */
function installTrigger() {
  var resolved = parseTriggerTimes(cfg('TRIGGER_TIMES'));
  if (resolved.warning) log_(resolved.warning);

  // プロジェクトのタイムゾーンが意図と違っていても正しい時刻に回るよう、明示的に指定する。
  var tz = timezone_();
  removeTriggers();
  var labels = [];
  for (var i = 0; i < resolved.times.length; i++) {
    var time = resolved.times[i];
    ScriptApp.newTrigger('run')
      .timeBased()
      .everyDays(1)
      .atHour(time.hour)
      .nearMinute(time.minute)
      .inTimezone(tz)
      .create();
    labels.push(formatTriggerTime(time));
  }

  log_('毎日 ' + labels.join(' と ') + ' に実行するよう登録しました（' + tz + '）。');
  log_('※ Apps Script は分単位の実行を保証しないため、指定時刻の前後15分ほどずれます。');
  log_('時刻を変えたい場合は TRIGGER_TIMES を "8:30,17:00" の形式で設定し、installTrigger() を再実行してください。');

  var projectTz = Session.getScriptTimeZone();
  if (projectTz !== tz) {
    log_('（補足）Apps Script プロジェクトのタイムゾーンは ' + projectTz + ' ですが、' +
      'トリガーと日付の計算は ' + tz + ' で行います。' +
      '実行ログの時刻表示だけはプロジェクト設定に従うため、揃えたい場合は ' +
      'プロジェクトの設定 → タイムゾーン を変更してください。');
  }
}

function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'run') ScriptApp.deleteTrigger(triggers[i]);
  }
  log_('既存の定期実行を削除しました。');
}

/**
 * Slack の Webhook が正しく設定されているか確認する。
 * 設定したチャンネルにテスト投稿が1件流れる。
 */
function testSlack() {
  if (!cfg('SLACK_WEBHOOK_URL')) {
    log_('SLACK_WEBHOOK_URL が未設定です。スクリプト プロパティに Webhook URL を登録してください。');
    return;
  }
  postToSlack_([
    {
      type: 'header',
      text: { type: 'plain_text', text: '接続テスト', emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '応募書類の自動判定から送信しています。これが見えていれば設定は完了です。' }
    }
  ], '応募書類 自動判定：接続テスト');
  log_('Slack にテスト投稿を送信しました。チャンネルを確認してください。');
}

/**
 * 設定の確認用。API キーは値を表示せず、設定済みかどうかだけを出す。
 */
function showConfig() {
  var keys = Object.keys(CONFIG_DEFAULTS).concat(REQUIRED_CONFIG_KEYS, ['NOTIFY_EMAIL']);
  var seen = {};
  keys.forEach(function (key) {
    if (seen[key]) return;
    seen[key] = true;
    var value = cfg(key);
    if (key === 'ANTHROPIC_API_KEY' || key === 'SLACK_WEBHOOK_URL') {
      value = value ? '(設定済み)' : '(未設定)';
    }
    log_(key + ' = ' + value);
  });
}
