/**
 * 候補者ごとの書類を Google ドライブに保存する。
 * 保存先: <ルートフォルダ>/<候補者氏名>/
 *
 * 同姓同名や再応募の場合は同じフォルダに追加されるので、
 * 混在が問題になるようなら日付の階層を挟む形に変更する。
 */

function saveCandidateFiles(candidateName, attachments, receivedAt) {
  var root = DriveApp.getFolderById(requireCfg('DRIVE_ROOT_FOLDER_ID'));
  var folder = getOrCreateChildFolder_(root, sanitizeName(candidateName));

  var saved = [];
  for (var i = 0; i < attachments.length; i++) {
    var blob = attachments[i].blob;
    // ZIP 内のファイルは "書類/履歴書.pdf" のようにパスを含むことがあるので整える
    blob.setName(sanitizeFileName_(blob.getName() || attachments[i].name));
    var file = folder.createFile(blob);
    saved.push(file.getName());
  }
  return { folder: folder, url: folder.getUrl(), savedFileNames: saved };
}

/**
 * 評価結果を JSON としてフォルダ内に残す（後から監査できるように）。
 * 再応募で同じフォルダに複数入っても区別できるよう、ファイル名に判定日時を入れる。
 */
function saveAssessmentJson(folder, payload, evaluatedAt) {
  var stamp = Utilities.formatDate(evaluatedAt || new Date(), timezone_(), 'yyyyMMdd-HHmm');
  var blob = Utilities.newBlob(
    JSON.stringify(payload, null, 2),
    'application/json',
    '_評価結果_' + stamp + '.json'
  );
  folder.createFile(blob);
}

function sanitizeFileName_(name) {
  var base = String(name || 'attachment').split('/').pop().split('\\').pop().trim();
  return base || 'attachment';
}

function getOrCreateChildFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * 日時の基準タイムゾーン。
 * Apps Script プロジェクトの設定に依存すると、作成時の既定（America/New_York など）の
 * ままになっていた場合に日付がずれる。設定値を優先し、最後の保険として東京にする。
 */
function timezone_() {
  return cfg('TIMEZONE') || Session.getScriptTimeZone() || 'Asia/Tokyo';
}
