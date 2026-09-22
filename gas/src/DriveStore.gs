/**
 * 候補者ごとの書類を Google ドライブに保存する。
 * 保存先: <ルートフォルダ>/<YYYY-MM>/<氏名>_<yyyyMMdd-HHmm>/
 */

function saveCandidateFiles(candidateName, attachments, receivedAt) {
  var root = DriveApp.getFolderById(requireCfg('DRIVE_ROOT_FOLDER_ID'));
  var monthFolder = getOrCreateChildFolder_(root, Utilities.formatDate(receivedAt, timezone_(), 'yyyy-MM'));
  var folderName = sanitizeName(candidateName) + '_' + Utilities.formatDate(receivedAt, timezone_(), 'yyyyMMdd-HHmm');
  var folder = getOrCreateChildFolder_(monthFolder, folderName);

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

/** 評価結果を JSON としてフォルダ内に残す（後から監査できるように）。 */
function saveAssessmentJson(folder, payload) {
  var blob = Utilities.newBlob(
    JSON.stringify(payload, null, 2),
    'application/json',
    '_評価結果.json'
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

function timezone_() {
  return Session.getScriptTimeZone() || 'Asia/Tokyo';
}
