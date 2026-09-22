/**
 * メール添付ファイルの取り出しと、Claude に渡せる形（PDF / 画像）への変換。
 *
 * - PDF と画像はそのまま送る
 * - Word / Excel は Google ドキュメント・スプレッドシートに変換してから PDF にして送る
 * - ZIP は1階層だけ展開する
 * - 署名画像などの小さなファイルは除外する
 */

var SUPPORTED_IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp'
};

var OFFICE_CONVERSIONS = {
  doc: MimeType.GOOGLE_DOCS, docx: MimeType.GOOGLE_DOCS, rtf: MimeType.GOOGLE_DOCS,
  odt: MimeType.GOOGLE_DOCS, txt: MimeType.GOOGLE_DOCS,
  xls: MimeType.GOOGLE_SHEETS, xlsx: MimeType.GOOGLE_SHEETS,
  csv: MimeType.GOOGLE_SHEETS, ods: MimeType.GOOGLE_SHEETS
};

var MIN_IMAGE_BYTES = 30 * 1024;  // これ未満の画像は署名・ロゴとみなして無視する

/** 添付ファイルを取り出す（ZIP は展開する）。 */
function collectAttachments(message) {
  var maxBytes = cfgInt('MAX_ATTACHMENT_MB') * 1024 * 1024;
  var collected = [];
  var attachments = message.getAttachments({ includeInlineImages: true, includeAttachments: true });

  for (var i = 0; i < attachments.length; i++) {
    var blob = attachments[i].copyBlob();
    var name = attachments[i].getName();
    blob.setName(name);

    if (extensionOf_(name) === 'zip') {
      var entries = [];
      try {
        entries = Utilities.unzip(blob);
      } catch (e) {
        log_('ZIP を展開できませんでした: ' + name + ' / ' + e.message);
      }
      for (var j = 0; j < entries.length; j++) {
        pushIfUsable_(collected, entries[j], maxBytes);
      }
      continue;
    }

    pushIfUsable_(collected, blob, maxBytes);
  }
  return collected;
}

function pushIfUsable_(collected, blob, maxBytes) {
  var name = blob.getName() || 'attachment';
  var ext = extensionOf_(name);
  var size = blob.getBytes().length;

  if (name.indexOf('__MACOSX') === 0 || name.indexOf('/.') >= 0) return;
  if (size === 0) return;
  if (size > maxBytes) {
    log_('サイズ超過のため除外: ' + name + ' (' + Math.round(size / 1024 / 1024) + 'MB)');
    return;
  }
  if (SUPPORTED_IMAGE_TYPES[ext] && size < MIN_IMAGE_BYTES) return;  // 署名画像など
  if (ext !== 'pdf' && !SUPPORTED_IMAGE_TYPES[ext] && !OFFICE_CONVERSIONS[ext]) {
    log_('対応していない形式のため除外: ' + name);
    return;
  }
  collected.push({ name: name, ext: ext, blob: blob, size: size });
}

/**
 * 添付ファイルを Claude のコンテンツブロックに変換する。
 * 変換に失敗したファイルは skipped に入れて通知に載せる。
 * @return {{blocks: Array, skipped: Array}}
 */
function buildContentBlocks(attachments, mailMeta) {
  var blocks = [];
  var skipped = [];
  var budget = cfgInt('MAX_TOTAL_UPLOAD_MB') * 1024 * 1024;
  var used = 0;

  for (var i = 0; i < attachments.length; i++) {
    var item = attachments[i];
    var prepared;
    try {
      prepared = toClaudeSource_(item);
    } catch (e) {
      skipped.push(item.name + '（変換に失敗: ' + e.message + '）');
      continue;
    }
    if (!prepared) {
      skipped.push(item.name + '（対応していない形式）');
      continue;
    }

    var bytes = prepared.bytes;
    if (used + bytes.length > budget) {
      skipped.push(item.name + '（合計サイズ上限を超えるため未送信）');
      continue;
    }
    used += bytes.length;

    blocks.push({ type: 'text', text: '【添付ファイル】' + item.name });
    if (prepared.kind === 'document') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Utilities.base64Encode(bytes)
        }
      });
    } else {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: prepared.mediaType,
          data: Utilities.base64Encode(bytes)
        }
      });
    }
  }

  blocks.push({ type: 'text', text: buildUserInstruction(mailMeta) });
  return { blocks: blocks, skipped: skipped };
}

/** 1ファイルを PDF か画像のバイト列にする。 */
function toClaudeSource_(item) {
  if (item.ext === 'pdf') {
    return { kind: 'document', bytes: item.blob.getBytes() };
  }
  if (SUPPORTED_IMAGE_TYPES[item.ext]) {
    return { kind: 'image', mediaType: SUPPORTED_IMAGE_TYPES[item.ext], bytes: item.blob.getBytes() };
  }
  if (OFFICE_CONVERSIONS[item.ext]) {
    return { kind: 'document', bytes: officeToPdfBytes_(item).getBytes() };
  }
  return null;
}

/**
 * Word / Excel を Google 形式に変換し、PDF として書き出す。
 * 変換用の一時ファイルは必ず削除する。
 */
function officeToPdfBytes_(item) {
  var tempId = null;
  try {
    var created = Drive.Files.create(
      { name: 'tmp-' + item.name, mimeType: OFFICE_CONVERSIONS[item.ext] },
      item.blob
    );
    tempId = created.id;
    return DriveApp.getFileById(tempId).getAs('application/pdf').getBytes();
  } finally {
    if (tempId) {
      try {
        Drive.Files.remove(tempId);
      } catch (e) {
        log_('一時ファイルの削除に失敗: ' + tempId + ' / ' + e.message);
      }
    }
  }
}

function extensionOf_(name) {
  var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
