/**
 * 追加の判定条件。
 * 判定台帳スプレッドシートの「判定ルール」シートに1行ずつ書くと、次の実行から反映される。
 * コードを触らずに条件を増やせるようにするのが目的。
 *
 * 列: 有効 / 分類 / 内容 / メモ
 *   分類は次の3つ。
 *     不合格条件 … 当てはまったら不合格にする
 *     懸念条件　 … 当てはまったら懸念点として通知し、合格なら要確認に落とす
 *     補足　　　 … 判定の参考情報としてAIに渡すだけ（判定は変えない）
 */

var CUSTOM_RULES_SHEET_NAME = '判定ルール';
var CUSTOM_RULES_HEADERS = ['有効', '分類', '内容', 'メモ'];

var CUSTOM_RULES_EXAMPLES = [
  [false, '不合格条件', '例）日本語での指導が難しいと書類から判断できる', '不要なら行ごと削除してください'],
  [false, '懸念条件', '例）直近3年以内に離職期間が1年以上ある', ''],
  [false, '補足', '例）資格の有無より実務での使用年数を重視して判断する', '']
];

/** 「判定ルール」シートを取得する。無ければ見出しと記入例つきで作る。 */
function customRulesSheet_() {
  var ss = SpreadsheetApp.openById(requireCfg('LEDGER_SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(CUSTOM_RULES_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(CUSTOM_RULES_SHEET_NAME);
  sheet.appendRow(CUSTOM_RULES_HEADERS);
  sheet.setFrozenRows(1);
  for (var i = 0; i < CUSTOM_RULES_EXAMPLES.length; i++) {
    sheet.appendRow(CUSTOM_RULES_EXAMPLES[i]);
  }
  sheet.getRange(2, 1, CUSTOM_RULES_EXAMPLES.length, 1).insertCheckboxes();
  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 480);
  sheet.setColumnWidth(4, 240);
  return sheet;
}

/**
 * シートから有効な追加条件を読み込む。
 * シートが無い・読めない場合は空配列を返す（追加条件が無いだけで判定は動く）。
 */
function loadCustomRules() {
  var sheet;
  try {
    sheet = customRulesSheet_();
  } catch (e) {
    log_('判定ルールシートを読めませんでした（追加条件なしで判定します）: ' + e.message);
    return [];
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, CUSTOM_RULES_HEADERS.length).getValues();
  var parsed = parseCustomRules(values);
  if (parsed.warnings.length) {
    log_('判定ルールシートの注意: ' + parsed.warnings.join(' / '));
  }
  return parsed.rules;
}
