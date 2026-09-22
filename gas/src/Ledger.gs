/**
 * 判定台帳（スプレッドシート）。処理済みの重複判定にも使う。
 */

var LEDGER_SHEET_NAME = '判定台帳';
var LEDGER_HEADERS = [
  '処理日時', 'メッセージID', '候補者氏名', '年齢', '軸1_年齢', '軸2_求人適合',
  '軸3_実務経験', '想定求人', '総合判定', '懸念点', 'サマリ', 'Driveフォルダ',
  'メール件名', '差出人', 'モデル', '入力トークン', '出力トークン', '概算コスト（円）'
];

function ledgerSheet_() {
  var ss = SpreadsheetApp.openById(requireCfg('LEDGER_SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LEDGER_SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LEDGER_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 既に処理済みのメッセージIDの集合を返す。 */
function processedMessageIds() {
  var sheet = ledgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var set = {};
  for (var i = 0; i < values.length; i++) {
    if (values[i][0]) set[String(values[i][0])] = true;
  }
  return set;
}

function appendLedgerRow(entry) {
  var a = entry.assessment;
  var cost = estimateCost(entry.model, entry.usage, cfgInt('USD_JPY'));
  ledgerSheet_().appendRow([
    Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HH:mm:ss'),
    entry.messageId,
    a.candidate.name || a.candidate.subjectName || '(不明)',
    a.axes.age.age === null ? '不明' : a.axes.age.age,
    ratingSymbol(a.axes.age.rating),
    ratingSymbol(a.axes.jobMatch.rating),
    ratingSymbol(a.axes.experience.rating),
    a.jobName,
    a.verdictLabel,
    a.concerns.join(' / '),
    a.summary,
    entry.folderUrl,
    entry.subject,
    entry.from,
    entry.model || '',
    entry.usage && entry.usage.input_tokens ? entry.usage.input_tokens : '',
    entry.usage && entry.usage.output_tokens ? entry.usage.output_tokens : '',
    cost ? Math.round(cost.jpy * 100) / 100 : ''
  ]);
}

/** 判定まで到達できなかったメールも記録する。 */
function appendErrorRow(entry) {
  ledgerSheet_().appendRow([
    Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HH:mm:ss'),
    entry.messageId,
    entry.candidateName || '(不明)',
    '', '', '', '', '',
    '判定不可',
    entry.error,
    '', entry.folderUrl || '',
    entry.subject, entry.from, '', '', '', ''
  ]);
}
