/**
 * 初期セットアップ。Apps Script のエディタから setup() を1回実行する。
 * 既にフォルダ・台帳がある場合は作り直さない。
 */

var ROOT_FOLDER_NAME = '候補者書類（自動判定）';
var LEDGER_FILE_NAME = '候補者判定台帳';

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

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(15).create();
  log_('15分ごとの定期実行を登録しました。');
}

function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'run') ScriptApp.deleteTrigger(triggers[i]);
  }
  log_('既存の定期実行を削除しました。');
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
